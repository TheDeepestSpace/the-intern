const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const path = require('path');

const SUPPORTED_BACKENDS = new Set(['claude', 'codex']);

function sanitizeSlug(repo) {
  return repo.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function getBranchName(targetRepo, issueNumber) {
  const repoSlug = sanitizeSlug(targetRepo);
  return `summaries/${repoSlug}/${issueNumber}`;
}

// By default, a failing git command is a real error and must not be swallowed.
// Pass allowFailure: true only where a non-zero exit is an expected outcome
// (e.g. probing for a branch that may not exist yet).
function runGit(cmd, options = {}) {
  const { allowFailure = false, ...execOptions } = options;
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8', ...execOptions }).trim();
  } catch (err) {
    if (allowFailure) return '';
    throw new Error(`git ${cmd} failed: ${(err.stderr || err.message || '').toString().trim()}`);
  }
}

// Defensively mark cwd as safe regardless of what a prior step (e.g. actions/checkout)
// configured, since that config may not be visible here (different container/UID).
function ensureSafeDirectory() {
  runGit(`config --global --add safe.directory "${process.cwd()}"`, { allowFailure: true });
}

function normalizeBackend(backend) {
  const normalized = String(backend || '').trim().toLowerCase();
  return SUPPORTED_BACKENDS.has(normalized) ? normalized : '';
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;

  if (typeof value === 'string' && value.includes('\n')) {
    const delimiter = `EOF_${Math.random().toString(36).substring(2, 10)}`;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  } else {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function fetchLatestSummary(targetRepo, issueNumber) {
  if (!targetRepo || !issueNumber) return { content: '', filename: '' };
  ensureSafeDirectory();
  const branchName = getBranchName(targetRepo, issueNumber);

  // Fetch branch from origin if available (it may legitimately not exist yet)
  runGit(`fetch origin ${branchName}:${branchName}`, { allowFailure: true });

  // Each save adds one summary in its own commit. Read the file added by the
  // branch tip so same-millisecond filenames remain ordered by persistence,
  // not by their random UUID suffixes.
  const files = runGit(`diff-tree --root --no-commit-id --name-only -r ${branchName}`, { allowFailure: true });
  if (!files) {
    console.log(`No prior summary branch found for ${branchName}`);
    return { content: '', filename: '' };
  }

  const fileList = files.split('\n').filter(f => f.endsWith('.md'));
  if (fileList.length === 0) return { content: '', filename: '' };

  const filename = fileList[fileList.length - 1];
  const content = runGit(`show ${branchName}:${filename}`, { allowFailure: true });

  console.log(`Retrieved prior summary from ${filename}`);
  return { content, filename };
}

function fetchSummary(targetRepo, issueNumber) {
  const { content } = fetchLatestSummary(targetRepo, issueNumber);
  if (content) writeOutput('summary', content);

  return content;
}

function fetchBackend(targetRepo, issueNumber) {
  const { content } = fetchLatestSummary(targetRepo, issueNumber);
  const match = content.match(/^- \*\*Backend\*\*:\s*(\S+)\s*$/mi);
  const backend = normalizeBackend(match?.[1]);

  if (backend) {
    console.log(`Retrieved persisted backend: ${backend}`);
    writeOutput('backend', backend);
  }

  return backend;
}

function resolveBackend(requestedBackend, backendExplicit, persistedBackend) {
  const isExplicit = backendExplicit === true || backendExplicit === 'true';
  const candidate = isExplicit ? requestedBackend : persistedBackend;
  return normalizeBackend(candidate) || 'claude';
}

function saveSummary(targetRepo, issueNumber, promptText, resultText, backend) {
  if (!targetRepo || !issueNumber) return;
  if (!/^[1-9]\d*$/.test(String(issueNumber))) {
    console.error(`Refusing to save summary: invalid issue number "${issueNumber}"`);
    process.exitCode = 1;
    return;
  }
  ensureSafeDirectory();
  const branchName = getBranchName(targetRepo, issueNumber);
  const repoSlug = sanitizeSlug(targetRepo);
  const dirPath = path.join('summaries', repoSlug, String(issueNumber));
  const hasToken = !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  const effectiveBackend = normalizeBackend(backend) || 'claude';

  // Concurrent runs (e.g. fetch + save jobs racing on the same issue) can push
  // to this branch between our fetch and our push, so a couple of retries
  // absorb the ordinary non-fast-forward rejection instead of failing the step.
  const maxAttempts = 3;

  try {
    runGit('config user.name "the-intern-bot[bot]"');
    runGit('config user.email "the-intern-bot[bot]@users.noreply.github.com"');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        // Detach so the branch ref is free, drop our stale local copy, and
        // re-fetch the branch's current tip before rebuilding our commit on it.
        runGit('checkout --detach');
        runGit(`branch -D ${branchName}`);
        runGit(`fetch origin ${branchName}:${branchName}`);
      }

      // Create the orphan branch, or switch to it if a prior run already created it
      // (e.g. fetched by `fetchSummary` earlier in the same job, or re-fetched above).
      // Only clear the working tree on the orphan path: the fallback checkout of an
      // existing branch may carry another run's already-pushed summary, which must
      // stay in place (and in the tree) rather than being wiped by this attempt.
      try {
        runGit(`checkout --orphan ${branchName}`);
        runGit('rm -rf .');
      } catch (err) {
        runGit(`checkout ${branchName}`);
      }

      const timestamp = new Date().toISOString();
      const summaryContent = `# Session Summary

- **Timestamp**: ${timestamp}
- **Target Repo**: ${targetRepo}
- **Issue/PR**: #${issueNumber}
- **Backend**: ${effectiveBackend}

## Prompt / Request
${promptText || 'N/A'}

## Execution Output
${resultText || 'N/A'}
`;

      fs.mkdirSync(dirPath, { recursive: true });
      const filename = path.join(dirPath, `${Date.now()}-${crypto.randomUUID()}.md`);
      fs.writeFileSync(filename, summaryContent, 'utf8');

      runGit(`add ${filename}`);
      runGit(`commit -m "summary: ${targetRepo} #${issueNumber} at ${timestamp}"`);

      if (!hasToken) {
        console.log('No GITHUB_TOKEN/GH_TOKEN set; skipping push of summary branch.');
        return;
      }

      try {
        runGit(`push origin ${branchName}`);
        console.log(`Pushed summary to branch ${branchName}`);
        return;
      } catch (err) {
        const isRejected = /non-fast-forward|fetch first/i.test(err.message);
        if (isRejected && attempt < maxAttempts) {
          console.warn(`Push to ${branchName} was rejected (attempt ${attempt}/${maxAttempts}), retrying: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    console.error(`Failed to save session summary for ${targetRepo} #${issueNumber}: ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  const mode = process.argv[2];
  const targetRepo = process.env.TARGET_REPO;
  const issueNumber = process.env.ISSUE_NUMBER;

  if (mode === 'fetch') {
    fetchSummary(targetRepo, issueNumber);
  } else if (mode === 'backend') {
    fetchBackend(targetRepo, issueNumber);
  } else if (mode === 'resolve-backend') {
    const backend = resolveBackend(
      process.env.REQUESTED_BACKEND,
      process.env.BACKEND_EXPLICIT,
      process.env.PERSISTED_BACKEND
    );
    writeOutput('backend', backend);
  } else if (mode === 'save') {
    const promptText = process.env.CLEAN_PROMPT;
    const resultFile = process.env.RESULT_FILE;
    let resultText = '';
    if (resultFile && fs.existsSync(resultFile)) {
      resultText = fs.readFileSync(resultFile, 'utf8');
    }
    saveSummary(targetRepo, issueNumber, promptText, resultText, process.env.BACKEND);
  }
}

module.exports = { fetchBackend, fetchSummary, resolveBackend, saveSummary };
