const fs = require('fs');
const path = require('path');
const {
  loadSpecFile, route, resolveAgent, eventFromWebhook, eventFromTelegram, eventFromSystem, eventFromDispatch, botLogin,
} = require('./lib/agentic-yaml');
const { parseTrigger } = require('./parse-trigger');

// Resolves which agentic.yaml agent a workflow run is for, and everything the
// run needs from it: access list (-> token scope), backend/model/effort,
// timeout, prompt source, params, declared actions and the request text.
// Runs first in dispatcher.yml, specage.yml and telegram-session.yml.
//
// Fail closed: an invalid/missing agentic.yaml, an event no trigger matches,
// an ambiguous match, an owner outside the allowlist, or a worker/workflow
// disagreement on the agent all exit non-zero — nothing is dispatched and the
// workflow's notify-failure job pings Telegram.
//
// Untrusted text (the request, prompt) is written to files only, never to
// $GITHUB_OUTPUT or the log (issue #226).
const DEFAULT_REQUEST = 'Please inspect the context and assist with this issue or pull request.';
const COMMENT_EVENTS = ['issue_comment', 'pull_request_review', 'pull_request_review_comment'];
// System-synthesized dispatch types; each is routed to an agentic.yaml agent
// with the matching ci_failure | review | merge_conflict trigger.
const SYNTHESIZED_EVENTS = ['ci_failure', 'coderabbit_review', 'merge_conflict'];

function readEvent(env) {
  const p = env.GITHUB_EVENT_PATH;
  if (!p || !fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Builds the normalized trigger event for the run. Returns
// { event, expectedAgent, shape } where `shape` carries the issue/PR context
// for comment-style runs.
function buildEvent(spec, env) {
  const eventName = env.GITHUB_EVENT_NAME;
  const raw = readEvent(env);
  const eventType = raw.action || raw.event_type || '';
  const cp = raw.client_payload || {};

  if (eventName === 'workflow_dispatch') {
    const inputs = raw.inputs || {};
    // Generic dispatch_agent entrypoint: one JSON input, validated against the
    // `dispatch` allowlist in agentic.yaml. The caller is the (unspoofable)
    // GitHub actor that fired the workflow.
    const dispatchInput = env.INPUT_DISPATCH ?? inputs.dispatch ?? '';
    if (dispatchInput) {
      const actor = env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR || raw.sender?.login || '';
      return { event: eventFromDispatch(actor, dispatchInput), expectedAgent: null, shape: null };
    }
    const agent = env.INPUT_AGENT || inputs.agent || '';
    if (agent) {
      // Manual trigger (dispatch_agent action, or a human running the workflow).
      let parameters = {};
      const rawParams = env.INPUT_PARAMETERS ?? inputs.parameters ?? '';
      if (rawParams) {
        try {
          parameters = JSON.parse(rawParams);
        } catch (e) {
          throw new Error(`parameters input is not valid JSON: ${e.message}`);
        }
      }
      return { event: { kind: 'manual', agent, parameters }, expectedAgent: agent, shape: null };
    }
    // Legacy inputs (target_repo / pr_number / comment_body): a human (or a
    // queued usage-limit retry) asking for the catch-all agent directly, so
    // the mention is implicit.
    const shape = parseTrigger(env);
    if (!shape.target_repo) throw new Error('workflow_dispatch needs either `agent` or `target_repo`');
    const event = {
      kind: 'comment', repo: shape.target_repo, author: '', on: shape.on || 'issue',
      issue_number: shape.issue_number ? Number(shape.issue_number) : null, body: shape.comment_body, implicit: true,
    };
    return { event, expectedAgent: null, shape };
  }

  if (eventName !== 'repository_dispatch') throw new Error(`unsupported event ${eventName || '(none)'}`);

  if (COMMENT_EVENTS.includes(eventType)) {
    const payload = cp.raw || cp;
    const event = eventFromWebhook(spec, eventType, payload);
    if (!event) throw new Error(`could not normalize ${eventType} payload`);
    const shape = parseTrigger(env);
    return { event, expectedAgent: cp.agent || null, shape };
  }
  if (SYNTHESIZED_EVENTS.includes(eventType)) {
    const shape = parseTrigger(env);
    const event = eventFromSystem(eventType, cp.raw || cp);
    return { event, expectedAgent: cp.agent || null, shape };
  }
  if (eventType === 'agent_commit') {
    const event = {
      kind: 'commit', repo: cp.repo || '', author: cp.author || '', branch: cp.branch || '', sha: cp.sha || '',
      paths: Array.isArray(cp.paths) ? cp.paths : [], message: typeof cp.message === 'string' ? cp.message : '',
    };
    return { event, expectedAgent: cp.agent || null, shape: { installation_id: String(cp.installation_id || '') } };
  }
  if (eventType === 'telegram_message') {
    return { event: eventFromTelegram(cp), expectedAgent: cp.agent || null, shape: null };
  }
  throw new Error(`unsupported repository_dispatch type '${eventType || '(none)'}'`);
}

// The "New request:" text handed to the agent, per trigger kind. Commit and
// manual triggers carry no free text, so the facts of the trigger are spelled
// out instead (the specage protocol expects the dispatch message to name the
// data repo, branch and commit; the commit message names a PR to review).
function requestText(resolved, event) {
  if (event.kind === 'comment') return resolved.text || DEFAULT_REQUEST;
  if (event.kind === 'telegram') return resolved.text || '';
  // dispatch: the caller's inline prompt; a repo-sourced prompt is fetched
  // later (fetch-prompt-file.js) and joined by assemble-prompt.js.
  if (event.kind === 'dispatch') return resolved.text || '';
  // ci_failure / merge_conflict / review: the agent's declared `request`.
  if (resolved.request) return resolved.request;
  if (event.kind === 'commit') {
    const lines = [`Commit ${event.sha} was pushed to branch ${event.branch} of ${event.repo} by ${event.author}.`];
    const captures = Object.entries(resolved.match_captures || {});
    if (captures.length) lines.push(`Branch captures: ${captures.map(([k, v]) => `${k}=${v}`).join(', ')}.`);
    if (event.message) lines.push('', 'Commit message:', event.message);
    return lines.join('\n');
  }
  if (event.kind === 'manual') {
    const params = Object.entries(event.parameters || {}).map(([k, v]) => `${k}=${v}`).join(', ');
    return `Manual run of agent ${resolved.agent}${params ? ` with parameters: ${params}` : ''}.`;
  }
  return '';
}

function writeOutput(env, key, value) {
  if (!env.GITHUB_OUTPUT) return;
  const v = value === null || value === undefined ? '' : String(value);
  if (v.includes('\n')) throw new Error(`output ${key} must be single-line`);
  fs.appendFileSync(env.GITHUB_OUTPUT, `${key}=${v}\n`);
}

function resolve(env = process.env) {
  const spec = loadSpecFile(env.AGENTIC_FILE || undefined);
  const { event, expectedAgent, shape } = buildEvent(spec, env);
  const hit = route(spec, event); // throws on ambiguity
  if (!hit) throw new Error(`no agent trigger in agentic.yaml matches this ${event.kind} event`);
  if (hit.match.error) throw new Error(`agent '${hit.name}': ${hit.match.error}`);
  if (expectedAgent && expectedAgent !== hit.name) {
    throw new Error(`the dispatch named agent '${expectedAgent}' but agentic.yaml routes this event to '${hit.name}'`);
  }
  const resolved = resolveAgent(spec, hit.name, hit.match); // throws on a bad/denied repo
  resolved.match_captures = hit.match.values.matcher || {};

  const targetRepo = resolved.repo || '';
  // The checkout/workspace for runs whose trigger repo is not the repo to
  // work in (a commit on the specage data repo runs against the project):
  // the first concrete repo in the agent's access list.
  const workspaceRepo = (resolved.access.find((a) => a.repo !== '*') || {}).repo || '';
  const issueNumber = resolved.issue_number === null || resolved.issue_number === undefined ? '' : String(resolved.issue_number);
  const text = requestText(resolved, event);
  const agentJson = {
    ...resolved,
    // The validated spec itself, so steps running inside the agent container
    // (execute-actions.js) can re-check actions without a YAML dependency.
    spec,
    bot: spec.bot,
    bot_login: botLogin(spec),
    spec_repos: spec.repos,
    match: hit.match,
    event_kind: event.kind,
    event_type: env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? (event.kind === 'manual' ? 'manual' : 'workflow_dispatch') : (readEvent(env).action || readEvent(env).event_type || ''),
    comment_id: event.comment_id !== undefined ? String(event.comment_id) : (shape?.comment_id || ''),
    installation_id: shape?.installation_id || '',
    target_repo: targetRepo,
    workspace_repo: workspaceRepo,
    issue_number: issueNumber,
  };
  return { spec, resolved, agentJson, text };
}

function main(env = process.env) {
  const { resolved, agentJson, text } = resolve(env);

  if (env.CLEAN_PROMPT_FILE) fs.writeFileSync(env.CLEAN_PROMPT_FILE, text, 'utf8');
  if (env.AGENT_FILE) fs.writeFileSync(env.AGENT_FILE, JSON.stringify(agentJson, null, 2), 'utf8');

  const promptSource = resolved.prompt_file || resolved.dispatch?.prompt_source || null;
  const outputs = {
    agent: resolved.agent,
    target_repo: agentJson.target_repo,
    workspace_repo: agentJson.workspace_repo,
    issue_number: agentJson.issue_number,
    installation_id: agentJson.installation_id,
    backend: resolved.backend,
    backend_explicit: 'backend' in resolved.params ? 'true' : 'false',
    model: resolved.model,
    effort: resolved.effort,
    timeout_minutes: Math.min(360, Math.max(1, Math.ceil(resolved.timeout_seconds / 60))),
    event_type: agentJson.event_type,
    comment_id: agentJson.comment_id,
    callback_repo: resolved.dispatch?.callback?.repo || '',
    access: JSON.stringify(resolved.access),
    prompt_repo: promptSource ? promptSource.repo : '',
    prompt_ref: promptSource ? promptSource.ref || '' : '',
    prompt_path: promptSource ? promptSource.path : '',
    actions_count: resolved.actions.length,
  };
  for (const [k, v] of Object.entries(outputs)) writeOutput(env, k, v);
  // The request text and prompt are never logged (public Actions log).
  console.log('Resolved agent:', JSON.stringify(outputs, null, 2));
  return outputs;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`::error::resolve-agent: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { resolve, main, buildEvent, requestText, DEFAULT_REQUEST };
