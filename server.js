// server.js (Final Hackathon Version with Jira Logic)
import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import { exec } from 'child_process';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const SKIP_FLAG = '[skip-docflow]';

// Webhook endpoint for GitHub (listens for pushes to main)
app.post('/api/ingest', (req, res) => {
  const event = req.headers['x-github-event'];
  console.log(`📨 Received GitHub webhook: ${event}`);

  if (event === 'ping') {
    return res.status(200).json({ message: 'Ping received' });
  }

  if (event === 'push' && req.body.ref === 'refs/heads/main') {
    const { head_commit, repository } = req.body;
    if (!head_commit) {
      return res.status(200).json({ message: 'Push event ignored (no head_commit).' });
    }

    // THE CRITICAL LOOP PREVENTION CHECK
    if (head_commit.message.includes(SKIP_FLAG)) {
      console.log(`🚫 Bot commit detected. Ignoring to prevent loop.`);
      return res.status(200).json({ message: 'Bot commit ignored.' });
    }

    const prMatch = head_commit.message.match(/Merge pull request #(\d+)/);
    if (!prMatch) {
      console.log(`ℹ️ Push to main was not from a PR merge. Ignoring.`);
      return res.status(200).json({ message: 'Push was not a PR merge.' });
    }

    const prNumber = prMatch[1];
    const sourceCommitSha = head_commit.id;
    const owner = repository.owner.login;
    const repo = repository.name;

    console.log(`✅ Human PR #${prNumber} merged. Triggering AI documentation bot...`);

    const command = `node index.js ${owner} ${repo} ${prNumber} ${sourceCommitSha}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ Error executing index.js: ${error.message}\n${stderr}`);
        return;
      }
      if (stderr) console.warn(`stderr from index.js: ${stderr}`);
      console.log(`stdout from index.js:\n${stdout}`);
    });

    return res.status(202).json({ message: 'Accepted: AI documentation process started.' });
  }

  return res.status(200).json({ message: 'Event not processed.' });
});

// Manual trigger endpoint from your dashboard
app.post('/api/manual-ingest', (req, res) => {
    const { owner, repo, author, message, filePath, newContent } = req.body || {};
    if (!owner || !repo || !author || !message || !filePath || !newContent) {
        return res.status(400).json({ error: 'owner, repo, author, message, filePath, and newContent are required' });
    }

    // Use shell-safe quoting for arguments
    const command = `node manual-edit.js "${owner}" "${repo}" "${author}" "${message}" "${filePath}" "${newContent}"`;
    console.log(`▶️  Manual ingest: ${command}`);

    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ manual-edit.js error: ${error.message}\n${stderr}`);
            return res.status(500).json({ error: error.message, stderr });
        }
        if (stderr) console.warn(stderr);
        console.log(stdout);
        return res.status(200).json({ ok: true, output: stdout });
    });
});

// Health check and root endpoints
app.get('/api/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString() }));
app.get('/', (req, res) => res.json({ message: 'DocFlow API Webhook Server is running' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 DocFlow API Webhook Server running on port ${PORT}`));