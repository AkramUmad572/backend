// manual-edit.js
import 'dotenv/config';
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
const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);
const DYNAMO_TABLE = process.env.DYNAMODB_TABLE_NAME;

(async () => {
  try {
    // 1. Create a new commit with the manual changes
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

    // 2. Record this as a "Manual Transaction" in DynamoDB
    const repoBranchId = `${OWNER}/${REPO}#${BRANCH}`;
    const { Item: parentItem } = await docClient.send(new GetCommand({ TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: 'HEAD' } }));
    const parentTxnSK = parentItem ? parentItem.latestTxnSK : 'ROOT';
    const newTxnSK = `TXN#${new Date().toISOString()}#MANUAL`;

    await docClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: DYNAMO_TABLE, Item: {
          RepoBranch: repoBranchId, SK: newTxnSK, parentTxnSK,
          type: 'MANUAL', manualCommitSha, author: AUTHOR, message: MESSAGE,
      }}},
      { Update: { TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: 'HEAD' },
          UpdateExpression: 'SET latestTxnSK = :sk', ExpressionAttributeValues: { ':sk': newTxnSK },
      }},
    ]}));
    console.log('✅ Recorded manual transaction in DocFlow.');
  } catch (error) {
    console.error(`\n❌ An error occurred during the manual edit: ${error.message}`);
    process.exit(1);
  }
})();