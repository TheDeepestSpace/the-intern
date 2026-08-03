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
    } else if (payload.pull_request && payload.check_suite) {
      // ci_failure: synthesized instruction, no @the-intern-bot mention needed
      // since this bypasses the mention gate entirely (the stripping regex
      // below is a no-op on text that doesn't contain the mention).
      targetRepo = payload.repository?.full_name || '';
      issueNumber = String(payload.pull_request.number || '');
      commentBody = `CI is failing on this PR (conclusion: ${payload.check_suite.conclusion}). Check suite: ${payload.check_suite.html_url}. Investigate the failing checks and push a fix.`;
    } else if (payload.pull_request && payload.coderabbit_review) {
      // coderabbit_review: synthesized instruction, same shape as ci_failure
      // above. The worker never reads/forwards the review body itself (tier-2
      // injection-safe) - the dispatched session reads the actual review
      // content itself via gh/api during normal operation.
      targetRepo = payload.repository?.full_name || '';
      issueNumber = String(payload.pull_request.number || '');
      commentBody = `CodeRabbit posted a review on PR #${payload.pull_request.number} (${payload.coderabbit_review.html_url}). Read it and address any actionable feedback.`;
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
  let backendExplicit = false;
  let model = 'default';
  let effort = 'default';

  // Remove @the-intern-bot and optional backend keywords (claude/codex/agy) from cleanComment
  let cleanComment = commentBody
    .replace(/@the-intern-bot\s*(claude|codex|agy)?\s*/gi, '')
    .trim();

  // Extract key=value options like model=claude-3-7-sonnet effort=high backend=claude.
  // These only count as control tokens when they form a leading run right after the
  // mention - matching anywhere in the string would also strip incidental key=value
  // text later in the prompt (e.g. a quoted shell flag like `-c model="sol"`).
  const leadingTokens = cleanComment.match(/^(?:(?:model|effort|backend)=\S+\s*)+/i);

  if (leadingTokens) {
    const tokenRun = leadingTokens[0];

    const matchModel = tokenRun.match(/\bmodel=(\S+)/i);
    if (matchModel) model = matchModel[1];

    const matchEffort = tokenRun.match(/\beffort=(\S+)/i);
    if (matchEffort) effort = matchEffort[1];

    const matchBackend = tokenRun.match(/\bbackend=(\S+)/i);
    if (matchBackend) {
      backend = matchBackend[1];
      backendExplicit = true;
    }

    cleanComment = cleanComment.slice(tokenRun.length).trim();
  }

  cleanComment = cleanComment.replace(/\s+/g, ' ').trim();

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
    backend_explicit: backendExplicit,
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
