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

function runGit(cmd, options = {}) {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8', ...options }).trim();
  } catch (err) {
    return '';
  }
}

function fetchSummary(targetRepo, issueNumber) {
  if (!targetRepo || !issueNumber) return '';
  const branchName = getBranchName(targetRepo, issueNumber);

  // Fetch branch from origin if available
  runGit(`fetch origin ${branchName}:${branchName}`);

  const summaryDir = path.join(process.cwd(), '.summaries', sanitizeSlug(targetRepo), String(issueNumber));
  
  // Checkout summary files from branch into temporary path if branch exists
  const files = runGit(`ls-tree -r --name-only ${branchName}`);
  if (!files) {
    console.log(`No prior summary branch found for ${branchName}`);
    return '';
  }

  const fileList = files.split('\n').filter(f => f.endsWith('.md')).sort();
  if (fileList.length === 0) return '';

  const latestFile = fileList[fileList.length - 1];
  const content = runGit(`show ${branchName}:${latestFile}`);

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
  
  fs.mkdirSync(dirPath, { recursive: true });
  const filename = path.join(dirPath, `${Date.now()}.md`);

  const summaryContent = `# Session Summary

- **Timestamp**: ${timestamp}
- **Target Repo**: ${targetRepo}
- **Issue/PR**: #${issueNumber}

## Prompt / Request
${promptText || 'N/A'}

## Execution Output
${resultText || 'N/A'}
`;

  fs.writeFileSync(filename, summaryContent, 'utf8');

  // Configure git user if needed
  runGit('config user.name "the-intern-bot[bot]"');
  runGit('config user.email "the-intern-bot[bot]@users.noreply.github.com"');

  // Create orphan or branch if not present
  runGit(`checkout --orphan ${branchName}`) || runGit(`checkout -b ${branchName}`);
  runGit('rm -rf .');
  
  // Re-write summary file
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(filename, summaryContent, 'utf8');

  runGit(`add ${filename}`);
  runGit(`commit -m "summary: ${targetRepo} #${issueNumber} at ${timestamp}"`);
  
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
    runGit(`push origin ${branchName}`);
    console.log(`Pushed summary to branch ${branchName}`);
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
