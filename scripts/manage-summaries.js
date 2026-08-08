const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const path = require('path');
const { resolveDataRepoRemoteUrl, redactUrl } = require('./data-repo-remote.js');

const SUPPORTED_BACKENDS = new Set(['claude', 'codex']);

// Session/conversation data storage (issue #112): the-intern-data is the sole
// home for session summaries — the-intern's own orphan branches are no longer
// read or written (cut over after the-intern-data was confirmed populated).

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
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${redactUrl(cmd)} failed: ${redactUrl(detail)}`);
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

function fetchLatestSummaryFromDataRepo(targetRepo, issueNumber, remoteUrl) {
  const branchName = getBranchName(targetRepo, issueNumber);

  // Fetch branch from the-intern-data if available (it may legitimately not exist yet)
  try {
    runGit(`fetch ${remoteUrl} ${branchName}:${branchName}`);
  } catch (err) {
    // "couldn't find remote ref" means no prior summary was ever saved for
    // this issue — that's expected and silent. Any other fetch error (auth,
    // network, ref-update) must not read a possibly-stale/absent local
    // branch below, so both cases return here, but only the latter warns.
    if (!/couldn't find remote ref/i.test(err.message)) {
      console.warn(`::warning::Could not fetch prior summary branch ${branchName}: ${err.message}`);
    } else {
      console.log(`No prior summary branch found for ${branchName}`);
    }
    return { content: '', filename: '' };
  }

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
  return { content, filename };
}

async function fetchLatestSummary(targetRepo, issueNumber) {
  if (!targetRepo || !issueNumber) return { content: '', filename: '' };
  ensureSafeDirectory();

  let remoteUrl;
  try {
    remoteUrl = await resolveDataRepoRemoteUrl();
  } catch (err) {
    console.warn(`Skipping the-intern-data fetch: ${err.message}`);
    return { content: '', filename: '' };
  }
  if (!remoteUrl) return { content: '', filename: '' };

  const result = fetchLatestSummaryFromDataRepo(targetRepo, issueNumber, remoteUrl);
  if (result.content) console.log(`Retrieved prior summary from the-intern-data: ${result.filename}`);
  return result;
}

async function fetchSummary(targetRepo, issueNumber) {
  const { content } = await fetchLatestSummary(targetRepo, issueNumber);
  if (content) writeOutput('summary', content);

  return content;
}

async function fetchBackend(targetRepo, issueNumber) {
  const { content } = await fetchLatestSummary(targetRepo, issueNumber);
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

// Pushes one summary commit to the per-issue orphan branch on the-intern-data.
// Sets process.exitCode = 1 on failure — there is no fallback store, so a
// failed save here is a real data-loss event, not a soft-degrade.
function saveSummaryToDataRepo(targetRepo, issueNumber, promptText, resultText, backend, remoteUrl) {
  ensureSafeDirectory();
  const branchName = getBranchName(targetRepo, issueNumber);
  const repoSlug = sanitizeSlug(targetRepo);
  const dirPath = path.join('summaries', repoSlug, String(issueNumber));
  const effectiveBackend = normalizeBackend(backend) || 'claude';

  // Concurrent runs (e.g. fetch + save jobs racing on the same issue) can push
  // to this branch between our fetch and our push, so a couple of retries
  // absorb the ordinary non-fast-forward rejection instead of failing the step.
  const maxAttempts = 3;
  let builtContent = '';

  try {
    runGit('config user.name "the-intern-bot[bot]"');
    runGit('config user.email "the-intern-bot[bot]@users.noreply.github.com"');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        // Detach so the branch ref is free, drop our stale local copy, and
        // re-fetch the branch's current tip before rebuilding our commit on it.
        runGit('checkout --detach');
        runGit(`branch -D ${branchName}`);
        runGit(`fetch ${remoteUrl} ${branchName}:${branchName}`);
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
      builtContent = summaryContent;

      fs.mkdirSync(dirPath, { recursive: true });
      const filename = path.join(dirPath, `${Date.now()}-${crypto.randomUUID()}.md`);
      fs.writeFileSync(filename, summaryContent, 'utf8');

      runGit(`add ${filename}`);
      runGit(`commit -m "summary: ${targetRepo} #${issueNumber} at ${timestamp}"`);

      try {
        runGit(`push ${remoteUrl} ${branchName}`);
        console.log(`Pushed summary to the-intern-data:${branchName}`);
        return builtContent;
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

  return builtContent;
}

async function saveSummary(targetRepo, issueNumber, promptText, resultText, backend) {
  if (!targetRepo || !issueNumber) return;
  if (!/^[1-9]\d*$/.test(String(issueNumber))) {
    console.error(`Refusing to save summary: invalid issue number "${issueNumber}"`);
    process.exitCode = 1;
    return;
  }

  let remoteUrl;
  try {
    remoteUrl = await resolveDataRepoRemoteUrl();
  } catch (err) {
    console.error(`Failed to resolve the-intern-data remote: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (!remoteUrl) {
    console.error('the-intern-data remote is not configured (APP_ID/APP_PRIVATE_KEY or DATA_REPO_REMOTE_URL); cannot save summary.');
    process.exitCode = 1;
    return;
  }

  saveSummaryToDataRepo(targetRepo, issueNumber, promptText, resultText, backend, remoteUrl);
}

if (require.main === module) {
  const mode = process.argv[2];
  const targetRepo = process.env.TARGET_REPO;
  const issueNumber = process.env.ISSUE_NUMBER;

  (async () => {
    if (mode === 'fetch') {
      await fetchSummary(targetRepo, issueNumber);
    } else if (mode === 'backend') {
      await fetchBackend(targetRepo, issueNumber);
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
      await saveSummary(targetRepo, issueNumber, promptText, resultText, process.env.BACKEND);
    }
  })().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { fetchBackend, fetchSummary, fetchLatestSummary, resolveBackend, saveSummary };
