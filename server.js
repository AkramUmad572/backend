// server.js (ESM) — FULL FILE with robust exec logging + optional README processor
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';

const app = express();

// ---- Config flags (environment) ----
const READMEBOT_AUTO = String(process.env.READMEBOT_AUTO || '').toLowerCase() === 'true'; // default: off

// ---- Middleware ----
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---- Helper: stream child output so nothing goes “silent” ----
function run(cmd, label) {
  console.log(`▶️  ${label}: ${cmd}`);
  const child = exec(cmd, { maxBuffer: 1024 * 1024 * 20, cwd: process.cwd(), env: process.env });
  child.stdout.on('data', d => process.stdout.write(`[${label} STDOUT] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${label} STDERR] ${d}`));
  child.on('close', code => console.log(`✅ ${label} exited with code ${code}`));
  child.on('error', err => console.error(`❌ ${label} failed to spawn:`, err));
  return child;
}

// ------------------------------------------------------------
// GitHub webhook entrypoint
// ------------------------------------------------------------
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
    const { repository } = payload || {};
    if (!payload || !repository) {
      console.warn('⚠️ Malformed push payload.');
      return res.status(400).json({ error: 'Malformed payload' });
    }

    // Aggregate all changed files across commits, not just head_commit
    const commits = Array.isArray(payload.commits) ? payload.commits : (payload.head_commit ? [payload.head_commit] : []);
    const changedFiles = commits.flatMap(c => [...(c.added || []), ...(c.modified || []), ...(c.removed || [])]);

    // ignore bot/self commits that include [skip-docflow]
    const hasSkipFlag = commits.some(c => (c.message || '').includes('[skip-docflow]'));
    if (hasSkipFlag) {
      console.log('🚫 Bot commit detected. Ignoring to prevent loop.');
      return res.status(200).json({ message: 'Bot commit(s) ignored.' });
    }

    // docs-only check
    const isDocsOnly = changedFiles.length > 0 && changedFiles.every(p => p.startsWith('docs/'));
    if (!isDocsOnly) {
      console.log('ℹ️ Push was not docs-only. No action taken.');
      return res.status(200).json({ message: 'Push ignored (not docs-only).' });
    }

    const owner = repository.owner?.login;
    const repo = repository.name;

    // Use the last commit for author/message/sha context
    const last = commits[commits.length - 1] || payload.head_commit || {};
    const author = last.author?.username || last.author?.name || 'unknown';
    const message = last.message || '';
    const commitSha = last.id;

    console.log(`📝 Docs-only push detected on ${owner}/${repo} @ ${commitSha?.slice(0,7)} — recording manual txn...`);

    // process-manual-commit.js: <owner> <repo> <authorJson> <messageJson> <commitSha>
    const cmd = `node process-manual-commit.js ${owner} ${repo} ${JSON.stringify(author)} ${JSON.stringify(message)} ${commitSha}`;
    run(cmd, 'process-manual-commit');

    return res.status(202).json({ message: 'Accepted: docs-only push processed.', commit: commitSha });
  }

  // Enhanced pull_request flow (generate READLOG on merge; README processor is opt-in)
  if (event === 'pull_request') {
    // Handle both JSON and form-encoded payloads
    let payload = req.body;
    if (req.body && req.body.payload) {
      // GitHub can send form-encoded data with JSON in 'payload' field
      try { payload = JSON.parse(req.body.payload); } catch { /* ignore */ }
    }

    const { action, pull_request, repository } = payload || {};
    if (!pull_request || !repository) {
      console.warn('⚠️ Malformed pull_request payload.');
      return res.status(400).json({ error: 'Malformed payload' });
    }

    console.log(`PR Event: ${action} - PR #${pull_request.number}`);
    console.log(`PR Details: merged=${pull_request.merged} closed=${pull_request.closed} state=${pull_request.state}`);

    // Trigger when PR is merged (GitHub sends action=closed with merged=true)
    if (action === 'closed' && pull_request.merged) {
      const owner = repository.owner.login;
      const repo = repository.name;
      const prNumber = pull_request.number;

      console.log(`🎉 PR #${prNumber} was merged! Triggering changelog update...`);
      run(`node index.js ${owner} ${repo} ${prNumber}`, `CHANGELOG-${prNumber}`);

      // README processor — opt-in only:
      //   1) Env flag READMEBOT_AUTO=true, OR
      //   2) PR has label "readme-bot", OR
      //   3) PR title/body contains "[readme-bot]"
      const labels = Array.isArray(pull_request.labels) ? pull_request.labels.map(l => l.name?.toLowerCase?.()) : [];
      const title = (pull_request.title || '').toLowerCase();
      const body  = (pull_request.body  || '').toLowerCase();
      const wantsReadme =
        READMEBOT_AUTO ||
        labels.includes('readme-bot') ||
        title.includes('[readme-bot]') ||
        body.includes('[readme-bot]');

      if (wantsReadme) {
        console.log('🧾 README processor enabled for this PR (flag/label/marker matched).');
        run(`node readme-processor.js ${owner} ${repo} ${prNumber}`, `README-${prNumber}`);
      } else {
        console.log('🧾 README processor skipped (no opt-in).');
      }

      return res.status(202).json({
        message: 'Accepted: PR merge event received; changelog generation started.',
        prNumber
      });
    }

    console.log(`ℹ️  PR #${pull_request.number} was ${action} but not a merge. No action taken.`);
    return res.status(200).json({ message: 'Event received but not a merge.' });
  }

  console.log(`ℹ️  Received unhandled event: ${event}`);
  return res.status(200).json({ message: `Event ${event} received but not handled.` });
});

// ------------------------------------------------------------
// Manual single-file edit (dashboard) → calls manual-edit.js
// ------------------------------------------------------------
app.post('/api/manual-edit', (req, res) => {
  const { owner, repo, author, message, filePath, newContent } = req.body || {};
  if (!owner || !repo || !author || !message || !filePath || typeof newContent !== 'string') {
    return res.status(400).json({ error: 'owner, repo, author, message, filePath, newContent are required' });
  }
  const cmd = `node manual-edit.js ${owner} ${repo} ${JSON.stringify(author)} ${JSON.stringify(message)} ${JSON.stringify(filePath)} ${JSON.stringify(newContent)}`;
  run(cmd, `manual-edit ${owner}/${repo}:${filePath}`);
  return res.status(202).json({ ok: true, owner, repo, filePath });
});

// ------------------------------------------------------------
// Manual README processor trigger (optional, on-demand)
// ------------------------------------------------------------
app.post('/api/readme-process', (req, res) => {
  const { owner, repo, prNumber } = req.body || {};
  if (!owner || !repo || !prNumber) {
    return res.status(400).json({ error: 'owner, repo, prNumber are required' });
  }
  run(`node readme-processor.js ${owner} ${repo} ${prNumber}`, `README-${prNumber}`);
  return res.status(202).json({ ok: true, owner, repo, prNumber });
});

// ------------------------------------------------------------
// Revert endpoint
// ------------------------------------------------------------
app.post('/api/revert', (req, res) => {
  const { owner, repo, transactionId } = req.body || {};
  if (!owner || !repo || !transactionId) {
    return res.status(400).json({ error: 'owner, repo, transactionId are required' });
  }

  const cmd = `node revert.js ${owner} ${repo} "${transactionId}"`;
  console.log(`▶️  Revert request: ${cmd}`);

  run(cmd, `revert ${transactionId}`);
  return res.status(202).json({
    message: 'Accepted: revert process started.',
    owner,
    repo,
    transactionId
  });
});

// ------------------------------------------------------------
// Manual PR ingest trigger (optionally with jiraKey)
// ------------------------------------------------------------
app.post('/api/manual-ingest', (req, res) => {
  const { owner, repo, prNumber, jiraKey } = req.body || {};
  if (!owner || !repo || !prNumber) {
    return res.status(400).json({ error: 'owner, repo, prNumber are required' });
  }

  const cmd = `node index.js ${owner} ${repo} ${prNumber}${jiraKey ? ` ${jiraKey}` : ''}`;
  console.log(`▶️  Manual ingest: ${cmd}`);

  run(cmd, `manual index.js PR#${prNumber}`);
  return res.status(202).json({ ok: true, prNumber, jiraKey: jiraKey || null });
});

// ------------------------------------------------------------
// Changelog polling endpoints
// ------------------------------------------------------------
app.get('/api/changelogs/pending', async (req, res) => {
  try {
    // Query DynamoDB for recent changelog entries
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000); // Last 2 hours
    
    // For now, mock response - in production this would query your DynamoDB table
    const mockPendingChangelogs = [
      {
        id: `changelog-company-frontend-app-${Date.now()}`,
        owner: 'company',
        repo: 'frontend-app', 
        prNumber: 123,
        title: 'CHANGELOG.md - PR #123: Add new feature',
        status: 'draft',
        createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
        type: 'changelog'
      },
      {
        id: `changelog-company-backend-api-${Date.now() + 1}`,
        owner: 'company',
        repo: 'backend-api',
        prNumber: 124, 
        title: 'CHANGELOG.md - PR #124: Authentication updates',
        status: 'draft',
        createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 min ago
        type: 'changelog'
      }
    ];
    
    res.json(mockPendingChangelogs);
  } catch (error) {
    console.error('Error fetching pending changelogs:', error);
    res.status(500).json({ error: 'Failed to fetch changelogs' });
  }
});

app.get('/api/changelog/:owner/:repo/content', async (req, res) => {
  const { owner, repo } = req.params;
  const { branch = 'main' } = req.query;
  
  try {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) {
      return res.status(500).json({ error: 'GitHub token not configured' });
    }

    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/CHANGELOG.md?ref=${encodeURIComponent(branch)}`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'DocFlow-API'
      }
    });

    if (response.status === 404) {
      // Return mock changelog content for demo
      const mockContent = `# Changelog

## PR #${Math.floor(Math.random() * 200)}: ${repo} Updates

*Merged:* ${new Date().toISOString().split('T')[0]} • *Author:* developer • *Base:* main ← *Head:* feature-branch

### Summary
**Gemini-generated summary:** This PR introduces significant improvements to the ${repo} system, including enhanced authentication mechanisms and improved user experience features.

### Technical Changes
- Add multi-factor authentication support
- Implement JWT token refresh mechanism  
- Update user interface components
- Refactor authentication middleware
- Add comprehensive test coverage
- Update API documentation

### Risks / Edge Cases
- Monitor authentication flow performance during peak usage
- Validate MFA compatibility across different devices
- Test token refresh behavior under network interruptions

### Rollback Plan
- Use GitHub "Revert" on PR #${Math.floor(Math.random() * 200)} (auto-creates a revert PR).
- Disable MFA feature flag if issues arise
- Restore previous authentication endpoints if needed

### Docs / Follow-ups
- Update user authentication guide
- Create MFA setup tutorial for end users
- Schedule security audit review meeting

### Links
- PR: https://github.com/${owner}/${repo}/pull/${Math.floor(Math.random() * 200)}
- Diff: https://github.com/${owner}/${repo}/compare/main...feature-branch

---
`;
      return res.json({ content: mockContent, sha: 'mock-sha-' + Date.now() });
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`GitHub API error: ${response.status} - ${errorText}`);
      return res.status(response.status).json({ 
        error: 'Failed to fetch from GitHub',
        details: errorText
      });
    }

    const data = await response.json();
    
    if (Array.isArray(data)) {
      return res.status(400).json({ error: 'CHANGELOG.md is a directory, not a file' });
    }

    const content = Buffer.from(data.content, 'base64').toString('utf8');
    
    res.json({ content, sha: data.sha });
  } catch (error) {
    console.error('Error fetching changelog content:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// ------------------------------------------------------------
// Health + Root
// ------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ message: 'DocFlow API Webhook Server is running' });
});

// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 DocFlow API Webhook Server running on port ${PORT}`);
  console.log(`ℹ️  README auto mode: ${READMEBOT_AUTO ? 'ENABLED' : 'DISABLED'} (toggle with READMEBOT_AUTO=true)`);
});
