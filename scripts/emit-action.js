const fs = require('fs');

// Run by the agent (as the dev user) to request an action declared under its
// agent in agentic.yaml:
//   node scripts/emit-action.js "dispatch agent to implement issue" issue_number=12
// Appends one JSON line to $AGENT_ACTIONS_FILE (default /tmp/agent-actions.jsonl).
// Nothing is executed here: after the agent exits, scripts/execute-actions.js
// (root context, system credentials) validates every line against the agent's
// declared actions and parameter types and dispatches the valid ones.
function parseArgs(argv) {
  const [name, ...rest] = argv;
  if (!name) throw new Error('usage: emit-action.js "<action name>" [key=value ...]');
  const parameters = {};
  for (const arg of rest) {
    const m = /^([a-z_]\w*)=(.*)$/i.exec(arg);
    if (!m) throw new Error(`parameter '${arg}' must be key=value`);
    parameters[m[1]] = m[2];
  }
  return { name, parameters };
}

function emit(argv, env = process.env) {
  const action = parseArgs(argv);
  const file = env.AGENT_ACTIONS_FILE || '/tmp/agent-actions.jsonl';
  fs.appendFileSync(file, `${JSON.stringify(action)}\n`);
  console.log(`Queued action "${action.name}" (${JSON.stringify(action.parameters)}); it runs after this session ends.`);
  return action;
}

if (require.main === module) {
  try {
    emit(process.argv.slice(2));
  } catch (err) {
    console.error(`emit-action: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { emit, parseArgs };
