// index.js (Final Hackathon Version with Jira)
import dotenv from 'dotenv';
dotenv.config();

import { Buffer } from 'node:buffer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { Octokit } from '@octokit/rest';

// --- CONFIGURATION & ARGS ---
const [,, OWNER, REPO, PR_NUM_STR, SOURCE_COMMIT_SHA] = process.argv;
if (!OWNER || !REPO || !PR_NUM_STR || !SOURCE_COMMIT_SHA) {
  console.error('Usage: node index.js <owner> <repo> <prNumber> <sourceCommitSha>');
  process.exit(1);
}
const PR_NUM = Number(PR_NUM_STR);
const DOCS_DIR = 'docs';
const BRANCH = 'main';
const SKIP_FLAG = '[skip-docflow]';

// --- ENV ---
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_API_TOKEN;
const JIRA_BASE_URL  = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
const JIRA_EMAIL     = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || process.env.JIRA_API_KEY;

// --- CLIENTS ---
const octo = new Octokit({ auth: GITHUB_TOKEN });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);
const DYNAMO_TABLE = process.env.DYNAMODB_TABLE_NAME;

// --- JIRA HELPER (from your script) ---
function extractJiraKey(text) {
    if (!text) return null;
    const match = text.match(/([A-Z]{2,10}-\d+)/);
    return match ? match[0] : null;
}

async function getJiraIssue(jiraKey) {
  // This function is identical to the one you provided.
  // ... (getJiraIssue implementation from your file)
}

// --- MAIN LOGIC ---
(async () => {
  try {
    // 1. Get Context: Fetch PR, diff, and current docs
    console.log(`Analyzing PR #${PR_NUM} with source commit ${SOURCE_COMMIT_SHA}...`);
    const [{ data: pr }, { data: diffString }] = await Promise.all([
      octo.pulls.get({ owner: OWNER, repo: REPO, pull_number: PR_NUM }),
      octo.pulls.get({ owner: OWNER, repo: REPO, pull_number: PR_NUM, mediaType: { format: "diff" } })
    ]);

    const jiraKey = extractJiraKey(pr.title) || extractJiraKey(pr.head.ref);
    const jira = await getJiraIssue(jiraKey);

    const { data: treeData } = await octo.git.getTree({ owner: OWNER, repo: REPO, tree_sha: BRANCH, recursive: true });
    const docFiles = treeData.tree.filter(f => f.path.startsWith(DOCS_DIR + '/') && f.type === 'blob');
    let existingDocs = "";
    for (const doc of docFiles) {
      const { data: content } = await octo.git.getBlob({ owner: OWNER, repo: REPO, file_sha: doc.sha });
      existingDocs += `\n\n--- FILE: ${doc.path} ---\n` + Buffer.from(content.content, 'base64').toString('utf8');
    }

    // 2. AI Magic: Ask Gemini to update docs, now with Jira context
    console.log('Asking AI to generate documentation updates...');
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });
    const jiraContext = jira ? `JIRA TICKET CONTEXT:\n${jira.key}: ${jira.summary}\n${jira.description}` : 'No JIRA ticket linked.';
    const prompt = `You are an expert technical writer. A developer has merged a PR. Based on the code diff and associated context, update the existing documentation.
    Output ONLY the full, new file content for each file that needs to be changed, enclosed in markdown code blocks with the file path.
    For example: \`\`\`markdown: docs/api/endpoints.md\n... new content ...\n\`\`\`\n
    ${jiraContext}\n
    PR TITLE: ${pr.title}\n
    CODE DIFF:\n${diffString}\n
    EXISTING DOCUMENTATION:\n${existingDocs}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // 3. Parse AI Response and Prepare Git Blobs
    const updatedFileBlobs = [];
    const regex = /```markdown: (docs\/[^\s]+)\n([\s\S]*?)\n```/g;
    let match;
    while ((match = regex.exec(responseText)) !== null) {
      const path = match[1];
      const newContent = match[2];
      const { data: blob } = await octo.git.createBlob({ owner: OWNER, repo: REPO, content: newContent, encoding: 'utf-8' });
      updatedFileBlobs.push({ path, sha: blob.sha, type: 'blob', mode: '100644' });
      console.log(`Prepared update for ${path}`);
    }

    if (updatedFileBlobs.length === 0) {
      console.log('AI determined no documentation changes were needed.');
      process.exit(0);
    }

    // 4. Create a New Commit with the Bot's Changes
    console.log('Creating new documentation commit...');
    const { data: refData } = await octo.git.getRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}` });
    const { data: newTree } = await octo.git.createTree({ owner: OWNER, repo: REPO, base_tree: refData.object.sha, tree: updatedFileBlobs });
    const commitMessage = `docs: AI-generated documentation for PR #${PR_NUM}\n\nSource commit: ${SOURCE_COMMIT_SHA}\n${SKIP_FLAG}`;
    const { data: newCommit } = await octo.git.createCommit({
      owner: OWNER, repo: REPO, message: commitMessage,
      tree: newTree.sha, parents: [refData.object.sha]
    });
    await octo.git.updateRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}`, sha: newCommit.sha });
    const botCommitSha = newCommit.sha;
    console.log(`✅ Pushed bot commit: ${botCommitSha}`);

    // 5. Record Transaction in DynamoDB
    const repoBranchId = `${OWNER}/${REPO}#${BRANCH}`;
    const { Item: parentItem } = await docClient.send(new GetCommand({ TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: 'HEAD' } }));
    const parentTxnSK = parentItem ? parentItem.latestTxnSK : 'ROOT';
    const newTxnSK = `TXN#${new Date().toISOString()}#${PR_NUM}`;

    await docClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: DYNAMO_TABLE, Item: {
          RepoBranch: repoBranchId, SK: newTxnSK, parentTxnSK,
          type: 'AI_GENERATED',
          sourceCommitSha: SOURCE_COMMIT_SHA, botCommitSha, originalCodeDiff: diffString,
          prNumber: PR_NUM, prTitle: pr.title, prAuthor: pr.user?.login, jiraKey: jira?.key || null,
      }}},
      { Update: { TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: 'HEAD' },
          UpdateExpression: 'SET latestTxnSK = :sk', ExpressionAttributeValues: { ':sk': newTxnSK },
      }},
    ]}));
    console.log('✅ Recorded transaction in DocFlow.');

  } catch (error) {
    console.error('\n❌ An error occurred in the AI Bot:', error);
    process.exit(1);
  }
})();