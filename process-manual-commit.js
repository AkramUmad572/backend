// process-manual-commit.js — docs-only push → DynamoDB DOC_ONLY transaction (one hash)
import 'dotenv/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { Octokit } from '@octokit/rest';
import crypto from 'crypto';

const [OWNER, REPO, AUTHOR_JSON, MESSAGE_JSON, COMMIT_SHA] = process.argv.slice(2);
if (!OWNER || !REPO || !AUTHOR_JSON || !MESSAGE_JSON || !COMMIT_SHA) {
  console.error('Usage: node process-manual-commit.js <owner> <repo> <authorJson> <messageJson> <commitSha>');
  process.exit(1);
}

const BRANCH = 'main';
const AWS_REGION   = process.env.AWS_REGION || 'us-east-1';
const DYNAMO_TABLE = process.env.DYNAMODB_TABLE_NAME;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const AUTHOR = JSON.parse(AUTHOR_JSON);
const MESSAGE = JSON.parse(MESSAGE_JSON);

const sha256 = (s) => crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');

function extractConceptKeyFromMessage(msg) {
  if (!msg) return null;
  const jira = msg.match(/([A-Z]{2,10}-\d+)/)?.[1];
  if (jira) return `JIRA:${jira}`;
  const pr = msg.match(/PR\s*#?(\d+)|pull\s*request\s*#?(\d+)/i);
  if (pr) return `PR#${pr[1] || pr[2]}`;
  return null;
}

// --- CLIENTS ---
const dbClient = new DynamoDBClient({ region: AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);
const octo = new Octokit({ auth: GITHUB_TOKEN });

async function getCommitDiff(owner, repo, sha) {
  const { data, status } = await octo.request('GET /repos/{owner}/{repo}/commits/{ref}', {
    owner, repo, ref: sha,
    headers: { accept: 'application/vnd.github.v3.diff' }
  });
  if (status !== 200 || typeof data !== 'string') {
    throw new Error(`Failed to fetch commit diff: ${status}`);
  }
  return data;
}

(async () => {
  try {
    if (!DYNAMO_TABLE) {
      console.warn('⚠️ DYNAMODB_TABLE_NAME not set; skipping tx record.');
      return;
    }
    const repoBranchId = `${OWNER}/${REPO}#${BRANCH}`;
    const { Item: parentHead } = await docClient.send(new GetCommand({
      TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: 'HEAD' }
    }));
    const parentTxnSK = parentHead ? parentHead.latestTxnSK : 'ROOT';
    const newTxnSK = `TXN#${new Date().toISOString()}#MANUAL#${COMMIT_SHA.slice(0,7)}`;

    // One hash for docs-only change (use diff of the commit)
    let diffText = '';
    try {
      diffText = await getCommitDiff(OWNER, REPO, COMMIT_SHA);
    } catch (e) {
      console.warn(`⚠️ Could not fetch diff for ${COMMIT_SHA}: ${e.message}. Falling back to message-only hash.`);
      diffText = `commit:${COMMIT_SHA}\nmessage:${MESSAGE}\n`;
    }
    const docHash = sha256(diffText);
    const conceptKey = extractConceptKeyFromMessage(MESSAGE) || null;

    const txnItem = {
      RepoBranch: repoBranchId,
      SK: newTxnSK,
      parentTxnSK,
      type: 'MANUAL_DOCS_PUSH',
      txnKind: 'DOC_ONLY',              // one hash, no parent change
      createdAt: new Date().toISOString(),

      commitSha: COMMIT_SHA,
      author: AUTHOR,
      message: MESSAGE,

      parentChangeHash: null,
      parentChangeType: null,
      docChangeHash: docHash,
      docChangeType: 'GITHUB_COMMIT_DIFF_SHA256',

      conceptKey,
      relatedConceptKeys: conceptKey ? [conceptKey] : []
    };

    await docClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: DYNAMO_TABLE, Item: txnItem } },
        { Put: { TableName: DYNAMO_TABLE, Item: { RepoBranch: repoBranchId, SK: 'HEAD', latestTxnSK: newTxnSK, updatedAt: new Date().toISOString() } } }
      ]
    }));

    console.log(`✅ Recorded manual docs transaction ${newTxnSK} (parent=${parentTxnSK})`);
  } catch (error) {
    console.error(`\n❌ An error occurred while processing the manual commit: ${error.message}`);
    process.exit(1);
  }
})();
