// process-manual-commit.js
import 'dotenv/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

// --- CONFIGURATION ---
const [OWNER, REPO, AUTHOR_JSON, MESSAGE_JSON, COMMIT_SHA] = process.argv.slice(2);
if (!OWNER || !REPO || !AUTHOR_JSON || !MESSAGE_JSON || !COMMIT_SHA) {
  console.error('Usage: node process-manual-commit.js <owner> <repo> <authorJson> <messageJson> <commitSha>');
  process.exit(1);
}
// Parse the JSON-stringified arguments
const AUTHOR = JSON.parse(AUTHOR_JSON);
const MESSAGE = JSON.parse(MESSAGE_JSON);
const BRANCH = 'main';

// --- CLIENTS ---
const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);
const DYNAMO_TABLE = process.env.DYNAMODB_TABLE_NAME;

(async () => {
  try {
    // 1. Get the current HEAD of our DocFlow history to find the parent
    const repoBranchId = `${OWNER}/${REPO}#${BRANCH}`;
    const { Item: parentItem } = await docClient.send(new GetCommand({ TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: 'HEAD' } }));
    const parentTxnSK = parentItem ? parentItem.latestTxnSK : 'ROOT';
    const newTxnSK = `TXN#${new Date().toISOString()}#MANUAL`;

    // 2. Create and store a new "Manual Transaction" in DynamoDB
    console.log(`Recording manual commit ${COMMIT_SHA} as transaction ${newTxnSK}`);
    await docClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: DYNAMO_TABLE, Item: {
          RepoBranch: repoBranchId, SK: newTxnSK, parentTxnSK,
          type: 'MANUAL',
          manualCommitSha: COMMIT_SHA,
          author: AUTHOR,
          message: MESSAGE,
      }}},
      { Update: { TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: 'HEAD' },
          UpdateExpression: 'SET latestTxnSK = :sk', ExpressionAttributeValues: { ':sk': newTxnSK },
      }},
    ]}));
    console.log('✅ Recorded manual commit transaction in DocFlow.');

  } catch (error) {
    console.error(`\n❌ An error occurred while processing the manual commit: ${error.message}`);
    process.exit(1);
  }
})();