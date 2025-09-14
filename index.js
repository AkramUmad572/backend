// index.js (ESM)
import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

// --- CONFIGURATION ---
const [OWNER, REPO, PR_NUM_STR] = process.argv.slice(2);
if (!OWNER || !REPO || !PR_NUM_STR) {
  console.error('Usage: node index.js <owner> <repo> <prNumber>');
  process.exit(1);
}
const PR_NUM = Number(PR_NUM_STR);
const TARGET_FILE = 'CHANGELOG.md';
const BRANCH = 'main'; // change if your default branch differs

// --- CLIENT INITIALIZATION ---
const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);
const DYNAMO_TABLE = process.env.DYNAMODB_TABLE_NAME;

// --- HELPER FUNCTIONS ---

/**
 * Calculates the SHA-256 hash of a string.
 * @param {string} content The string to hash.
 * @returns {string} The hex-encoded hash.
 */
function getContentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Fetches the latest version information from DynamoDB.
 * @param {string} repoBranch The partition key (e.g., 'owner/repo#main').
 * @returns {Promise<string>} The Sort Key of the parent transaction, or 'ROOT'.
 */
async function getLatestVersionSK(repoBranch) {
  console.log(`Querying DynamoDB for HEAD of ${repoBranch}...`);
  try {
    const command = new GetCommand({
      TableName: DYNAMO_TABLE,
      Key: { RepoBranch: repoBranch, SK: 'HEAD' },
    });
    const { Item } = await docClient.send(command);
    if (Item && Item.latestTxnSK) {
      console.log(`Found parent transaction: ${Item.latestTxnSK}`);
      return Item.latestTxnSK;
    }
    console.log('No HEAD found. This will be the first transaction.');
    return 'ROOT'; // Represents the beginning of history
  } catch (error) {
    console.error('Error fetching latest version from DynamoDB:', error);
    throw error;
  }
}

/**
 * Updates a file on GitHub and returns its new state information.
 * @returns {Promise<{newContent: string, githubFileSha: string}>}
 */
async function updateGitHubFile({ owner, repo, branch, path, newContent }) {
  let currentSha;
  try {
    // We must fetch the current SHA to make an update.
    const { data } = await octo.repos.getContent({ owner, repo, path, ref: branch });
    currentSha = data.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
    console.log(`File ${path} not found, will create it.`);
  }

  const { data: updateResult } = await octo.repos.createOrUpdateFileContents({
    owner, repo, path,
    message: `chore(docs): update ${path} via DocFlow [PR #${PR_NUM}]`,
    content: Buffer.from(newContent, 'utf8').toString('base64'),
    branch,
    sha: currentSha, // Provide the current SHA to avoid race conditions
  });

  return {
    newContent: newContent,
    githubFileSha: updateResult.content.sha,
  };
}

/**
 * Atomically updates the version history in DynamoDB.
 */
async function updateVersionHistory({ repoBranch, newTxnSK, parentTxnSK, contentHash, prData, summaryBlock }) {
  console.log(`Atomically updating DynamoDB history for ${repoBranch}...`);
  const transaction = {
    TransactItems: [
      {
        // 1. Create the new transaction item
        Put: {
          TableName: DYNAMO_TABLE,
          Item: {
            RepoBranch: repoBranch,
            SK: newTxnSK,
            parentTxnSK: parentTxnSK,
            contentHash: contentHash,
            prNumber: prData.number,
            prTitle: prData.title,
            prAuthor: prData.user?.login,
            prUrl: prData.html_url,
            summary: summaryBlock,
            timestamp: newTxnSK.split('#')[1],
          },
        },
      },
      {
        // 2. Update the HEAD pointer to this new transaction
        Update: {
          TableName: DYNAMO_TABLE,
          Key: { RepoBranch: repoBranch, SK: 'HEAD' },
          UpdateExpression: 'SET latestTxnSK = :sk, updatedAt = :ts',
          ExpressionAttributeValues: {
            ':sk': newTxnSK,
            ':ts': new Date().toISOString(),
          },
        },
      },
    ],
  };

  try {
    await docClient.send(new TransactWriteCommand(transaction));
    console.log(`✅ Successfully created transaction ${newTxnSK} in DynamoDB.`);
  } catch (error) {
    console.error('❌ DynamoDB transaction failed:', error);
    // Here you might want to add logic to revert the GitHub commit or flag for manual review
    throw new Error('Failed to update version history in DynamoDB.');
  }
}


// --- MAIN EXECUTION LOGIC ---
try {
  // 1) Fetch PR context from GitHub
  console.log(`Fetching PR #${PR_NUM} from ${OWNER}/${REPO}...`);
  const { data: pr } = await octo.pulls.get({ owner: OWNER, repo: REPO, pull_number: PR_NUM });

  // 2) Get current file content and parent transaction from our system
  const repoBranchId = `${OWNER}/${REPO}#${BRANCH}`;
  const parentTxnSK = await getLatestVersionSK(repoBranchId);
  
  let previousContent = `# Changelog\n`;
  try {
    const { data: fileData } = await octo.repos.getContent({ owner: OWNER, repo: REPO, path: TARGET_FILE, ref: BRANCH });
    previousContent = Buffer.from(fileData.content, 'base64').toString('utf8');
  } catch (e) {
      if (e.status !== 404) throw e;
      console.log('CHANGELOG.md not found, starting with a new one.');
  }

  // 3) Generate a concise changelog summary with Gemini
  console.log('Generating changelog summary with Gemini...');
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
  const prompt = `Summarize this merged PR for a CHANGELOG entry (max 6 bullets, user-facing first). No fluff.\n\nRepo: ${OWNER}/${REPO}\nPR #${pr.number}: ${pr.title}\nAuthor: ${pr.user?.login}\nPR Body:\n${pr.body || '(no description)'}`;
  const result = await model.generateContent(prompt);
  const summary = result.response.text().trim();
  console.log('Generated Summary:\n', summary);

  // 4) Prepare the new state and transaction data
  const summaryBlock = [
    `## ${new Date().toISOString().slice(0,10)} – PR #${pr.number}: ${pr.title}`,
    summary,
    `*By @${pr.user?.login} • ${pr.html_url}*`,
  ].join('\n\n');

  const newFileContent = `${previousContent.trimEnd()}\n\n${summaryBlock}\n`;
  const newContentHash = getContentHash(newFileContent);
  const newTxnSK = `TXN#${new Date().toISOString()}#${PR_NUM}`;

  // 5) Update GitHub and our version history
  console.log(`Appending to ${TARGET_FILE} on branch ${BRANCH}...`);
  await updateGitHubFile({
    owner: OWNER, repo: REPO, branch: BRANCH, path: TARGET_FILE, newContent: newFileContent
  });
  console.log(`✅ Successfully updated ${TARGET_FILE} on GitHub.`);
  
  await updateVersionHistory({
    repoBranch: repoBranchId,
    newTxnSK,
    parentTxnSK,
    contentHash: newContentHash,
    prData: pr,
    summaryBlock,
  });

  console.log('✨ Process complete. Changelog updated and versioned.');

} catch (error) {
  console.error('\n❌ An error occurred during the entire process:', error.message);
  process.exit(1);
}