// server.js (Final Version with All API Endpoints)
import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

// --- INITIALIZATION ---
const app = express();
app.use(cors()); // Enable Cross-Origin Resource Sharing for your frontend
app.use(express.json({ limit: '10mb' }));

const SKIP_FLAG = '[skip-docflow]';
const DYNAMO_TABLE = process.env.DYNAMODB_TABLE_NAME;
const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);

// --- GITHUB WEBHOOK ENDPOINT (AUTOMATION) ---
app.post('/api/ingest', (req, res) => {
  const event = req.headers['x-github-event'];
  if (event === 'ping') return res.status(200).json({ message: 'Ping received' });

  if (event === 'push' && req.body.ref === 'refs/heads/main') {
    const { head_commit, repository } = req.body;
    if (!head_commit || head_commit.message.includes(SKIP_FLAG)) {
      const reason = !head_commit ? 'no head_commit' : 'bot commit detected';
      console.log(`🚫 Ingest ignored: ${reason}.`);
      return res.status(200).json({ message: `Ingest ignored: ${reason}` });
    }

    const prMatch = head_commit.message.match(/Merge pull request #(\d+)/);
    if (!prMatch) {
      console.log(`ℹ️ Push to main was not a PR merge. Ignoring.`);
      return res.status(200).json({ message: 'Push was not a PR merge.' });
    }

    const prNumber = prMatch[1];
    const sourceCommitSha = head_commit.id;
    const owner = repository.owner.login;
    const repo = repository.name;

    console.log(`✅ Human PR #${prNumber} merged. Triggering AI documentation bot...`);
    const command = `node index.js ${owner} ${repo} ${prNumber} ${sourceCommitSha}`;
    exec(command, (error, stdout, stderr) => {
      if (error) console.error(`❌ Error executing index.js: ${error.message}\n${stderr}`);
      else console.log(`stdout from index.js:\n${stdout}`);
    });

    return res.status(202).json({ message: 'Accepted: AI documentation process started.' });
  }

  return res.status(200).json({ message: 'Event not processed.' });
});

// --- API ENDPOINT TO FETCH HISTORY (FOR YOUR DASHBOARD) ---
app.get('/api/history/:owner/:repo', async (req, res) => {
    const { owner, repo } = req.params;
    const repoBranchId = `${owner}/${repo}#main`;

    console.log(`▶️  Fetching history for ${repoBranchId}`);
    try {
        const command = new QueryCommand({
            TableName: DYNAMO_TABLE,
            KeyConditionExpression: 'RepoBranch = :rb',
            ExpressionAttributeValues: { ':rb': repoBranchId },
            ScanIndexForward: false, // Return newest items first
        });
        const { Items } = await docClient.send(command);
        res.status(200).json(Items || []);
    } catch (error) {
        console.error(`❌ Failed to fetch history for ${repoBranchId}:`, error);
        res.status(500).json({ error: 'Failed to fetch history from DynamoDB.' });
    }
});

// --- API ENDPOINT FOR MANUAL EDITS (FROM YOUR DASHBOARD'S EDITOR) ---
app.post('/api/manual-edit', (req, res) => {
    const { owner, repo, author, message, filePath, newContent } = req.body;
    if (!owner || !repo || !author || !message || !filePath || !newContent) {
        return res.status(400).json({ error: 'owner, repo, author, message, filePath, and newContent are required' });
    }

    // Use JSON.stringify to safely pass arguments with spaces and special characters
    const command = `node manual-edit.js ${owner} ${repo} ${JSON.stringify(author)} ${JSON.stringify(message)} ${JSON.stringify(filePath)} ${JSON.stringify(newContent)}`;
    console.log(`▶️  Manual edit request: ${command}`);

    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ manual-edit.js error: ${error.message}\n${stderr}`);
            return res.status(500).json({ error: 'Failed to process manual edit.', details: stderr });
        }
        console.log(`✅ Manual edit successful:\n${stdout}`);
        res.status(200).json({ success: true, message: 'Manual edit processed successfully.', output: stdout });
    });
});

// --- API ENDPOINT FOR REVERTS (FROM YOUR DASHBOARD) ---
app.post('/api/revert', (req, res) => {
    const { owner, repo, transactionId } = req.body;
    if (!owner || !repo || !transactionId) {
        return res.status(400).json({ error: 'owner, repo, and transactionId are required' });
    }

    const command = `node revert.js ${owner} ${repo} "${transactionId}"`;
    console.log(`▶️  Revert request: ${command}`);

    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ revert.js error: ${error.message}\n${stderr}`);
            return res.status(500).json({ error: 'Failed to process revert.', details: stderr });
        }
        console.log(`✅ Revert successful:\n${stdout}`);
        res.status(200).json({ success: true, message: 'Revert processed successfully.', output: stdout });
    });
});

// --- HEALTH AND ROOT ENDPOINTS ---
app.get('/api/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString() }));
app.get('/', (req, res) => res.json({ message: 'DocFlow API Webhook Server is running' }));

// --- SERVER START ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 DocFlow API Webhook Server running on port ${PORT}`));