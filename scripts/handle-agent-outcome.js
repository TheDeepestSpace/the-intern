// Single entry point the dispatcher/telegram-session "Run agent" steps call
// after the agent process exits, replacing the old inline is_error check.
// On success it clears (and pings) any queued usage-limit retry for this
// key; on failure it detects a usage-limit stall and queues a retry instead
// of (or in addition to, once exhausted) the generic failure notification.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectUsageLimit } = require('./detect-usage-limit');
const { detectStalledWait } = require('./detect-stalled-wait');
const { updateEntries, buildDispatchPayload } = require('./manage-pending-retries');
const { upsertStall, resolveEntry } = require('./pending-retries-store');
const { saveCodexLog } = require('./manage-codex-log');

// Mirrors extract-result.js's own extraction (data.result ?? data.output ?? data)
// so detection sees the same text a human would in session_result.txt.
function readResultText(resultFile) {
  if (!resultFile || !fs.existsSync(resultFile)) return { isError: true, text: '' };
  let raw;
  try {
    raw = fs.readFileSync(resultFile, 'utf8');
  } catch {
    return { isError: true, text: '' };
  }
  if (!raw.trim()) return { isError: true, text: '' };
  try {
    const data = JSON.parse(raw);
    const value = data.result ?? data.output ?? data;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return { isError: !!data.is_error, text };
  } catch {
    return { isError: true, text: raw };
  }
}

function sendTelegram(chatId, text) {
  if (!chatId) return;
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'send-telegram.js'), text], {
      stdio: 'inherit',
      timeout: 30_000,
      env: { ...process.env, CHAT_ID: chatId },
    });
  } catch (err) {
    console.error(`Failed to send Telegram message: ${err.message}`);
  }
}

// Login the-intern-bot's GitHub App comments (and this fallback's own posts)
// show up under — every comment counted here or posted below goes through the
// same installation token, so this is the identity to filter on.
const BOT_LOGIN = 'the-intern-bot[bot]';

// Count of the bot's own comments on the issue/PR right now, via the same
// REST endpoint GitHub uses for both (issues and PRs share the
// /issues/{n}/comments collection). --paginate walks every page so a thread
// with >30 comments (the default page size) still counts accurately. Scoped
// to BOT_LOGIN (not every comment on the thread) so a human or another
// integration commenting mid-session can't be mistaken for the agent having
// posted its own answer.
function countIssueComments(targetRepo, issueNumber) {
  const out = execFileSync(
    'gh',
    [
      'api',
      `repos/${targetRepo}/issues/${issueNumber}/comments`,
      '--paginate',
      '--jq',
      `.[] | select(.user.login == "${BOT_LOGIN}") | .id`,
    ],
    { encoding: 'utf8', timeout: 30_000 }
  );
  return out.split('\n').filter(Boolean).length;
}

// Posts via `gh api` (not `gh issue comment`/`gh pr comment`) since the same
// REST call works whether issueNumber is an issue or a PR — no need to know
// which one it is. Passed as a single execFileSync argv entry, not through a
// shell, so arbitrarily-shaped body text can't break out of the command.
function postIssueComment(targetRepo, issueNumber, body) {
  execFileSync('gh', ['api', `repos/${targetRepo}/issues/${issueNumber}/comments`, '-f', `body=${body}`], {
    stdio: 'inherit',
    timeout: 30_000,
  });
}

function resolveMaxRetries(rawValue) {
  const parsed = Number(rawValue || 3);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  console.warn(`::warning::Ignoring invalid MAX_RETRIES="${rawValue}"; using 3.`);
  return 3;
}

// Orchestration entry point. `deps` lets tests inject fakes for the
// git-backed/network pieces (updateEntries, sendTelegram, buildDispatchPayload,
// detectUsageLimit, readResultText) while exercising the real branch logic.
async function main(env = process.env, deps = {}) {
  const {
    updateEntries: updateEntriesFn = updateEntries,
    sendTelegram: sendTelegramFn = sendTelegram,
    buildDispatchPayload: buildDispatchPayloadFn = buildDispatchPayload,
    detectUsageLimit: detectUsageLimitFn = detectUsageLimit,
    detectStalledWait: detectStalledWaitFn = detectStalledWait,
    readResultText: readResultTextFn = readResultText,
    saveCodexLog: saveCodexLogFn = saveCodexLog,
    countIssueComments: countIssueCommentsFn = countIssueComments,
    postIssueComment: postIssueCommentFn = postIssueComment,
  } = deps;

  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const retryKey = env.RETRY_KEY;
  const retrySource = env.RETRY_SOURCE || 'dispatcher';
  const targetRepo = env.TARGET_REPO || '';
  const issueNumber = env.ISSUE_NUMBER || '';
  const retryChatId = env.RETRY_CHAT_ID || '';
  const adminChatId = env.TG_ADMIN_CHAT_ID || '';
  const maxRetries = resolveMaxRetries(env.MAX_RETRIES);
  const runUrl = env.RUN_URL || '';
  // Number('') is 0, not NaN — guard explicitly so a skipped/failed baseline-capture
  // step (empty string) reads as "unknown" rather than a false "0 comments before".
  const commentCountBefore = env.COMMENT_COUNT_BEFORE ? Number(env.COMMENT_COUNT_BEFORE) : NaN;

  if (!retryKey) {
    console.error('handle-agent-outcome: RETRY_KEY is required');
    process.exitCode = 1;
    return;
  }

  const label = targetRepo
    ? `${targetRepo}${issueNumber ? `#${issueNumber}` : ''}`
    : retryChatId
      ? `telegram chat ${retryChatId}`
      : retryKey;

  const { isError, text } = readResultTextFn(env.RESULT_FILE);

  // Pending-retries.json lives on a branch of this repo (agent-infra), not
  // whatever arbitrary repo TARGET_REPO points at — git ops below must run
  // against the outer checkout regardless of the caller step's own
  // working-directory.
  process.chdir(workspace);

  if (!isError) {
    console.log('Agent session completed.');
    let removed = null;
    try {
      ({ removed } = await updateEntriesFn((entries) => resolveEntry(entries, retryKey)));
    } catch (err) {
      // A pending-retries git failure here must not turn a successful agent
      // session into a failed workflow step, and must not skip the
      // silent-success fallback check below.
      console.error(`::error::Could not clear the queued usage-limit retry: ${err.message}`);
    }
    if (removed) {
      console.log(`Resolved queued retry for ${retryKey} (had used ${removed.retryCount}/${removed.maxRetries} retries).`);
      sendTelegramFn(
        adminChatId,
        `✅ the-intern-bot resumed ${label} after a Claude usage-limit stall (${removed.retryCount} retr${removed.retryCount === 1 ? 'y' : 'ies'} used).`
      );
    }

    // Backstop for a session that reports success with a real answer but never
    // actually called `gh` to post it (issue #170) — only meaningful when this
    // run had an issue/PR to post to and a pre-session comment count to diff
    // against; skipped otherwise (e.g. telegram-session.yml calls, which don't
    // set TARGET_REPO/ISSUE_NUMBER here).
    if (targetRepo && issueNumber && text.trim() && Number.isFinite(commentCountBefore)) {
      let commentCountAfter = null;
      try {
        commentCountAfter = await countIssueCommentsFn(targetRepo, issueNumber);
      } catch (err) {
        console.error(`::warning::Could not check whether ${label} received a comment this session: ${err.message}`);
      }
      if (commentCountAfter !== null && commentCountAfter <= commentCountBefore) {
        console.log(`No new comment on ${label} after a successful session; posting the session's final answer as a fallback comment.`);
        try {
          await postIssueCommentFn(targetRepo, issueNumber, text);
        } catch (err) {
          console.error(`::warning::Fallback comment post to ${label} failed: ${err.message}`);
        }
      }
    }

    // Backstop for issue #173: a session can end cleanly on its own "waiting
    // on X to finish" / "will check back" message — not an error, just false
    // reassurance, since nothing ever re-enters a one-shot session to check
    // on X. Flag it to the maintainer so the stranded work gets picked up
    // manually; this doesn't block or alter anything the session already did.
    const stalledWait = detectStalledWaitFn(text);
    if (stalledWait) {
      console.log(`::warning::Session on ${label} ended on a "waiting for X" style message ("${stalledWait.matchedText}") that nothing will resume automatically.`);
      sendTelegramFn(
        adminChatId,
        `⚠️ the-intern-bot: ${label} ended its turn on a "waiting" message ("${stalledWait.matchedText}") but this was a one-shot session — nothing will check back on its own. Manual follow-up needed. Run: ${runUrl}`
      );
    }

    return;
  }

  console.log('::warning::Agent produced no usable output or reported an error');

  // codex has no equivalent of claude's --output-format json diagnostics; the
  // raw JSONL event stream captured to /tmp/codex-events.jsonl is the only
  // place a genuine codex crash shows up (issue #93/#134). Push it to
  // the-intern-data (private) before the container tears down, regardless of
  // whether this turns out to be a usage-limit stall or a generic failure —
  // never send any of it to Telegram or a shared-visibility artifact.
  if (env.BACKEND === 'codex') {
    try {
      await saveCodexLogFn({
        targetRepo,
        issueNumber,
        runId: env.GITHUB_RUN_ID,
        logFile: env.CODEX_EVENTS_FILE || undefined,
      });
    } catch (err) {
      console.error(`::warning::Unexpected error saving codex log: ${err.message}`);
    }
  }

  const stall = detectUsageLimitFn(text);
  const dispatch = stall
    ? buildDispatchPayloadFn({
        eventName: env.GITHUB_EVENT_NAME,
        eventPath: env.GITHUB_EVENT_PATH,
        workflowFile: env.WORKFLOW_FILE,
        ref: env.DISPATCH_REF,
      })
    : null;

  if (stall && !dispatch) {
    console.error('::error::Detected a usage-limit stall but could not build a re-dispatch payload; falling back to the generic failure notification.');
  }

  if (stall && dispatch) {
    let queued;
    try {
      queued = await updateEntriesFn((entries) =>
        upsertStall(entries, {
          key: retryKey,
          source: retrySource,
          targetRepo,
          issueNumber,
          chatId: retryChatId,
          matchedText: stall.matchedText,
          retryAfter: stall.retryAfter,
          maxRetries,
          dispatch,
        })
      );
    } catch (err) {
      // Never let a pending-retries git failure swallow the failure report.
      console.error(`::error::Could not queue the usage-limit retry: ${err.message}`);
      sendTelegramFn(
        adminChatId,
        `⚠️ the-intern-bot: ${label} hit a Claude usage limit, but queuing the auto-retry failed. Manual re-trigger needed. Run: ${runUrl}`
      );
      return;
    }

    const { entry, exhausted } = queued;
    if (exhausted) {
      console.log(`Retry budget exhausted for ${retryKey}.`);
      sendTelegramFn(
        adminChatId,
        `🛑 the-intern-bot: ${label} hit a Claude usage limit and used up all ${entry.retryCount}/${entry.maxRetries} auto-retries without resuming. Manual re-trigger needed. Run: ${runUrl}`
      );
    } else {
      console.log(`Queued retry for ${retryKey} (attempt ${entry.retryCount + 1}/${entry.maxRetries}, retry after ${entry.retryAfter}).`);
      sendTelegramFn(
        adminChatId,
        `⏸️ the-intern-bot: ${label} hit a Claude usage limit ("${stall.matchedText}") — queued to auto-resume after ${entry.retryAfter} (retry ${entry.retryCount + 1}/${entry.maxRetries}). Run: ${runUrl}`
      );
    }
    return;
  }

  // Not a usage-limit stall — the original generic failure notification.
  sendTelegramFn(adminChatId, `⚠️ the-intern-bot ran into an error and could not complete a request on ${label}. Run: ${runUrl}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { readResultText, countIssueComments, postIssueComment, main };
