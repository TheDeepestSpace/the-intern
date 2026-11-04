// Tunables of a scheduled job, from the `settings:` of the agentic.yaml agent
// whose `job:` is `job`. Scripts keep a code default for every key they read,
// so a missing key (or an agent that omits `settings`) changes nothing; an
// invalid or missing agentic.yaml throws (fail closed, same as the loader).
function jobSettings(job, { file } = {}) {
  // Lazy: nightly-crawl.js is also run in the review container, which has no
  // node_modules, for subcommands that never read settings.
  const { loadSpecFile } = require('./agentic-yaml');
  const spec = loadSpecFile(file || process.env.AGENTIC_FILE || undefined);
  const agent = Object.values(spec.agents).find((a) => a.job === job);
  return agent ? { ...(agent.settings || {}) } : {};
}

module.exports = { jobSettings };
