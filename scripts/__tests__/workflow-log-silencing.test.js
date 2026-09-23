import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// Structural checks on dispatcher.yml/telegram-session.yml (issue #224): every
// `run:` step in the agent-executing job must redirect its own stdout/stderr
// into the shared per-run log file instead of streaming to the public Actions
// log, the claude backend must no longer `tee` its transcript to the console,
// and the upload-on-failure step must only fire when the job actually failed.
// No YAML parser dependency is available in this repo, so job/step boundaries
// are located with plain indentation-aware string splitting rather than a
// real parse — workflow YAML here consistently uses 2-space-per-level
// indentation (jobs: -> 2sp job name -> 4sp steps: -> 6sp "- name:" -> 8sp
// step keys), which is what these regexes rely on.

const WORKFLOWS_DIR = path.join(__dirname, '..', '..', '.github', 'workflows');

function readWorkflow(file) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
}

function extractJobBody(yamlText, jobName) {
  const re = new RegExp(`\\n  ${jobName}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z_-]+:\\n|$)`);
  const m = yamlText.match(re);
  if (!m) throw new Error(`job "${jobName}" not found`);
  return m[1];
}

function extractSteps(jobBody) {
  return jobBody
    .split(/\n(?=      - name: )/)
    .filter(chunk => chunk.trim().startsWith('- name:'))
    .map(chunk => {
      const nameMatch = chunk.match(/^ {6}- name: (.+)$/m);
      return { name: nameMatch ? nameMatch[1].trim() : null, chunk };
    });
}

// Steps that only use `uses:` (a pinned action, not a shell script) have no
// stdout to silence — this repo's own agent-infra checkout step is the only
// one of those in either target job.
function stepsWithRunBlocks(steps) {
  return steps.filter(s => /\n {8}run: /.test(s.chunk));
}

describe.each([
  { file: 'dispatcher.yml', job: 'handle', label: 'dispatcher.yml handle job' },
  { file: 'telegram-session.yml', job: 'respond', label: 'telegram-session.yml respond job' },
])('$label', ({ file, job }) => {
  const yamlText = readWorkflow(file);
  const jobBody = extractJobBody(yamlText, job);
  const steps = extractSteps(jobBody);
  const runSteps = stepsWithRunBlocks(steps);

  it('has at least one run: step to check (sanity check on the extraction itself)', () => {
    expect(runSteps.length).toBeGreaterThan(5);
  });

  it('gives every run: step a multi-line `run: |` block, not a bare one-liner', () => {
    const oneLiners = runSteps.filter(s => /\n {8}run: [^|\n]/.test(s.chunk));
    expect(oneLiners.map(s => s.name)).toEqual([]);
  });

  it('makes `exec >> "$LOG_FILE" 2>&1` the first line of every run: step, so nothing streams to the public log', () => {
    const missing = runSteps.filter(s => {
      const firstLineMatch = s.chunk.match(/\n {8}run: \|\n *\n?( *)(.+)/) || s.chunk.match(/\n {8}run: \|\n( *)(.+)/);
      const firstLine = firstLineMatch ? firstLineMatch[2] : null;
      return firstLine !== 'exec >> "$LOG_FILE" 2>&1';
    });
    expect(missing.map(s => s.name)).toEqual([]);
  });

  it('never pipes the claude CLI invocation through `tee`', () => {
    const claudeInvocations = jobBody.match(/^.*claude -p.*$/gm) || [];
    expect(claudeInvocations.length).toBeGreaterThan(0);
    for (const line of claudeInvocations) {
      expect(line).not.toMatch(/\|\s*tee\b/);
    }
  });

  it('redirects the claude CLI invocation straight to result.json, matching the codex branch\'s own plain redirect', () => {
    const claudeInvocations = jobBody.match(/^.*claude -p.*$/gm) || [];
    for (const line of claudeInvocations) {
      expect(line).toMatch(/>\s*(\/tmp\/)?result\.json 2>&1/);
    }
  });

  it('declares LOG_FILE once at job level rather than per-step', () => {
    const jobLevelEnvMatch = yamlText.match(new RegExp(`\\n  ${job}:\\n[\\s\\S]*?\\n {4}env:\\n([\\s\\S]*?)\\n {4}steps:`));
    expect(jobLevelEnvMatch).not.toBeNull();
    expect(jobLevelEnvMatch[1]).toMatch(/LOG_FILE: \/tmp\/run\.log/);
  });

  it('has an "Upload run log on failure" step gated on failure(), not always()', () => {
    const uploadStep = steps.find(s => s.name === 'Upload run log on failure');
    expect(uploadStep).toBeTruthy();
    expect(uploadStep.chunk).toMatch(/\n {8}if: failure\(\)\n/);
    expect(uploadStep.chunk).not.toMatch(/\n {8}if: always\(\)/);
  });

  it('runs manage-run-log.js from the upload step, authenticated via DATA_REPO_TOKEN', () => {
    const uploadStep = steps.find(s => s.name === 'Upload run log on failure');
    expect(uploadStep.chunk).toMatch(/manage-run-log\.js/);
    expect(uploadStep.chunk).toMatch(/DATA_REPO_TOKEN: \$\{\{ secrets\.DATA_REPO_TOKEN \}\}/);
  });
});
