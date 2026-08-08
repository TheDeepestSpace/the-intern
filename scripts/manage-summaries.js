const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const path = require('path');
const { getInstallationToken, getPrivateKey } = require('./mint-installation-token.js');

const SUPPORTED_BACKENDS = new Set(['claude', 'codex']);

// Transitional second home for session data (see issue #112): the-intern is
// migrating this off its own orphan branches and onto a dedicated private repo.
// Writes/reads here are always best-effort — the-intern's own branches remain
// the source of truth until the migration is confirmed complete.
const DATA_REPO = process.env.DATA_REPO || 'TheDeepestSpace/the-intern-data';
const DATA_REPO_SUMMARIES_BRANCH = process.env.DATA_REPO_SUMMARIES_BRANCH || 'summaries';

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

// Filenames are `<Date.now()>-<uuid>.md` on both the-intern and the-intern-data,
// so their millisecond prefix is what lets fetchLatestSummary compare "newer"
// across the two repos.
function parseTimestampFromFilename(filename) {
  const match = path.basename(filename).match(/^(\d+)-/);
  return match ? Number(match[1]) : 0;
}

// DATA_REPO_REMOTE_URL is a test/manual escape hatch: point it at a local bare
// repo to exercise the dual-write/dual-read paths without minting a real token.
async function mintDataRepoToken() {
  const appId = process.env.APP_ID;
  const privateKey = getPrivateKey(process.env);
  if (!appId || !privateKey) {
    console.log('APP_ID/APP_PRIVATE_KEY not set; skipping the-intern-data token mint.');
    return null;
  }

  try {
    const token = await getInstallationToken({ appId, privateKey, targetRepo: DATA_REPO });
    // Tell GitHub Actions runner to mask this token across all step logs, same
    // as mint-installation-token.js's own CLI entrypoint does for its token.
    console.log(`::add-mask::${token}`);
    return token;
  } catch (err) {
    console.warn(`Failed to mint installation token for ${DATA_REPO}: ${err.message}`);
    return null;
  }
}

async function resolveDataRepoRemoteUrl() {
  if (process.env.DATA_REPO_REMOTE_URL) return process.env.DATA_REPO_REMOTE_URL;

  const token = await mintDataRepoToken();
  if (!token) return null;
  return `https://x-access-token:${token}@github.com/${DATA_REPO}.git`;
}

function fetchLatestSummaryFromOrigin(targetRepo, issueNumber) {
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
  return { content, filename };
}

// Best-effort mirror read: the-intern-data holds every issue's summaries as
// plain files on one shared branch, so a shallow clone plus a directory
// listing is enough to find the latest one — never throws.
async function fetchLatestSummaryFromDataRepo(targetRepo, issueNumber) {
  let remoteUrl;
  try {
    remoteUrl = await resolveDataRepoRemoteUrl();
  } catch (err) {
    console.warn(`Skipping the-intern-data fetch: ${err.message}`);
    return { content: '', filename: '' };
  }
  if (!remoteUrl) return { content: '', filename: '' };

  const repoSlug = sanitizeSlug(targetRepo);
  const dirPath = path.join('summaries', repoSlug, String(issueNumber));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-intern-data-fetch-'));

  try {
    runGit(`clone --branch ${DATA_REPO_SUMMARIES_BRANCH} --single-branch --depth 1 ${remoteUrl} .`, {
      cwd: workDir,
      allowFailure: true,
    });

    const fullDir = path.join(workDir, dirPath);
    if (!fs.existsSync(fullDir)) return { content: '', filename: '' };

    const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.md')).sort();
    if (files.length === 0) return { content: '', filename: '' };

    const filename = files[files.length - 1];
    const content = fs.readFileSync(path.join(fullDir, filename), 'utf8');
    return { content, filename: path.join(dirPath, filename) };
  } catch (err) {
    console.warn(`Failed to fetch prior summary from the-intern-data: ${err.message}`);
    return { content: '', filename: '' };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Reads both sources and keeps whichever summary was persisted more recently,
// so issues whose history predates the the-intern-data migration (still
// origin-only) and issues saved after it (present in both) both resolve
// correctly.
async function fetchLatestSummary(targetRepo, issueNumber) {
  if (!targetRepo || !issueNumber) return { content: '', filename: '' };
  ensureSafeDirectory();

  const origin = fetchLatestSummaryFromOrigin(targetRepo, issueNumber);
  const dataRepo = await fetchLatestSummaryFromDataRepo(targetRepo, issueNumber);

  const originTs = origin.filename ? parseTimestampFromFilename(origin.filename) : 0;
  const dataRepoTs = dataRepo.filename ? parseTimestampFromFilename(dataRepo.filename) : 0;
  const newer = dataRepoTs > originTs ? dataRepo : origin;

  if (newer.content) {
    const source = newer === dataRepo ? 'the-intern-data' : 'the-intern';
    console.log(`Retrieved prior summary from ${source}: ${newer.filename}`);
  }
  return newer;
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

// Unchanged from before the-intern-data existed: pushes one summary commit to
// the per-issue orphan branch on the-intern's own origin. Returns the
// summary content it built (even on a push failure, since a local commit was
// still made) so saveSummary can mirror the same content to the-intern-data.
function saveSummaryToOrigin(targetRepo, issueNumber, promptText, resultText, backend) {
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
      builtContent = summaryContent;

      fs.mkdirSync(dirPath, { recursive: true });
      const filename = path.join(dirPath, `${Date.now()}-${crypto.randomUUID()}.md`);
      fs.writeFileSync(filename, summaryContent, 'utf8');

      runGit(`add ${filename}`);
      runGit(`commit -m "summary: ${targetRepo} #${issueNumber} at ${timestamp}"`);

      if (!hasToken) {
        console.log('No GITHUB_TOKEN/GH_TOKEN set; skipping push of summary branch.');
        return builtContent;
      }

      try {
        runGit(`push origin ${branchName}`);
        console.log(`Pushed summary to branch ${branchName}`);
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

// Best-effort mirror write to the-intern-data: clones the shared `summaries`
// branch into a scratch dir (kept separate from the origin checkout above,
// which may itself be mid-checkout on an orphan branch), adds the same
// summary file under the same path, and pushes. Never throws and never
// touches process.exitCode — a failure here (missing repo grant, network
// error, etc.) must not affect the origin write, which remains the source
// of truth during the transition.
async function saveSummaryToDataRepo(targetRepo, issueNumber, summaryContent) {
  if (!summaryContent) return;

  let remoteUrl;
  try {
    remoteUrl = await resolveDataRepoRemoteUrl();
  } catch (err) {
    console.warn(`Skipping the-intern-data dual-write: ${err.message}`);
    return;
  }
  if (!remoteUrl) return;

  const repoSlug = sanitizeSlug(targetRepo);
  const relFilePath = path.join('summaries', repoSlug, String(issueNumber), `${Date.now()}-${crypto.randomUUID()}.md`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-intern-data-save-'));
  const maxAttempts = 3;

  const resetWorkDir = () => {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
  };

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      resetWorkDir();

      let cloned = true;
      try {
        runGit(`clone --filter=blob:none --no-checkout --branch ${DATA_REPO_SUMMARIES_BRANCH} --single-branch ${remoteUrl} .`, { cwd: workDir });
        // --no-checkout leaves the index empty; read-tree repopulates it from
        // HEAD's tree (objects only, no blob content) so the new file below
        // is added on top of the existing tree instead of replacing it.
        runGit('read-tree HEAD', { cwd: workDir });
      } catch (err) {
        cloned = false;
      }
      if (!cloned) {
        resetWorkDir();
        runGit(`clone --filter=blob:none --no-checkout ${remoteUrl} .`, { cwd: workDir });
        runGit(`checkout --orphan ${DATA_REPO_SUMMARIES_BRANCH}`, { cwd: workDir });
        runGit('rm -rf .', { cwd: workDir, allowFailure: true });
      }

      runGit('config user.name "the-intern-bot[bot]"', { cwd: workDir });
      runGit('config user.email "the-intern-bot[bot]@users.noreply.github.com"', { cwd: workDir });

      const fullPath = path.join(workDir, relFilePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, summaryContent, 'utf8');

      runGit(`add ${relFilePath}`, { cwd: workDir });
      runGit(`commit -m "summary: ${targetRepo} #${issueNumber}"`, { cwd: workDir });

      try {
        runGit(`push origin ${DATA_REPO_SUMMARIES_BRANCH}`, { cwd: workDir });
        console.log(`Mirrored summary to the-intern-data:${DATA_REPO_SUMMARIES_BRANCH}/${relFilePath}`);
        return;
      } catch (err) {
        const isRejected = /non-fast-forward|fetch first/i.test(err.message);
        if (isRejected && attempt < maxAttempts) {
          console.warn(`Push to the-intern-data was rejected (attempt ${attempt}/${maxAttempts}), retrying: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    console.warn(`Failed to mirror summary to the-intern-data: ${err.message}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function saveSummary(targetRepo, issueNumber, promptText, resultText, backend) {
  if (!targetRepo || !issueNumber) return;
  if (!/^[1-9]\d*$/.test(String(issueNumber))) {
    console.error(`Refusing to save summary: invalid issue number "${issueNumber}"`);
    process.exitCode = 1;
    return;
  }

  const summaryContent = saveSummaryToOrigin(targetRepo, issueNumber, promptText, resultText, backend);
  await saveSummaryToDataRepo(targetRepo, issueNumber, summaryContent);
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
