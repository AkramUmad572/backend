// revert.js (ESM) — FULL FILE
import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import { Buffer } from 'node:buffer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// --- CONFIGURATION ---
const [OWNER, REPO, TARGET_TXN_ID] = process.argv.slice(2);
if (!OWNER || !REPO || !TARGET_TXN_ID) {
  console.error('Usage: node revert.js <owner> <repo> <targetTransactionId>');
  console.error('Example: node revert.js jwlebert htn25-test "TXN#2025-09-14T02:06:25.774Z#1"');
  process.exit(1);
}
const TARGET_FILE = 'CHANGELOG.md';
const BRANCH = 'main';

// --- CLIENT INITIALIZATION ---
const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);
const DYNAMO_TABLE = process.env.DYNAMODB_TABLE_NAME;

/**
 * Creates a revert commit on the target branch via the GitHub API.
 * Note: This is a simplified revert that resets the tree to the first parent’s tree.
 * In complex repos you may prefer creating a true revert diff via git plumbing.
 */
async function revertGitCommit(mergeCommitSha, prTitle) {
  console.log(`Attempting to revert Git commit: ${mergeCommitSha}`);
  try {
    const { data: refData } = await octo.git.getRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}` });
    const parentCommitSha = refData.object.sha;

    const { data: commitToRevert } = await octo.git.getCommit({ owner: OWNER, repo: REPO, commit_sha: mergeCommitSha });
    if (commitToRevert.parents.length < 1) {
      throw new Error('The target commit has no parents and cannot be reverted this way.');
    }

    // Use the first parent’s tree as a target (approximation of a revert)
    const { data: parentCommit } = await octo.git.getCommit({ owner: OWNER, repo: REPO, commit_sha: commitToRevert.parents[0].sha });
    const treeSha = parentCommit.tree.sha;

    const { data: newCommit } = await octo.git.createCommit({
      owner: OWNER,
      repo: REPO,
      message: `Revert: "${prTitle}"\n\nThis reverts commit ${mergeCommitSha}.`,
      tree: treeSha,
      parents: [parentCommitSha],
    });

    await octo.git.updateRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}`, sha: newCommit.sha });
    console.log(`✅ Successfully created Git revert commit: ${newCommit.sha}`);
    return newCommit.sha;
  } catch (error) {
    console.error('❌ Failed to create Git revert commit.', error);
    throw new Error('Git revert operation failed. Check for merge conflicts or permissions.');
  }
}

/**
 * Traverses the history to reconstruct the file content for a specific state.
 * Assumes each transaction stored a "summary" block that should be concatenated in order.
 */
async function rebuildContentFromHistory(repoBranch, targetTxnSK) {
  console.log(`Rebuilding file content for state: ${targetTxnSK}`);
  let currentTxnSK = targetTxnSK;
  const summaryBlocks = [];
  while (currentTxnSK && currentTxnSK !== 'ROOT') {
    const { Item } = await docClient.send(new GetCommand({ TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranch, SK: currentTxnSK } }));
    if (!Item) throw new Error(`FATAL: Transaction ${currentTxnSK} not found.`);
    if (Item.summary) summaryBlocks.unshift(Item.summary);
    currentTxnSK = Item.parentTxnSK;
  }
  const rebuiltContent = `# Changelog\n\n${summaryBlocks.join('\n\n')}\n`;
  console.log('✅ Content successfully rebuilt.');
  return rebuiltContent;
}

/**
 * Force-updates a file on GitHub with the specified content.
 */
async function pushContentToGitHub(content, revertCommitSha) {
  console.log(`Pushing reverted doc content to ${OWNER}/${REPO}/${TARGET_FILE}...`);
  const { data } = await octo.repos.getContent({ owner: OWNER, repo: REPO, path: TARGET_FILE, ref: BRANCH }).catch(() => ({ data: null }));
  const sha = data && !Array.isArray(data) ? data.sha : undefined;

  await octo.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: TARGET_FILE,
    message: `docs: revert changelog to version ${TARGET_TXN_ID}\n\nCorresponds to Git revert ${revertCommitSha}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: BRANCH,
    ...(sha ? { sha } : {})
  });
  console.log('✅ GitHub documentation file successfully updated.');
}

/**
 * Updates the HEAD pointer in DynamoDB to the target transaction.
 */
async function updateHeadPointer(repoBranch) {
  console.log(`Updating HEAD pointer to ${TARGET_TXN_ID}...`);
  await docClient.send(new UpdateCommand({
    TableName: DYNAMO_TABLE,
    Key: { RepoBranch: repoBranch, SK: 'HEAD' },
    UpdateExpression: 'SET latestTxnSK = :sk, updatedAt = :ts',
    ExpressionAttributeValues: { ':sk': TARGET_TXN_ID, ':ts': new Date().toISOString() },
  }));
  console.log('✅ DynamoDB HEAD pointer updated.');
}

// --- MAIN EXECUTION LOGIC ---
(async () => {
  try {
    const repoBranchId = `${OWNER}/${REPO}#${BRANCH}`;

    const { Item: targetTxn } = await docClient.send(new GetCommand({
      TableName: DYNAMO_TABLE,
      Key: { RepoBranch: repoBranchId, SK: TARGET_TXN_ID },
    }));
    if (!targetTxn) throw new Error(`Transaction ${TARGET_TXN_ID} not found.`);
    if (!targetTxn.mergeCommitSha) throw new Error(`Cannot perform Git revert. Transaction ${TARGET_TXN_ID} is missing the mergeCommitSha.`);

    // Step 1: Git revert first. If it fails, we stop.
    const revertCommitSha = await revertGitCommit(targetTxn.mergeCommitSha, targetTxn.prTitle || '(no title)');
    // Step 2: Reconstruct documentation content.
    const contentToRestore = await rebuildContentFromHistory(repoBranchId, TARGET_TXN_ID);
    // Step 3: Push documentation change.
    await pushContentToGitHub(contentToRestore, revertCommitSha);
    // Step 4: Update documentation HEAD pointer.
    await updateHeadPointer(repoBranchId);

    console.log(`\n✨ Synchronized revert to ${TARGET_TXN_ID} completed successfully!`);
  } catch (error) {
    console.error(`\n❌ An error occurred during the revert process: ${error.message}`);
    process.exit(1);
  }
})();
