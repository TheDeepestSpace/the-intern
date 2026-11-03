// YAML front-end for ./agentic.js: parses agentic.yaml text and runs the
// validator. Kept separate so agentic.js itself has no dependencies and can be
// bundled verbatim into the worker (scripts/bundle-agentic.js); everything
// running under Node (CI, the workflows, tests) goes through this module.
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const agentic = require('./agentic');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'agentic.yaml');

// Returns { spec, errors }; `spec` is null unless errors is empty.
function loadSpec(text) {
  let raw;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    return { spec: null, errors: [`invalid YAML: ${e.message.split('\n')[0]}`] };
  }
  return agentic.loadSpecObject(raw);
}

// Loads and validates a file. Throws (fail closed) when the file is missing
// or invalid — callers that dispatch agents must never proceed past this.
function loadSpecFile(file = DEFAULT_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`agentic.yaml is missing or unreadable (${file}): ${e.message}`);
  }
  const { spec, errors } = loadSpec(text);
  if (errors.length) throw new Error(`agentic.yaml is invalid (${file}):\n  ${errors.join('\n  ')}`);
  return spec;
}

module.exports = { ...agentic, loadSpec, loadSpecFile, DEFAULT_FILE };
