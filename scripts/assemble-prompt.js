const fs = require('fs');
const path = require('path');

// Builds the agent prompt (/tmp/prompt.txt) for dispatcher.yml and
// specage.yml from the agent resolved by resolve-agent.js (AGENT_FILE) plus
// the runtime-assembled parts that are not representable in agentic.yaml:
// the token's access list, the workspace-restore note, the inline-review-
// thread reply rule, the dispatch_agent block, the declared actions, shared-style.md,
// the prior-run summary and finally "New request:" + the request text.
// Runs in the trusted root context before run_as_dev.sh is generated, so the
// untrusted request text only ever reaches the agent through a file.
//
// Env: AGENT_FILE, CLEAN_PROMPT_FILE, PROMPT_FILE_TEXT (fetched prompt_file,
// when the agent has one), STYLE_FILE, PRIOR_SUMMARY_FILE, WORKSPACE_RESTORED,
// AGENT_ACTIONS_FILE, SCRIPTS_DIR, OUT_FILE (/tmp/prompt.txt), MODEL_OUT_FILE
// (/tmp/model.txt), MODEL.
const readOr = (file, fallback = '') => {
  if (!file) return fallback;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
};

function accessLine(access) {
  if (!access.length) return 'Your token has access to no repositories.';
  if (access.some((a) => a.repo === '*')) return 'Your token has read/write access to every repository the app is installed in.';
  const parts = access.map((a) => `${a.repo} (${a.scope})`);
  return `Repositories your token can access: ${parts.join(', ')}. Anything else is out of reach by design; do not try to widen it.`;
}

// Context for a run started through the generic dispatch_agent entrypoint:
// who asked, the retry counters and opaque context, and what to do with the
// issue / existing PR.
function dispatchBlock(agent) {
  const d = agent.dispatch;
  if (!d) return '';
  const lines = [`This run was dispatched by ${d.caller} (dispatch_agent), attempt ${d.attempt} of ${d.max_attempts}.`];
  if (d.pr) {
    lines.push(`Fix this in place on existing PR #${d.pr} of ${d.repo}: check out its branch (gh pr checkout ${d.pr}), amend/add commits and push to that same branch. Do not open a new PR.`);
  } else {
    lines.push(`The work is for issue #${d.issue} of ${d.repo}; open a single PR that references it.`);
  }
  lines.push(`Caller context (opaque JSON, echoed back to the caller when the run ends): ${JSON.stringify(d.context)}`);
  return `${lines.join('\n')}\n\n`;
}

function actionsBlock(agent, env) {
  const actions = agent.actions || [];
  if (!actions.length) return '';
  const scriptsDir = env.SCRIPTS_DIR || path.join(__dirname);
  const file = env.AGENT_ACTIONS_FILE || '/tmp/agent-actions.jsonl';
  const lines = [
    'Actions you may request from the system (executed with the system\'s own credentials after you finish, each validated against agentic.yaml):',
  ];
  for (const a of actions) {
    const params = Object.entries(a.parameters || {}).map(([k, t]) => `${k}=<${t}>`).join(' ');
    lines.push(`- "${a.name}"${params ? ` with ${params}` : ''}: run \`node ${path.join(scriptsDir, 'emit-action.js')} "${a.name}"${params ? ` ${params}` : ''}\``);
  }
  lines.push(`Each call appends one request to ${file}; nothing happens until the run ends. Only these actions exist; anything else is ignored and reported.`);
  return `${lines.join('\n')}\n\n`;
}

function assemble(env = process.env) {
  const agent = JSON.parse(readOr(env.AGENT_FILE, '') || 'null');
  if (!agent) throw new Error('AGENT_FILE is missing or empty');
  const request = readOr(env.CLEAN_PROMPT_FILE);
  const style = readOr(env.STYLE_FILE);
  const prior = readOr(env.PRIOR_SUMMARY_FILE);
  const workspaceRestored = env.WORKSPACE_RESTORED === 'true';
  const repo = agent.target_repo || agent.repo || '';
  const issue = agent.issue_number || '';
  const commentId = agent.comment_id || '';

  let head;
  if (agent.prompt_file) {
    head = readOr(env.PROMPT_FILE_TEXT);
    if (!head.trim()) throw new Error(`prompt_file ${agent.prompt_file.repo}/${agent.prompt_file.path} was not fetched (PROMPT_FILE_TEXT)`);
  } else {
    head = agent.prompt || '';
  }
  let prompt = head.trimEnd() + '\n\n';
  for (const snippet of agent.prompt_append || []) prompt += `${snippet.trim()}\n\n`;
  prompt += `${accessLine(agent.access || [])}\n\n`;
  if (workspaceRestored) {
    prompt += `Work from a previous incomplete run on this issue was restored into this checkout. It may be local commits that were never pushed, uncommitted working-tree changes, or both. Run 'git status' and 'git log' first, then continue, commit, or discard as appropriate.\n\n`;
  }
  if (agent.event_type === 'pull_request_review_comment' && commentId) {
    prompt += `This request came from an inline PR review comment that is part of a review thread (comment id ${commentId}). You must reply within that same thread using:\ngh api -X POST repos/${repo}/pulls/${issue}/comments/${commentId}/replies -f body="..."\nrather than 'gh pr comment' / 'gh issue comment', which posts a new general PR comment and breaks thread continuity.\n\n`;
  }
  prompt += dispatchBlock(agent);
  prompt += actionsBlock(agent, env);
  if (style.trim()) prompt += `${style}\n\n`;
  if (prior.trim()) prompt += `Previous work summary on this issue/PR:\n${prior}\n\n`;
  let body = request;
  if (agent.dispatch?.prompt_source) {
    body = readOr(env.PROMPT_FILE_TEXT);
    const src = agent.dispatch.prompt_source;
    if (!body.trim()) throw new Error(`dispatch prompt ${src.repo}/${src.path}@${src.ref} was not fetched (PROMPT_FILE_TEXT)`);
  }
  prompt += `New request:\n${body}`;

  fs.writeFileSync(env.OUT_FILE || '/tmp/prompt.txt', prompt);
  // Raw MODEL value, written here (trusted root context, before run_as_dev.sh
  // is generated) so the generated script can read it into a shell variable
  // rather than the value ever being interpolated directly into a command
  // string — same reasoning as /tmp/prompt.txt.
  fs.writeFileSync(env.MODEL_OUT_FILE || '/tmp/model.txt', env.MODEL || agent.model || '');
  return prompt;
}

if (require.main === module) {
  try {
    assemble();
  } catch (err) {
    console.error(`::error::assemble-prompt: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { assemble, accessLine, dispatchBlock, actionsBlock };
