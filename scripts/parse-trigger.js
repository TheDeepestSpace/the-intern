const fs = require('fs');

function parseTrigger() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const rawPayloadPath = process.env.GITHUB_EVENT_PATH;
  
  let targetRepo = '';
  let issueNumber = '';
  let commentBody = '';
  let installationId = '';
  let eventType = '';

  if (eventName === 'repository_dispatch') {
    let payload = {};
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
    } else if (payload.pull_request && payload.review) {
      // pull_request_review
      targetRepo = payload.repository?.full_name || '';
      issueNumber = String(payload.pull_request.number || '');
      commentBody = payload.review.body || '';
    } else if (payload.pull_request && payload.comment) {
      // pull_request_review_comment
      targetRepo = payload.repository?.full_name || '';
      issueNumber = String(payload.pull_request.number || '');
      commentBody = payload.comment.body || '';
    } else if (payload.check_suite) {
      // check_suite
      // Defense-in-depth: the webhook relay (worker/src/index.js) is meant to
      // filter check_suite events to failures only and to drop events for the
      // agent-infra repo itself (this workflow's own runs generate check_suite
      // completions, which would otherwise re-trigger this workflow forever).
      // Re-check both conditions here so a stale/undeployed relay can't cause
      // a dispatch loop or a no-op session.
      const repo = payload.repository?.full_name || '';
      const conclusion = payload.check_suite.conclusion || 'failed';
      const infraRepo = process.env.GITHUB_REPOSITORY || '';

      if (conclusion === 'failure' && repo !== infraRepo) {
        targetRepo = repo;
        const prs = payload.check_suite.pull_requests || [];
        issueNumber = prs.length > 0 ? String(prs[0].number) : '';
        const headBranch = payload.check_suite.head_branch || 'unknown';
        commentBody = `CI check suite completed with status '${conclusion}' on branch '${headBranch}'. Please investigate any failures.`;
      }
    } else {
      // Fallback extraction
      targetRepo = payload.repository?.full_name || process.env.INPUT_TARGET_REPO || '';
      issueNumber = String(payload.issue?.number || payload.pull_request?.number || process.env.INPUT_PR_NUMBER || '');
      commentBody = payload.comment?.body || payload.review?.body || process.env.INPUT_COMMENT_BODY || '';
    }
  } else if (eventName === 'workflow_dispatch') {
    targetRepo = process.env.INPUT_TARGET_REPO || '';
    issueNumber = String(process.env.INPUT_PR_NUMBER || '');
    commentBody = process.env.INPUT_COMMENT_BODY || '';
    installationId = process.env.INPUT_INSTALLATION_ID || '';
  }

  // Parse backend/model/effort parameters from commentBody if present
  let backend = 'claude';
  let model = 'default';
  let effort = 'default';

  // Remove @the-intern-bot and optional backend keywords (claude/codex/agy) from cleanComment
  let cleanComment = commentBody
    .replace(/@the-intern-bot\s*(claude|codex|agy)?\s*/gi, '')
    .trim();

  // Extract key=value options like model=claude-3-7-sonnet effort=high backend=claude
  const matchModel = cleanComment.match(/\bmodel=([^\s]+)/i);
  if (matchModel) model = matchModel[1];

  const matchEffort = cleanComment.match(/\beffort=([^\s]+)/i);
  if (matchEffort) effort = matchEffort[1];

  const matchBackend = cleanComment.match(/\bbackend=([^\s]+)/i);
  if (matchBackend) backend = matchBackend[1];

  // Remove key=value parameters from clean comment to get prompt
  cleanComment = cleanComment
    .replace(/\b(model|effort|backend)=([^\s]+)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanComment) {
    cleanComment = 'Please inspect the context and assist with this issue or pull request.';
  }

  const result = {
    target_repo: targetRepo,
    issue_number: issueNumber,
    comment_body: commentBody,
    clean_prompt: cleanComment,
    installation_id: installationId,
    backend,
    model,
    effort,
    event_type: eventType,
  };

  console.log('Parsed trigger:', JSON.stringify(result, null, 2));

  if (process.env.GITHUB_OUTPUT) {
    for (const [k, v] of Object.entries(result)) {
      // Escape newlines for GITHUB_OUTPUT multi-line values if needed
      if (typeof v === 'string' && v.includes('\n')) {
        const delimiter = `EOF_${Math.random().toString(36).substring(2, 10)}`;
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}<<${delimiter}\n${v}\n${delimiter}\n`);
      } else {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
      }
    }
  }

  return result;
}

if (require.main === module) {
  parseTrigger();
}

module.exports = { parseTrigger };
