const fs = require('fs');
const { loadSpecObject, resolveAction } = require('./lib/agentic');
const { getInstallationToken, getPrivateKey } = require('./mint-installation-token.js');

// Executes the actions an agent queued via emit-action.js, after the agent
// process has exited. Runs in the trusted root context: every queued line is
// validated against the agent's declared actions in agentic.yaml (name,
// parameter types, target agent's manual parameters, repo inside the agent's
// access) by lib/agentic.js#resolveAction; anything else is rejected. Valid
// `dispatch_agent` actions become a workflow_dispatch of dispatcher.yml with
// `agent` + `parameters` inputs, using a short-lived installation token for
// this repo minted here — the agent's own token never has that reach.
//
// Exits non-zero if any queued action was rejected or failed to dispatch, so
// the job fails and notify-failure pings Telegram (the agent cannot silently
// request something it is not allowed to).
//
// The spec comes from agent.json (written by resolve-agent.js in the trusted
// detect-image job, outside the agent's reach) and is re-validated here, so
// this runs inside the agent container without the YAML dependency.
//
// Env: AGENT_FILE, AGENT_ACTIONS_FILE, APP_ID, APP_PRIVATE_KEY,
// GITHUB_REPOSITORY (this repo), DISPATCH_REF, WORKFLOW_FILE.
const MAX_ACTIONS = 20;

function coerce(declared, parameters) {
  const out = {};
  for (const [k, v] of Object.entries(parameters || {})) {
    const t = declared[k];
    if (t === 'integer' && typeof v === 'string' && /^\d+$/.test(v)) out[k] = Number(v);
    else if (t === 'boolean' && typeof v === 'string' && /^(true|false)$/i.test(v)) out[k] = v.toLowerCase() === 'true';
    else out[k] = v;
  }
  return out;
}

function readQueued(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed.name !== 'string') throw new Error('missing name');
      return { name: parsed.name, parameters: parsed.parameters || {} };
    } catch (e) {
      return { error: `line ${i + 1} is not a valid action: ${e.message}` };
    }
  });
}

async function dispatchAgent({ agent, parameters }, env, mint = getInstallationToken) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');
  const token = await mint({
    appId: env.APP_ID,
    privateKey: getPrivateKey(env),
    access: [{ repo, scope: 'read/write' }],
    permissions: { actions: 'write', metadata: 'read' },
  });
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${env.WORKFLOW_FILE || 'dispatcher.yml'}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'the-intern-bot',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: env.DISPATCH_REF || 'main', inputs: { agent, parameters: JSON.stringify(parameters) } }),
    }
  );
  if (!res.ok) throw new Error(`workflow_dispatch for agent '${agent}' failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

async function execute(env = process.env, { mint } = {}) {
  const queued = readQueued(env.AGENT_ACTIONS_FILE || '/tmp/agent-actions.jsonl');
  if (!queued.length) {
    console.log('No agent actions queued.');
    return { dispatched: [], errors: [] };
  }
  const agent = JSON.parse(fs.readFileSync(env.AGENT_FILE, 'utf8'));
  const { spec, errors: specErrors } = loadSpecObject(agent.spec);
  if (specErrors.length) throw new Error(`agent.json carries an invalid spec: ${specErrors.join('; ')}`);
  const declared = Object.fromEntries((spec.agents[agent.agent]?.actions || []).map((a) => [a.name, a.parameters || {}]));
  const dispatched = [];
  const errors = [];
  if (queued.length > MAX_ACTIONS) errors.push(`${queued.length} actions queued; only the first ${MAX_ACTIONS} are considered`);
  for (const q of queued.slice(0, MAX_ACTIONS)) {
    if (q.error) {
      errors.push(q.error);
      continue;
    }
    try {
      const params = coerce(declared[q.name] || {}, q.parameters);
      const action = resolveAction(spec, agent.agent, agent.match, q.name, params);
      await dispatchAgent(action, env, mint);
      dispatched.push(action);
      console.log(`Dispatched agent '${action.agent}' with ${JSON.stringify(action.parameters)} (action "${q.name}")`);
    } catch (e) {
      errors.push(`action "${q.name}": ${e.message}`);
    }
  }
  for (const e of errors) console.error(`::error::execute-actions: ${e}`);
  return { dispatched, errors };
}

if (require.main === module) {
  execute()
    .then(({ errors }) => process.exit(errors.length ? 1 : 0))
    .catch((err) => {
      console.error(`::error::execute-actions: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { execute, readQueued, coerce, dispatchAgent };
