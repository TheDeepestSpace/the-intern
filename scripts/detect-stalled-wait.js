// Detects a session that ended its own final message on a "waiting for X" /
// "will check back" / "will resume" note (issue #173). Dispatcher and
// telegram-session runs are one-shot: nothing ever re-enters a session to
// check on the thing it said it was waiting for, so a comment like that is
// false reassurance, not progress. This is a backstop, not a hard block —
// the system prompt (instructions/shared-style.md) is the primary defense;
// this just flags a session that ignored it so a human can pick up the
// stranded work.
const STALLED_WAIT_PATTERNS = [
  /\bwaiting (?:on|for)\b/i,
  /\bwill check back\b/i,
  /\bwill (?:resume|continue) (?:this |the |my )?(?:session|work|later|shortly|soon|once|after)\b/i,
  /\bwill follow up (?:once|after|when)\b/i,
  /\bonce (?:it|this|that|the \w+(?:\s\w+){0,2}) (?:finishes|completes|is done|is ready|generat\w+)\b/i,
  /\bcheck(?:ing)? back (?:once|after|when|later)\b/i,
];

function detectStalledWait(text) {
  if (!text) return null;
  for (const pattern of STALLED_WAIT_PATTERNS) {
    const match = text.match(pattern);
    if (match) return { matchedText: match[0] };
  }
  return null;
}

module.exports = { detectStalledWait, STALLED_WAIT_PATTERNS };
