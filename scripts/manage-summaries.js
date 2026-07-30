const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

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

function fetchSummary(targetRepo, issueNumber) {
  if (!targetRepo || !issueNumber) return '';
  const branchName = getBranchName(targetRepo, issueNumber);

  // Fetch branch from origin if available (it may legitimately not exist yet)
  runGit(`fetch origin ${branchName}:${branchName}`, { allowFailure: true });

  const summaryDir = path.join(process.cwd(), '.summaries', sanitizeSlug(targetRepo), String(issueNumber));

  // Checkout summary files from branch into temporary path if branch exists
  const files = runGit(`ls-tree -r --name-only ${branchName}`, { allowFailure: true });
  if (!files) {
    console.log(`No prior summary branch found for ${branchName}`);
    return '';
  }

  const fileList = files.split('\n').filter(f => f.endsWith('.md')).sort();
  if (fileList.length === 0) return '';

  const latestFile = fileList[fileList.length - 1];
  const content = runGit(`show ${branchName}:${latestFile}`, { allowFailure: true });

  console.log(`Retrieved prior summary from ${latestFile}`);

  if (process.env.GITHUB_OUTPUT) {
    const delimiter = `EOF_${Math.random().toString(36).substring(2, 10)}`;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary<<${delimiter}\n${content}\n${delimiter}\n`);
  }

  return content;
}

function saveSummary(targetRepo, issueNumber, promptText, resultText) {
  if (!targetRepo || !issueNumber) return;
  const branchName = getBranchName(targetRepo, issueNumber);
  const timestamp = new Date().toISOString();
  const repoSlug = sanitizeSlug(targetRepo);
  const dirPath = path.join('summaries', repoSlug, String(issueNumber));

  const summaryContent = `# Session Summary

- **Timestamp**: ${timestamp}
- **Target Repo**: ${targetRepo}
- **Issue/PR**: #${issueNumber}

## Prompt / Request
${promptText || 'N/A'}

## Execution Output
${resultText || 'N/A'}
`;

  try {
    // Configure git user if needed
    runGit('config user.name "the-intern-bot[bot]"');
    runGit('config user.email "the-intern-bot[bot]@users.noreply.github.com"');

    // Create the orphan branch, or switch to it if a prior run already created it
    // (e.g. fetched by `fetchSummary` earlier in the same job).
    try {
      runGit(`checkout --orphan ${branchName}`);
    } catch (err) {
      runGit(`checkout ${branchName}`);
    }
    runGit('rm -rf .');

    fs.mkdirSync(dirPath, { recursive: true });
    const filename = path.join(dirPath, `${Date.now()}.md`);
    fs.writeFileSync(filename, summaryContent, 'utf8');

    runGit(`add ${filename}`);
    runGit(`commit -m "summary: ${targetRepo} #${issueNumber} at ${timestamp}"`);

    if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
      runGit(`push origin ${branchName}`);
      console.log(`Pushed summary to branch ${branchName}`);
    } else {
      console.log('No GITHUB_TOKEN/GH_TOKEN set; skipping push of summary branch.');
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
  } else if (mode === 'save') {
    const promptText = process.env.CLEAN_PROMPT;
    const resultFile = process.env.RESULT_FILE;
    let resultText = '';
    if (resultFile && fs.existsSync(resultFile)) {
      resultText = fs.readFileSync(resultFile, 'utf8');
    }
    saveSummary(targetRepo, issueNumber, promptText, resultText);
  }
}

module.exports = { fetchSummary, saveSummary };
