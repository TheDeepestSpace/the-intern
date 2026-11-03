const fs = require('fs');
const path = require('path');
const { loadSpec, explain } = require('./lib/agentic');

// Usage: node scripts/validate-agentic.js [agentic.yaml] [--explain event.json]
// Exits non-zero (printing every problem) when the file is invalid. With
// --explain, dry-runs a normalized event and prints the resolved agent,
// access, params and prompt source instead of dispatching anything.
function main(argv) {
  const args = argv.slice();
  const ei = args.indexOf('--explain');
  const eventPath = ei >= 0 ? args.splice(ei, 2)[1] : null;
  const file = args[0] || path.join(__dirname, '..', 'agentic.yaml');

  const { spec, errors } = loadSpec(fs.readFileSync(file, 'utf8'));
  if (errors.length) {
    for (const e of errors) console.error(`${file}: ${e}`);
    return 1;
  }
  if (eventPath) {
    console.log(JSON.stringify(explain(spec, JSON.parse(fs.readFileSync(eventPath, 'utf8'))), null, 2));
    return 0;
  }
  console.log(`${file}: ok (${Object.keys(spec.agents).length} agents)`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
