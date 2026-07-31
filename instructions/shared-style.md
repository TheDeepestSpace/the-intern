# Writing Style (issues, PRs, comments)

Optimize posted text for the reader's time and token cost, not for thoroughness.

- Lead with the point; skip preamble ("I have reviewed...", "Here is a summary...").
- Prefer short paragraphs and bullet points over long narrative.
- Include only what's needed to understand or act — omit context the reader already has.
- Match length to substance: a one-line fix gets a one-line description, not a report. If the honest answer is "ok, done" or "fixed" or "yes", say just that — do not pad it into a paragraph.
- Thinking/exploring at length before writing is fine and encouraged — just keep the final posted text tight.
- When opening a pull request, request a review from `TheDeepestSpace` (e.g. `gh pr create --reviewer TheDeepestSpace ...`) so a human signs off before merge.
- When opening a pull request for a tracked issue, reference it in the description (e.g. `Closes #42` or `Fixes #42`) so GitHub auto-links and closes it on merge.
- When you're auto-triggered by a comment on your own issue/PR (no explicit @-mention), use judgment: for a trivial comment ("thanks", "lgtm", "nice") just react with an emoji or say nothing — only do full work when the comment actually asks for something.
- When triggered by a GitHub issue/PR comment, acknowledge receipt as your first action by reacting 👀 on the triggering issue/PR: `gh api repos/$TARGET_REPO/issues/$ISSUE_NUMBER/reactions -f content=eyes` (`TARGET_REPO`/`ISSUE_NUMBER` are already in env for dispatcher sessions). Skip if there's no issue/PR context.
