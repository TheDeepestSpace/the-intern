// Claude Code Stop hook: a hard backstop against a session ending its turn
// while claiming it's "waiting" on backgrounded work, even though the
// dispatcher's `claude -p` run is single-shot and no later turn exists to
// check back in. See instructions/shared-style.md for the prompt-level nudge
// this backs up, and https://docs.claude.com/en/docs/claude-code/hooks.
//
// Reads the Stop hook's JSON payload from stdin and, if the turn's final
// message reads as "waiting/backgrounding" AND no commit landed in this
// session (checked via git, not the transcript), blocks the stop so Claude
// keeps going instead of exiting cleanly with nothing to show.
const fs = require('fs');
const { execFileSync } = require('child_process');

const BASELINE_SHA_FILE = '/tmp/stop_hook_baseline_sha.txt';

const SUSPICIOUS_PATTERNS = [
  /waiting (on|for)/i,
  /will check back/i,
  /check back (later|shortly|soon)/i,
  /running in the background/i,
  /background(ed)? (job|task|process|run)/i,
  /backgrounding/i,
  /still (running|in progress)/i,
  /\bin progress\b/i,
  /once (it|this|that) (finishes|completes|is done)/i,
  /keep(ing)? (an eye on|monitoring)/i,
  /i('ll| will) (monitor|follow up|check (in|back))/i,
];

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (err) {
    return '';
  }
}

// last_assistant_message is the documented Stop-hook field, but fall back to
// scanning the transcript in case an older/newer CLI build omits it.
function getLastAssistantMessage(input) {
  if (typeof input.last_assistant_message === 'string' && input.last_assistant_message) {
    return input.last_assistant_message;
  }
  if (!input.transcript_path) return '';

  try {
    const lines = fs.readFileSync(input.transcript_path, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch (err) {
        continue;
      }
      const content = entry && entry.type === 'assistant' && entry.message && entry.message.content;
      if (Array.isArray(content)) {
        return content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n');
      }
    }
  } catch (err) {
    return '';
  }
  return '';
}

// "Work landed" is approximated as "a commit exists now that didn't exist at
// session start, on any local ref" — this covers a commit on the checked-out
// branch, a commit on a freshly created branch, and a branch that was pushed
// (which updates the local remote-tracking ref) for a PR, without needing a
// GitHub API round-trip from inside the hook.
function hasLandedWork(cwd) {
  let baseline = '';
  try {
    baseline = fs.readFileSync(BASELINE_SHA_FILE, 'utf8').trim();
  } catch (err) {
    return true; // no baseline recorded; fail open rather than block blindly
  }
  if (!baseline) return true;

  try {
    const newCommitCount = execFileSync(
      'git',
      ['rev-list', '--count', '--all', '--not', baseline],
      { cwd, encoding: 'utf8' }
    ).trim();
    return Number(newCommitCount) > 0;
  } catch (err) {
    return true; // can't inspect git state reliably; fail open
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch (err) {
    process.exit(0); // malformed input; don't block on a hook bug
  }

  // Set when this Stop is already the result of a previous block from this
  // same hook — allow the stop unconditionally so we can't loop forever.
  if (input.stop_hook_active) {
    process.exit(0);
  }

  const message = getLastAssistantMessage(input);
  const isSuspicious = SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(message));
  if (!isSuspicious) {
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  if (hasLandedWork(cwd)) {
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason:
      'This turn reads like it is ending while waiting on background/in-progress work, but no commit, branch, ' +
      'or PR has landed yet in this session. This is a single-shot session: there is no later turn to check back ' +
      'in, and any backgrounded job will be silently orphaned when the container tears down. Finish the work ' +
      'synchronously now (foreground any long-running command, waiting for it to actually complete) and land a ' +
      'commit/branch/PR, or explicitly report that the request could not be completed instead of ending as if a ' +
      'follow-up will happen.',
  }));
  process.exit(0);
}

main();
