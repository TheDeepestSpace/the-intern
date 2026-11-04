const fs = require('fs');

// Extracts the *shape* of a dispatcher.yml trigger — which repo/issue it is
// about, who wrote it, the raw text — from the triggering GitHub Actions event
// (a repository_dispatch forwarded by the worker, or a workflow_dispatch).
// Which agent runs, and the `key=value` control-token grammar, are decided by
// agentic.yaml via scripts/resolve-agent.js, which is the only caller.
//
// System-synthesized dispatches (ci_failure, coderabbit_review,
// merge_conflict) only use the structural fallback below (repo, PR number,
// installation); their trigger event and request text are declared in
// agentic.yaml (see eventFromSystem and each agent's `request`).
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
  };
}

module.exports = { parseTrigger };
