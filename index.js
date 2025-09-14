// index.js (ESM)
import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Buffer } from 'node:buffer'; // Best practice to import Buffer explicitly in ESM

const [OWNER, REPO, PR_NUM_STR] = process.argv.slice(2);
if (!OWNER || !REPO || !PR_NUM_STR) {
  console.error('Usage: node index.js <owner> <repo> <prNumber>');
  process.exit(1);
}
const PR_NUM = Number(PR_NUM_STR);
const TARGET_FILE = 'CHANGELOG.md';
const BRANCH = 'main'; // change if your default branch differs

const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function appendToFile({ owner, repo, branch, path, appendText }) {
  let sha, prevText = '';
  try {
    const { data } = await octo.repos.getContent({ owner, repo, path, ref: branch });
    const b64 = data.content || '';
    prevText = Buffer.from(b64, 'base64').toString('utf8');
    sha = data.sha;
  } catch (e) {
    if (e.status !== 404) throw e; // create new if missing
  }
  const newText = prevText ? `${prevText.trimEnd()}\n\n${appendText}\n` : `# Changelog\n\n${appendText}\n`;
  await octo.repos.createOrUpdateFileContents({
    owner, repo, path,
    message: `chore(docs): update ${path} via DocFlow`,
    content: Buffer.from(newText, 'utf8').toString('base64'),
    branch, sha,
  });
}

// In ES Modules, you can use top-level 'await', so the async IIFE is not needed.
try {
  // 1) Fetch PR context
  console.log(`Fetching PR #${PR_NUM} from ${OWNER}/${REPO}...`);
  const [{ data: pr }, commits, files] = await Promise.all([
    octo.pulls.get({ owner: OWNER, repo: REPO, pull_number: PR_NUM }),
    octo.pulls.listCommits({ owner: OWNER, repo: REPO, pull_number: PR_NUM, per_page: 50 }),
    octo.pulls.listFiles({ owner: OWNER, repo: REPO, pull_number: PR_NUM, per_page: 100 }),
  ]);

  const commitMsgs = commits.data.slice(0, 8).map(c => `- ${c.commit.message}`).join('\n');
  const changedFiles = files.data.slice(0, 12).map(f => `- ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n');

  // 2) Ask Gemini for a concise changelog
  console.log('Generating changelog summary with Gemini...');
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
  const prompt = `
Summarize this merged PR for a CHANGELOG entry (max 6 bullets, user-facing first).
Call out breaking changes or risks if any. No fluff.

Repo: ${OWNER}/${REPO}
PR #${pr.number}: ${pr.title}
Author: ${pr.user?.login}
PR Body:
${pr.body || '(no description)'}
Top commits:
${commitMsgs || '(none)'}
Changed files:
${changedFiles || '(none)'}
`;
  let summary;
  try {
    const result = await model.generateContent(prompt);
    summary = result.response.text().trim();
  } catch (e) {
    console.error('Error generating content with primary model, trying fallback...', e);
    // quick fallback if model busy
    const fallback = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });
    const result = await fallback.generateContent(prompt);
    summary = result.response.text().trim();
  }
  console.log('Generated Summary:\n', summary);

  // 3) Append to CHANGELOG.md on default branch
  const block = [
    `## ${new Date().toISOString().slice(0,10)} – PR #${pr.number}: ${pr.title}`,
    summary,
    `*By @${pr.user?.login} • ${pr.html_url}*`,
  ].join('\n\n');

  console.log(`Appending to ${TARGET_FILE} on branch ${BRANCH}...`);
  await appendToFile({ owner: OWNER, repo: REPO, branch: BRANCH, path: TARGET_FILE, appendText: block });
  console.log(`✅ Appended to ${TARGET_FILE} on ${OWNER}/${REPO}@${BRANCH}`);
} catch (error) {
  console.error('An error occurred during the changelog generation process:', error);
  process.exit(1); // Exit with an error code to signal failure
}