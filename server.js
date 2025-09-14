// server.js (ESM)
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { exec } from 'child_process';

const app = express();

// Middleware
app.use(express.json({ limit: '10mb' }));

// Main webhook endpoint (GitHub → on PR merged)
app.post('/api/ingest', (req, res) => {
  const event = req.headers['x-github-event'];
  const delivery = req.headers['x-github-delivery'];

  console.log(`📨 Received GitHub webhook: ${event} (${delivery})`);

  if (event === 'ping') {
    console.log('🏓 Received ping event from GitHub');
    return res.status(200).json({ message: 'Ping received successfully' });
  }

  if (event === 'pull_request') {
    const { action, pull_request, repository } = req.body;

    console.log(`PR Event: ${action} - PR #${pull_request.number}`);

    if (action === 'closed' && pull_request.merged) {
      console.log(`🎉 PR #${pull_request.number} was merged! Triggering changelog update...`);

      const owner = repository.owner.login;
      const repo = repository.name;
      const prNumber = pull_request.number;

      // Execute the index.js script as a child process
      const command = `node index.js ${owner} ${repo} ${prNumber}`;

      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error(`❌ Error executing index.js: ${error.message}`);
          console.error(`stderr: ${stderr}`);
          return;
        }
        if (stderr) {
          console.warn(`stderr from index.js: ${stderr}`);
        }
        console.log(`stdout from index.js:\n${stdout}`);
      });

      return res.status(202).json({
        message: 'Accepted: PR merge event received and changelog generation process started.',
        prNumber: prNumber,
      });
    } else {
      console.log(`ℹ️  PR #${pull_request.number} was ${action} but not a merge. No action taken.`);
      return res.status(200).json({ message: 'Event received but not a merge.' });
    }
  }

  console.log(`ℹ️  Received unhandled event: ${event}`);
  return res.status(200).json({ message: `Event ${event} received but not handled.` });
});

// Manual trigger endpoint (for PR + JIRA ticket)
app.post('/api/manual-ingest', (req, res) => {
  const { owner, repo, prNumber, jiraKey } = req.body || {};
  if (!owner || !repo || !prNumber) {
    return res.status(400).json({ error: 'owner, repo, prNumber are required' });
  }

  const cmd = `node index.js ${owner} ${repo} ${prNumber}${jiraKey ? ` ${jiraKey}` : ''}`;
  console.log(`▶️  Manual ingest: ${cmd}`);

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ index.js error: ${error.message}`);
      console.error(stderr);
      return res.status(500).json({ error: error.message, stderr });
    }
    if (stderr) console.warn(stderr);
    console.log(stdout);
    return res.status(200).json({ ok: true, prNumber, jiraKey: jiraKey || null, output: stdout });
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'DocFlow API Webhook Server is running',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 DocFlow API Webhook Server running on port ${PORT}`);
});
