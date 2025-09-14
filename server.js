// server.js (ESM) — FULL FILE with robust exec logging
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Small helper to stream child output so nothing goes “silent”
function run(cmd, label) {
  console.log(`▶️  ${label}: ${cmd}`);
  const child = exec(cmd, { maxBuffer: 1024 * 1024 * 20, cwd: process.cwd(), env: process.env });
  child.stdout.on('data', d => process.stdout.write(`[${label} STDOUT] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${label} STDERR] ${d}`));
  child.on('close', code => console.log(`✅ ${label} exited with code ${code}`));
  child.on('error', err => console.error(`❌ ${label} failed to spawn:`, err));
  return child;
}

// Main webhook endpoint (GitHub → on PR merged)
// ... keep existing imports, middleware, and run() helper ...

app.post('/api/ingest', (req, res) => {
  const event = req.headers['x-github-event'];
  const delivery = req.headers['x-github-delivery'];
  console.log(`📨 Received GitHub webhook: ${event} (${delivery})`);

  if (event === 'ping') {
    console.log('🏓 Received ping event from GitHub');
    return res.status(200).json({ message: 'Ping received successfully' });
  }

  // ✅ Handle docs-only pushes (auto "manual" transaction)
  if (event === 'push') {
    const payload = req.body;
    const { head_commit, repository } = payload || {};
    if (!payload || !repository) {
      console.warn('⚠️ Malformed push payload.');
      return res.status(400).json({ error: 'Malformed payload' });
    }

    // ignore bot/self commits that include [skip-docflow]
    if (head_commit?.message?.includes('[skip-docflow]')) {
      console.log('🚫 Bot commit detected. Ignoring to prevent loop.');
      return res.status(200).json({ message: 'Bot commit ignored.' });
    }

    const owner = repository.owner.login;
    const repo = repository.name;
    const added = head_commit?.added || [];
    const modified = head_commit?.modified || [];
    const changedFiles = [...added, ...modified];

    // docs-only check
    const isDocsOnly = changedFiles.length > 0 && changedFiles.every(p => p.startsWith('docs/'));
    if (!isDocsOnly) {
      console.log('ℹ️ Push was not docs-only. No action taken.');
      return res.status(200).json({ message: 'Push ignored (not docs-only).' });
    }

    const author = head_commit?.author?.username || head_commit?.author?.name || 'unknown';
    const message = head_commit?.message || '';
    const commitSha = head_commit?.id;

    console.log(`📝 Docs-only push detected on ${owner}/${repo} @ ${commitSha?.slice(0,7)} — recording manual txn...`);

    // process-manual-commit.js: <owner> <repo> <authorJson> <messageJson> <commitSha>
    const cmd = `node process-manual-commit.js ${owner} ${repo} ${JSON.stringify(author)} ${JSON.stringify(message)} ${commitSha}`;
    run(cmd, 'process-manual-commit');

    return res.status(202).json({ message: 'Accepted: docs-only push processed.', commit: commitSha });
  }

  // Enhanced pull_request flow (generate READLOG and README on merge)
  if (event === 'pull_request') {
    // Handle both JSON and form-encoded payloads
    let payload = req.body;
    if (req.body.payload) {
      // GitHub sends form-encoded data with JSON in 'payload' field
      payload = JSON.parse(req.body.payload);
    }
    
    const { action, pull_request, repository } = payload;
    if (!pull_request || !repository) {
      console.warn('⚠️ Malformed pull_request payload.');
      return res.status(400).json({ error: 'Malformed payload' });
    }

    console.log(`PR Event: ${action} - PR #${pull_request.number}`);
    console.log(`PR Details: closed=${pull_request.closed}, closed_at=${pull_request.closed_at}, state=${pull_request.state}`);

    // Trigger when PR is closed (assuming it was merged since we can't distinguish)
    if (action === 'closed' && pull_request.state === 'closed') {
      console.log(`🎉 PR #${pull_request.number} was closed! Triggering changelog update...`);

      const owner = repository.owner.login;
      const repo = repository.name;
      const prNumber = pull_request.number;

      // Execute both changelog and README processing
      run(`node index.js ${owner} ${repo} ${prNumber}`, `READLOG-${prNumber}`);
      run(`node readme-processor.js ${owner} ${repo} ${prNumber}`, `README-${prNumber}`);

      return res.status(202).json({
        message: 'Accepted: PR close event received and changelog generation process started.',
        prNumber: prNumber,
      });
    } else {
      console.log(`ℹ️  PR #${pull_request.number} was ${action} but not closed. No action taken.`);
      return res.status(200).json({ message: 'Event received but not a close action.' });
    }
  }

  console.log(`ℹ️  Received unhandled event: ${event}`);
  return res.status(200).json({ message: `Event ${event} received but not handled.` });
});

app.post('/api/manual-edit', (req, res) => {
  const { owner, repo, author, message, filePath, newContent } = req.body || {};
  if (!owner || !repo || !author || !message || !filePath || typeof newContent !== 'string') {
    return res.status(400).json({ error: 'owner, repo, author, message, filePath, newContent are required' });
  }
  // Safely quote args that may contain spaces/newlines
  const cmd = `node manual-edit.js ${owner} ${repo} ${JSON.stringify(author)} ${JSON.stringify(message)} ${JSON.stringify(filePath)} ${JSON.stringify(newContent)}`;
  run(cmd, `manual-edit ${owner}/${repo}:${filePath}`);
  return res.status(202).json({ ok: true, owner, repo, filePath });
});

app.post('/api/revert', (req, res) => {
  const { owner, repo, transactionId } = req.body || {};
  if (!owner || !repo || !transactionId) {
    return res.status(400).json({ error: 'owner, repo, transactionId are required' });
  }

  const cmd = `node revert.js ${owner} ${repo} "${transactionId}"`;
  console.log(`▶️  Revert request: ${cmd}`);

  const child = run(cmd, `revert ${transactionId}`);
  res.status(202).json({
    message: 'Accepted: revert process started.',
    owner,
    repo,
    transactionId
  });
});

// Manual trigger endpoint (for PR + JIRA ticket)
app.post('/api/manual-ingest', (req, res) => {
  const { owner, repo, prNumber, jiraKey } = req.body || {};
  if (!owner || !repo || !prNumber) {
    return res.status(400).json({ error: 'owner, repo, prNumber are required' });
  }

  const cmd = `node index.js ${owner} ${repo} ${prNumber}${jiraKey ? ` ${jiraKey}` : ''}`;
  console.log(`▶️  Manual ingest: ${cmd}`);

  const child = run(cmd, `manual index.js PR#${prNumber}`);
  // Respond immediately; logs stream to server output
  res.status(200).json({ ok: true, prNumber, jiraKey: jiraKey || null });
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
