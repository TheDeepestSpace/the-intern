// Single entry point the dispatcher/telegram-session "Run agent" steps call
// after the agent process exits, replacing the old inline is_error check.
// On success it clears (and pings) any queued usage-limit retry for this
// key; on failure it detects a usage-limit stall and queues a retry instead
// of (or in addition to, once exhausted) the generic failure notification.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectUsageLimit } = require('./detect-usage-limit');
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
    readResultText: readResultTextFn = readResultText,
    saveCodexLog: saveCodexLogFn = saveCodexLog,
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
      // session into a failed workflow step.
      console.error(`::error::Could not clear the queued usage-limit retry: ${err.message}`);
      return;
    }
    if (removed) {
      console.log(`Resolved queued retry for ${retryKey} (had used ${removed.retryCount}/${removed.maxRetries} retries).`);
      sendTelegramFn(
        adminChatId,
        `✅ the-intern-bot resumed ${label} after a Claude usage-limit stall (${removed.retryCount} retr${removed.retryCount === 1 ? 'y' : 'ies'} used).`
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
        logFile: env.CODEX_EVENTS_FILE,
      });
    } catch (err) {
      console.error(`::error::Unexpected error saving codex log: ${err.message}`);
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

module.exports = { readResultText, main };
