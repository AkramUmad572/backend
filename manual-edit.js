// manual-edit.js — dashboard edit (single file) → DynamoDB DOC_ONLY transaction (one hash)
import 'dotenv/config';
import crypto from 'crypto';
import { Octokit } from '@octokit/rest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const [OWNER, REPO, AUTHOR, MESSAGE, FILE_PATH, NEW_CONTENT] = process.argv.slice(2);
if (!OWNER || !REPO || !AUTHOR || !MESSAGE || !FILE_PATH || !NEW_CONTENT) {
  console.error('Usage: node manual-edit.js <owner> <repo> <author> "<message>" <filePath> "<newContent>"');
  process.exit(1);
}
const BRANCH = 'main';
const SKIP_FLAG = '[skip-docflow]';
const AWS_REGION   = process.env.AWS_REGION || 'us-east-1';
const DYNAMO_TABLE = process.env.DYNAMODB_TABLE_NAME;

const sha256 = (s) => crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');

function extractConceptKeyFromMessage(msg) {
  if (!msg) return null;
  const jira = msg.match(/([A-Z]{2,10}-\d+)/)?.[1];
  if (jira) return `JIRA:${jira}`;
  const pr = msg.match(/PR\s*#?(\d+)|pull\s*request\s*#?(\d+)/i);
  if (pr) return `PR#${pr[1] || pr[2]}`;
  return null;
}

const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
const dbClient = new DynamoDBClient({ region: AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);

(async () => {
  try {
    // 1) Create a new commit with the manual changes
    const { data: refData } = await octo.git.getRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}` });
    const { data: latestCommit } = await octo.git.getCommit({ owner: OWNER, repo: REPO, commit_sha: refData.object.sha });
    const { data: blob } = await octo.git.createBlob({ owner: OWNER, repo: REPO, content: NEW_CONTENT, encoding: 'utf-8' });
    const { data: newTree } = await octo.git.createTree({
      owner: OWNER, repo: REPO, base_tree: latestCommit.tree.sha,
      tree: [{ path: FILE_PATH, sha: blob.sha, type: 'blob', mode: '100644' }],
    });
    const commitMessage = `docs(manual): ${MESSAGE} by ${AUTHOR}\n\n${SKIP_FLAG}`;
    const { data: newCommit } = await octo.git.createCommit({
      owner: OWNER, repo: REPO, message: commitMessage, tree: newTree.sha, parents: [refData.object.sha]
    });
    await octo.git.updateRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}`, sha: newCommit.sha });
    const manualCommitSha = newCommit.sha;
    console.log(`✅ Pushed manual commit: ${manualCommitSha}`);

    // 2) Record in DynamoDB as DOC_ONLY (one hash)
    if (!DYNAMO_TABLE) {
      console.warn('⚠️ DYNAMODB_TABLE_NAME not set; skipping tx record.');
      return;
    }

    const repoBranchId = `${OWNER}/${REPO}#${BRANCH}`;
    const { Item: parentItem } = await docClient.send(new GetCommand({
      TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: 'HEAD' }
    }));
    const parentTxnSK = parentItem ? parentItem.latestTxnSK : 'ROOT';
    const newTxnSK = `TXN#${new Date().toISOString()}#DASHBOARD`;

    const docChangeHash = sha256(NEW_CONTENT);
    const conceptKey = extractConceptKeyFromMessage(MESSAGE) || null;

    await docClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: DYNAMO_TABLE, Item: {
            RepoBranch: repoBranchId, SK: newTxnSK, parentTxnSK,
            type: 'MANUAL_DASHBOARD_EDIT',
            txnKind: 'DOC_ONLY',                 // one hash, no parent change
            createdAt: new Date().toISOString(),
            manualCommitSha, author: AUTHOR, message: MESSAGE,
            filePath: FILE_PATH, blobSha: blob.sha,
            docChangeHash, docChangeType: 'UTF8_CONTENT_SHA256',
            parentChangeHash: null, parentChangeType: null,
            conceptKey,
            relatedConceptKeys: conceptKey ? [conceptKey] : []
        }}},
        { Put: { TableName: DYNAMO_TABLE, Item: { RepoBranch: repoBranchId, SK: 'HEAD', latestTxnSK: newTxnSK, updatedAt: new Date().toISOString() } } }
      ]
    }));

    console.log('✅ Recorded manual transaction in DocFlow.');
  } catch (error) {
    console.error(`\n❌ An error occurred during the manual edit: ${error.message}`);
    process.exit(1);
  }
})();
