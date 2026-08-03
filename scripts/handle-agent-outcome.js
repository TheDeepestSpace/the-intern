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
      env: { ...process.env, CHAT_ID: chatId },
    });
  } catch (err) {
    console.error(`Failed to send Telegram message: ${err.message}`);
  }
}

function main() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const retryKey = process.env.RETRY_KEY;
  const retrySource = process.env.RETRY_SOURCE || 'dispatcher';
  const targetRepo = process.env.TARGET_REPO || '';
  const issueNumber = process.env.ISSUE_NUMBER || '';
  const retryChatId = process.env.RETRY_CHAT_ID || '';
  const adminChatId = process.env.TG_ADMIN_CHAT_ID || '';
  const maxRetries = Number(process.env.MAX_RETRIES || 3);
  const runUrl = process.env.RUN_URL || '';

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

  const { isError, text } = readResultText(process.env.RESULT_FILE);

  // Pending-retries.json lives on a branch of this repo (agent-infra), not
  // whatever arbitrary repo TARGET_REPO points at — git ops below must run
  // against the outer checkout regardless of the caller step's own
  // working-directory.
  process.chdir(workspace);

  if (!isError) {
    console.log('Agent session completed.');
    const { removed } = updateEntries((entries) => resolveEntry(entries, retryKey));
    if (removed) {
      console.log(`Resolved queued retry for ${retryKey} (had used ${removed.retryCount}/${removed.maxRetries} retries).`);
      sendTelegram(
        adminChatId,
        `✅ the-intern-bot resumed ${label} after a Claude usage-limit stall (${removed.retryCount} retr${removed.retryCount === 1 ? 'y' : 'ies'} used).`
      );
    }
    return;
  }

  console.log('::warning::Agent produced no usable output or reported an error');

  const stall = detectUsageLimit(text);
  const dispatch = stall
    ? buildDispatchPayload({
        eventName: process.env.GITHUB_EVENT_NAME,
        eventPath: process.env.GITHUB_EVENT_PATH,
        workflowFile: process.env.WORKFLOW_FILE,
        ref: process.env.DISPATCH_REF,
      })
    : null;

  if (stall && !dispatch) {
    console.error('::error::Detected a usage-limit stall but could not build a re-dispatch payload; falling back to the generic failure notification.');
  }

  if (stall && dispatch) {
    const { entry, exhausted } = updateEntries((entries) =>
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

    if (exhausted) {
      console.log(`Retry budget exhausted for ${retryKey}.`);
      sendTelegram(
        adminChatId,
        `🛑 the-intern-bot: ${label} hit a Claude usage limit and used up all ${entry.retryCount}/${entry.maxRetries} auto-retries without resuming. Manual re-trigger needed. Run: ${runUrl}`
      );
    } else {
      console.log(`Queued retry for ${retryKey} (attempt ${entry.retryCount + 1}/${entry.maxRetries}, retry after ${entry.retryAfter}).`);
      sendTelegram(
        adminChatId,
        `⏸️ the-intern-bot: ${label} hit a Claude usage limit ("${stall.matchedText}") — queued to auto-resume after ${entry.retryAfter} (retry ${entry.retryCount + 1}/${entry.maxRetries}). Run: ${runUrl}`
      );
    }
    return;
  }

  // Not a usage-limit stall — the original generic failure notification.
  sendTelegram(adminChatId, `⚠️ the-intern-bot ran into an error and could not complete a request on ${label}. Run: ${runUrl}`);
}

if (require.main === module) {
  main();
}

module.exports = { readResultText };
