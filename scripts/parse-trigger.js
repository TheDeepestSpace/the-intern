const fs = require('fs');

// Extracts the *shape* of a dispatcher.yml trigger — which repo/issue it is
// about, who wrote it, the raw text — from the triggering GitHub Actions event
// (a repository_dispatch forwarded by the worker, or a workflow_dispatch).
// Which agent runs, and the `key=value` control-token grammar, are decided by
// agentic.yaml via scripts/resolve-agent.js, which is the only caller.
//
// For the system-synthesized dispatches (ci_failure, coderabbit_review,
// merge_conflict) the request text is built here: the worker never forwards
// third-party review bodies (tier-2 injection-safe), so the instruction is
// synthesized from structural fields only and `synthesized` is set.
function parseTrigger(env = process.env) {
  const eventName = env.GITHUB_EVENT_NAME;
  const rawPayloadPath = env.GITHUB_EVENT_PATH;

  let targetRepo = '';
  let issueNumber = '';
  let commentBody = '';
  let installationId = '';
  let eventType = '';
  let commentId = '';
  let author = '';
  let threadAuthor = '';
  let on = '';
  let synthesized = false;
  let payload = {};

  if (eventName === 'repository_dispatch') {
    if (rawPayloadPath && fs.existsSync(rawPayloadPath)) {
      const raw = JSON.parse(fs.readFileSync(rawPayloadPath, 'utf8'));
      payload = raw.client_payload?.raw || raw.client_payload || raw;
      eventType = raw.action || raw.event_type || '';
    }

    installationId = String(payload.installation?.id || '');

    if (payload.issue && payload.comment) {
      // issue_comment
      targetRepo = payload.repository?.full_name || '';
      issueNumber = String(payload.issue.number || '');
      commentBody = payload.comment.body || '';
      author = payload.comment.user?.login || '';
      threadAuthor = payload.issue.user?.login || '';
      on = payload.issue.pull_request ? 'pr' : 'issue';
    } else if (payload.pull_request && payload.review) {
      // pull_request_review
      targetRepo = payload.repository?.full_name || '';
      issueNumber = String(payload.pull_request.number || '');
      commentBody = payload.review.body || '';
      author = payload.review.user?.login || '';
      threadAuthor = payload.pull_request.user?.login || '';
      on = 'pr';
    } else if (payload.pull_request && payload.comment) {
      // pull_request_review_comment
      targetRepo = payload.repository?.full_name || '';
      issueNumber = String(payload.pull_request.number || '');
      commentBody = payload.comment.body || '';
      commentId = String(payload.comment?.id || '');
      author = payload.comment.user?.login || '';
      threadAuthor = payload.pull_request.user?.login || '';
      on = 'review_thread';
    } else if (payload.pull_request && payload.check_suite) {
      // ci_failure: synthesized instruction, no @the-intern-bot mention needed
      // since this bypasses the mention gate entirely.
      targetRepo = payload.repository?.full_name || '';
      issueNumber = String(payload.pull_request.number || '');
      const headSha = payload.check_suite.head_sha || '';
      commentBody = headSha
        ? `CI is failing on this PR (conclusion: ${payload.check_suite.conclusion}). Check suite: ${payload.check_suite.html_url}. This check suite ran against commit \`${headSha}\`. Before investigating, compare that commit to the PR's current head (e.g. \`gh pr view ${issueNumber} --json headRefOid\`). If the PR's head has already moved past \`${headSha}\`, this failure is stale - a newer commit supersedes it, so stop immediately without commenting or pushing anything. Otherwise, investigate the failing checks and push a fix.`
        : `CI is failing on this PR (conclusion: ${payload.check_suite.conclusion}). Check suite: ${payload.check_suite.html_url}. This check suite's failing commit could not be determined, so staleness can't be safely verified - stop immediately without investigating, commenting, or pushing anything.`;
      on = 'pr';
      synthesized = true;
    } else if (payload.pull_request && payload.coderabbit_review) {
      // coderabbit_review: synthesized instruction, same shape as ci_failure
      // above. The worker never reads/forwards the review body itself (tier-2
      // injection-safe) - the dispatched session reads the actual review
      // content itself via gh/api during normal operation.
      targetRepo = payload.repository?.full_name || '';
      issueNumber = String(payload.pull_request.number || '');
      commentBody = `CodeRabbit posted a review on PR #${payload.pull_request.number} (${payload.coderabbit_review.html_url}). Read it and address any actionable feedback.`;
      on = 'pr';
      synthesized = true;
    } else if (payload.pull_request && payload.merge_conflict) {
      // merge_conflict: synthesized instruction, same shape as ci_failure/
      // coderabbit_review above. Fires when a push to the default branch left
      // this bot-authored PR unmergeable.
      targetRepo = payload.repository?.full_name || '';
      issueNumber = String(payload.pull_request.number || '');
      commentBody = `A push to ${payload.merge_conflict.base_ref || 'the default branch'} left this PR unmergeable (mergeable_state: ${payload.merge_conflict.mergeable_state}). Merge or rebase the latest default branch into this PR's branch, resolve the conflicts, and push the fix.`;
      on = 'pr';
      synthesized = true;
    } else {
      // Fallback extraction
      targetRepo = payload.repository?.full_name || env.INPUT_TARGET_REPO || '';
      issueNumber = String(payload.issue?.number || payload.pull_request?.number || env.INPUT_PR_NUMBER || '');
      commentBody = payload.comment?.body || payload.review?.body || env.INPUT_COMMENT_BODY || '';
      author = payload.comment?.user?.login || payload.review?.user?.login || payload.sender?.login || '';
      on = payload.pull_request ? 'pr' : 'issue';
    }
  } else if (eventName === 'workflow_dispatch') {
    targetRepo = env.INPUT_TARGET_REPO || '';
    issueNumber = String(env.INPUT_PR_NUMBER || '');
    commentBody = env.INPUT_COMMENT_BODY || '';
    installationId = env.INPUT_INSTALLATION_ID || '';
    on = 'issue';
  }

  return {
    target_repo: targetRepo,
    issue_number: issueNumber,
    comment_body: commentBody,
    installation_id: installationId,
    event_type: eventType,
    comment_id: commentId,
    author,
    thread_author: threadAuthor,
    on,
    synthesized,
  };
}

module.exports = { parseTrigger };
