import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('yaml');
const { loadSpecFile, parseDuration } = require('../lib/agentic-yaml');

// GitHub Actions only accepts literal crons, concurrency groups, timeouts and
// secret names in workflow files, so agentic.yaml stays the source of truth
// by failing CI whenever a scheduled workflow drifts from its agent.
const ROOT = path.join(__dirname, '..', '..');
const WORKFLOWS = {
  nightly_crawl: 'nightly-crawl.yml',
  cleanup_data_branches: 'cleanup-data-branches.yml',
  update_model_list: 'update-model-list.yml',
  usage_limit_poller: 'usage-limit-poller.yml',
};
const spec = loadSpecFile();
const scheduled = Object.entries(spec.agents).filter(([, a]) => a.trigger.schedule);

function load(file) {
  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8');
  return { text, doc: YAML.parse(text) };
}

describe('scheduled workflows match agentic.yaml', () => {
  it('every schedule agent has a workflow and vice versa', () => {
    expect(scheduled.map(([n]) => n).sort()).toEqual(Object.keys(WORKFLOWS).sort());
    const withSchedule = fs.readdirSync(path.join(ROOT, '.github', 'workflows'))
      .filter((f) => Array.isArray(load(f).doc.on?.schedule));
    const known = Object.values(WORKFLOWS);
    // ci.yaml has its own build schedule (not an agent); everything else must be declared.
    expect(withSchedule.filter((f) => !known.includes(f) && f !== 'ci.yaml')).toEqual([]);
  });

  for (const [name, agent] of scheduled) {
    describe(name, () => {
      const { text, doc } = load(WORKFLOWS[name]);

      it('cron', () => {
        expect(doc.on.schedule.map((s) => s.cron)).toEqual([agent.trigger.schedule.cron]);
      });

      it('concurrency group', () => {
        const groups = [doc.concurrency, ...Object.values(doc.jobs).map((j) => j.concurrency)]
          .filter(Boolean).map((c) => c.group);
        if (agent.concurrency) expect(groups).toEqual([agent.concurrency]);
        else expect(groups).toEqual([]);
      });

      it('explicit job timeouts', () => {
        const minutes = Object.values(doc.jobs).map((j) => j['timeout-minutes']).filter((m) => typeof m === 'number');
        if (!minutes.length) return;
        expect(agent.timeout).toBeDefined();
        expect(new Set(minutes)).toEqual(new Set([parseDuration(agent.timeout) / 60]));
      });

      it('uses no secret the agent does not declare', () => {
        const used = [...text.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]).filter((s) => s !== 'GITHUB_TOKEN');
        const undeclared = [...new Set(used)].filter((s) => !(agent.secrets || []).includes(s));
        expect(undeclared).toEqual([]);
        expect([...new Set(used)].sort()).toEqual([...(agent.secrets || [])].sort());
      });
    });
  }
});
