// Claude Code Stop hook: a hard backstop against a session ending its turn
// while claiming it's "waiting" on backgrounded work, even though the
// dispatcher's `claude -p` run is single-shot and no later turn exists to
// check back in. See instructions/shared-style.md for the prompt-level nudge
// this backs up, and https://docs.claude.com/en/docs/claude-code/hooks.
//
// Reads the Stop hook's JSON payload from stdin and blocks the stop when
// nothing has landed this session (no new commit/branch/PR) AND either the
// final message reads as "waiting/backgrounding" OR there are uncommitted
// changes to tracked files (a silent bail with innocuous phrasing looks the
// same as a stall from the git side). Untracked-only files are a weak signal
// on their own — surfaced in the block reason, but not a block trigger by
// themselves, since manage-workspace-backup.js already sweeps untracked
// files into the workspace backup and we don't want to train agents into
// `git add -A`-ing scratch files just to satisfy this check.
//
// The block is not one-shot: `stop_hook_active` (set on the Stop event that
// follows a previous block) used to be let through unconditionally, which
// meant a session nudged once but still genuinely stuck would sail through
// on the very next attempt. Instead this re-evaluates the same invariant
// each time and blocks up to MAX_BLOCKS times before giving up.
const fs = require('fs');
const { execFileSync } = require('child_process');

const BASELINE_REFS_FILE = '/tmp/stop_hook_baseline_refs.txt';
const SESSION_START_FILE = '/tmp/stop_hook_session_start.txt';
const BLOCK_COUNT_FILE = '/tmp/stop_hook_block_count.txt';
const MAX_BLOCKS = 3;

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
  /pause (here|now)\b/i,
  /resume automatically/i,
  /once the monitor/i,
  /the monitor (reports|will report|notifies)/i,
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
        const text = content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n');
        if (text.trim()) return text;
      }
    }
  } catch (err) {
    return '';
  }
  return '';
}

// Parses `git for-each-ref --format='%(objectname) %(refname)'` output into
// a Map(refname -> sha).
function parseRefs(text) {
  const map = new Map();
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const idx = line.indexOf(' ');
      if (idx === -1) return;
      map.set(line.slice(idx + 1), line.slice(0, idx));
    });
  return map;
}

// True if any ref present now points somewhere it didn't at baseline —
// either a new ref (freshly created/fetched branch) or an existing ref whose
// tip moved (a new commit, or a push updating the remote-tracking ref).
// Scoping to ref *tips that changed*, rather than "any commit reachable from
// any ref" (the previous `rev-list --all --not baseline` approach), avoids
// counting commits that were already sitting on some other, pre-existing
// branch as "landed work" from this session.
function refsChanged(baselineRefsText, currentRefsText) {
  const baseline = parseRefs(baselineRefsText);
  const current = parseRefs(currentRefsText);
  for (const [ref, sha] of current) {
    if (baseline.get(ref) !== sha) return true;
  }
  return false;
}

// "Landed commits" is approximated as "some ref's tip differs now from the
// session-start snapshot" — this covers a commit on the checked-out branch,
// a commit on a freshly created branch, and a branch that was pushed (which
// updates the local remote-tracking ref) for a PR, without needing a GitHub
// API round-trip from inside the hook.
function hasLandedCommits(cwd, baselineRefsText) {
  try {
    const currentRefsText = execFileSync(
      'git',
      ['for-each-ref', '--format=%(objectname) %(refname)'],
      { cwd, encoding: 'utf8' }
    );
    return refsChanged(baselineRefsText, currentRefsText);
  } catch (err) {
    return true; // can't inspect git state reliably; fail open
  }
}

// Keeps only PRs created at/after session start, so an already-open PR from
// a prior session on the same branch (the common case for a follow-up
// dispatcher run) doesn't make every subsequent session look like it landed
// work regardless of what actually happened.
function filterPRsCreatedAfter(prs, sessionStartIso) {
  if (!sessionStartIso) return prs; // no timestamp recorded; don't filter
  const sessionStartMs = Date.parse(sessionStartIso);
  if (Number.isNaN(sessionStartMs)) return prs;
  return prs.filter((pr) => Date.parse(pr.createdAt) >= sessionStartMs);
}

// Belt-and-suspenders alternate signal for the case where a PR got opened
// this session off commits that don't postdate the baseline ref snapshot
// (e.g. reusing an already-pushed branch) — a gray area worth allowing
// through rather than forcing a pointless extra commit.
function hasOpenPR(cwd, sessionStartIso) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    if (!branch || branch === 'HEAD') return false; // detached HEAD; nothing to look up
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,createdAt'],
      { cwd, encoding: 'utf8', timeout: 10000 }
    ).trim();
    const prs = out ? JSON.parse(out) : [];
    return filterPRsCreatedAfter(prs, sessionStartIso).length > 0;
  } catch (err) {
    return false; // gh unavailable/unauthenticated/no PR; don't treat as landed
  }
}

function hasLandedWork(cwd) {
  let baselineRefsText = '';
  try {
    baselineRefsText = fs.readFileSync(BASELINE_REFS_FILE, 'utf8');
  } catch (err) {
    return true; // no baseline recorded; fail open rather than block blindly
  }
  if (!baselineRefsText.trim()) return true;

  let sessionStartIso = '';
  try {
    sessionStartIso = fs.readFileSync(SESSION_START_FILE, 'utf8').trim();
  } catch (err) {
    // no session-start timestamp recorded; hasOpenPR falls back to unfiltered
  }

  return hasLandedCommits(cwd, baselineRefsText) || hasOpenPR(cwd, sessionStartIso);
}

function getGitStatusLines(cwd) {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    return []; // can't inspect; don't force a block on a hook/git bug
  }
}

function readBlockCount() {
  try {
    const n = Number(fs.readFileSync(BLOCK_COUNT_FILE, 'utf8').trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (err) {
    return 0;
  }
}

function writeBlockCount(n) {
  try {
    fs.writeFileSync(BLOCK_COUNT_FILE, String(n));
  } catch (err) {
    // best effort; a failure here just means the multi-shot cap doesn't stick
  }
}

function buildReason({ isSuspicious, hasTrackedChanges, hasUntracked }) {
  const parts = [];
  if (isSuspicious && hasTrackedChanges) {
    parts.push(
      'This turn reads like it is ending while waiting on background/in-progress work, and there are ' +
        'also uncommitted changes to tracked files.'
    );
  } else if (isSuspicious) {
    parts.push('This turn reads like it is ending while waiting on background/in-progress work.');
  } else {
    parts.push('This turn is ending with uncommitted changes to tracked files.');
  }

  parts.push(
    'No commit, branch, or PR has landed yet in this session. This is a single-shot session: there is no ' +
      'later turn to check back in, and any backgrounded job will be silently orphaned when the container ' +
      'tears down.'
  );

  if (hasUntracked) {
    parts.push(
      'Also noticed leftover untracked files in the working tree — decide explicitly whether to commit them ' +
        'by name or delete them, rather than sweeping them in with `git add -A`/`git add .` just to satisfy ' +
        'this check.'
    );
  }

  parts.push(
    'Finish the work synchronously now (foreground any long-running command, waiting for it to actually ' +
      'complete) and land a commit/branch/PR, or explicitly report that the request could not be completed ' +
      'instead of ending as if a follow-up will happen.'
  );

  return parts.join(' ');
}

// Pure decision function (no IO) so the multi-shot/invariant logic is
// directly unit-testable without shelling out to git/gh.
function decideStopAction({ message, statusLines, landedWork, blockCount }) {
  if (landedWork) {
    return { block: false, nextBlockCount: 0 };
  }

  const isSuspicious = SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(message));
  const hasTrackedChanges = statusLines.some((line) => !line.startsWith('??'));
  const hasUntracked = statusLines.some((line) => line.startsWith('??'));

  if (!isSuspicious && !hasTrackedChanges) {
    return { block: false, nextBlockCount: 0 };
  }

  if (blockCount >= MAX_BLOCKS) {
    // Already nudged this session MAX_BLOCKS times; stop forcing further
    // retries so a genuinely stuck session doesn't loop forever.
    return { block: false, nextBlockCount: 0 };
  }

  return {
    block: true,
    nextBlockCount: blockCount + 1,
    reason: buildReason({ isSuspicious, hasTrackedChanges, hasUntracked }),
  };
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch (err) {
    process.exit(0); // malformed input; don't block on a hook bug
  }

  const cwd = input.cwd || process.cwd();
  const message = getLastAssistantMessage(input);
  const statusLines = getGitStatusLines(cwd);
  const landedWork = hasLandedWork(cwd);
  const blockCount = readBlockCount();

  const decision = decideStopAction({ message, statusLines, landedWork, blockCount });

  writeBlockCount(decision.nextBlockCount);

  if (!decision.block) {
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }));
  process.exit(0);
}

module.exports = {
  SUSPICIOUS_PATTERNS,
  MAX_BLOCKS,
  getLastAssistantMessage,
  hasLandedWork,
  hasLandedCommits,
  hasOpenPR,
  parseRefs,
  refsChanged,
  filterPRsCreatedAfter,
  decideStopAction,
  buildReason,
};

if (require.main === module) {
  main();
}
