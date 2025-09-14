// revert.js (The Final Form - Semantic Cluster Revert)
import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Buffer } from 'node:buffer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

// --- CONFIGURATION AND CLIENTS ---
const [OWNER, REPO, TARGET_TXN_ID] = process.argv.slice(2);
if (!OWNER || !REPO || !TARGET_TXN_ID) {
    console.error('Usage: node revert.js <owner> <repo> <targetTransactionId>');
    process.exit(1);
}
const BRANCH = 'main';
const DOCS_DIR = 'docs';
const SKIP_FLAG = '[skip-docflow]';
const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);
const DYNAMO_TABLE = process.env.DYNAMODB_TABLE_NAME;

(async () => {
    try {
        const repoBranchId = `${OWNER}/${REPO}#${BRANCH}`;

        // 1. Get the transaction for the concept we want to revert
        const { Item: targetTxn } = await docClient.send(new GetCommand({
            TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: TARGET_TXN_ID }
        }));
        if (!targetTxn || targetTxn.type !== 'AI_GENERATED' || !targetTxn.originalCodeDiff || !targetTxn.botCommitSha) {
            throw new Error('This transaction is not a revertible concept (must be AI_GENERATED with a stored code diff).');
        }

        // 2. Fetch the "Conceptual Fingerprint": the original docs for the feature
        console.log('Fetching conceptual fingerprint from original documentation commit...');
        const { data: treeData } = await octo.git.getTree({ owner: OWNER, repo: REPO, tree_sha: targetTxn.botCommitSha, recursive: true });
        const docFilesFingerprint = treeData.tree.filter(f => f.path.startsWith(DOCS_DIR + '/'));
        let conceptualFingerprint = "";
        for (const doc of docFilesFingerprint) {
            const { data: content } = await octo.git.getBlob({ owner: OWNER, repo: REPO, file_sha: doc.sha });
            conceptualFingerprint += `\n\n--- FILE: ${doc.path} ---\n` + Buffer.from(content.content, 'base64').toString('utf8');
        }

        // 3. Get the complete CURRENT documentation
        console.log('Fetching current state of all documentation...');
        const { data: currentTreeData } = await octo.git.getTree({ owner: OWNER, repo: REPO, tree_sha: BRANCH, recursive: true });
        const currentDocFiles = currentTreeData.tree.filter(f => f.path.startsWith(DOCS_DIR + '/'));
        let currentDocs = "";
        for (const doc of currentDocFiles) {
            const { data: content } = await octo.git.getBlob({ owner: OWNER, repo: REPO, file_sha: doc.sha });
            currentDocs += `\n\n--- FILE: ${doc.path} ---\n` + Buffer.from(content.content, 'base64').toString('utf8');
        }

        // 4. The Master Prompt
        console.log('Asking AI to perform a deep semantic revert...');
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });
        const prompt = `You are an expert technical writer performing a conceptual revert. Your task is to remove an entire feature and all subsequent related edits from a large documentation set.
        Here is the full, CURRENT documentation:\n${currentDocs}
        Now, I will define the feature CONCEPT that needs to be completely erased. This concept was originally introduced with these code changes:
        --- CODE DIFF OF THE CONCEPT TO REMOVE ---\n${targetTxn.originalCodeDiff}
        And was originally described by this documentation, which acts as a "fingerprint" for the concept:
        --- DOCUMENTATION FINGERPRINT OF THE CONCEPT TO REMOVE ---\n${conceptualFingerprint}
        YOUR TASK: Rewrite the CURRENT documentation to completely remove the feature concept defined above. Your goal is to make it as if this feature never existed. This means you must:
        1. Remove the original documentation described in the fingerprint.
        2. Intelligently identify and REMOVE any subsequent manual edits, fixes, or additions that are clearly related to this same concept.
        3. Be extremely careful to PRESERVE all other unrelated features and documentation.
        Output ONLY the full, new file content for each file you need to change, enclosed in markdown code blocks with the file path.`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        // 5. Parse the response and create the final revert commit
        const updatedFileBlobs = [];
        const regex = /```markdown: (docs\/[^\s]+)\n([\s\S]*?)\n```/g;
        let match;
        while ((match = regex.exec(responseText)) !== null) {
            const path = match[1];
            const newContent = match[2];
            const { data: blob } = await octo.git.createBlob({ owner: OWNER, repo: REPO, content: newContent, encoding: 'utf-8' });
            updatedFileBlobs.push({ path, sha: blob.sha, type: 'blob', mode: '100644' });
        }
        if (updatedFileBlobs.length === 0) throw new Error('AI revert failed to produce any file changes.');

        const { data: refData } = await octo.git.getRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}` });
        const { data: newTree } = await octo.git.createTree({ owner: OWNER, repo: REPO, base_tree: refData.object.sha, tree: updatedFileBlobs });
        const commitMessage = `docs(revert): Conceptually revert feature from PR #${targetTxn.prNumber}\n\nReverts concept from ${targetTxn.SK}\n${SKIP_FLAG}`;
        const { data: newCommit } = await octo.git.createCommit({ owner: OWNER, repo: REPO, message: commitMessage, tree: newTree.sha, parents: [refData.object.sha] });
        await octo.git.updateRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}`, sha: newCommit.sha });
        console.log(`✅ Pushed semantic revert commit: ${newCommit.sha}`);

        // 6. Create a REVERT transaction in DynamoDB
        const { Item: parentItem } = await docClient.send(new GetCommand({ TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: 'HEAD' } }));
        const parentTxnSK = parentItem ? parentItem.latestTxnSK : 'ROOT';
        const newTxnSK = `TXN#${new Date().toISOString()}#REVERT`;

        await docClient.send(new TransactWriteCommand({ TransactItems: [
            { Put: { TableName: DYNAMO_TABLE, Item: {
                RepoBranch: repoBranchId, SK: newTxnSK, parentTxnSK, type: 'REVERT',
                revertedTxnSK: TARGET_TXN_ID, botCommitSha: newCommit.sha,
            }}},
            { Update: { TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: 'HEAD' },
                UpdateExpression: 'SET latestTxnSK = :sk', ExpressionAttributeValues: { ':sk': newTxnSK },
            }},
        ]}));
        console.log('✅ Recorded REVERT transaction in DocFlow.');

    } catch (error) {
        console.error(`\n❌ An error occurred during the conceptual revert: ${error.message}`);
        process.exit(1);
    }
})();