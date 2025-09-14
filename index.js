// index.js (ESM) — FULL FILE with Gemini SDK + model fallback + robust GitHub/JIRA helpers
import dotenv from 'dotenv';
dotenv.config();

import { Buffer } from 'node:buffer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetchImport from 'node-fetch';

// Ensure fetch exists in Node environments < 18
const fetchFn = (typeof fetch !== 'undefined') ? fetch : fetchImport;

// -------------------- ENV --------------------
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_API_TOKEN;

const JIRA_BASE_URL  = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
const JIRA_EMAIL     = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || process.env.JIRA_API_KEY;

// -------------------- ARGS --------------------
const [,, owner, repo, prNumberArg, jiraKeyArg] = process.argv;
if (!owner || !repo || !prNumberArg) {
  console.error('Usage: node index.js <owner> <repo> <prNumber> [jiraKey]');
  process.exit(1);
}
const prNumber = Number(prNumberArg);

// -------------------- UTILS --------------------
function firstNonEmpty(...arr) {
  return arr.find(v => typeof v === 'string' && v.trim().length > 0) || null;
}
function truncate(str, n = 600) {
  if (!str) return '';
  return str.length <= n ? str : str.slice(0, n).trimEnd() + '…';
}
function pickTopCommitBullets(commits, n = 5) {
  const msgs = (commits || []).map(c => c.commit?.message || c.message || '').filter(Boolean);
  const firstLines = msgs.map(m => m.split('\n')[0])
    .filter(m => !/^Merge /i.test(m))
    .filter(m => m.length > 3);
  const unique = Array.from(new Set(firstLines));
  return unique.slice(0, n).map(m => `- ${m}`);
}
function isoDateOnly(s) {
  try { return (new Date(s)).toISOString().slice(0,10); } catch { return 'unknown'; }
}

// -------------------- GITHUB HELPERS --------------------
const ghHeaders = () => {
  if (!GITHUB_TOKEN) {
    console.error('❌ Missing GITHUB_TOKEN env var');
    process.exit(1);
  }
  return {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'DocFlow'
  };
};

async function getPR(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  const r = await fetchFn(url, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub getPR failed: ${r.status} ${r.statusText}`);
  return r.json();
}

async function getPRCommits(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits`;
  const r = await fetchFn(url, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub getPRCommits failed: ${r.status} ${r.statusText}`);
  return r.json();
}

async function upsertFile({ owner, repo, path, content, message, branch }) {
  const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`;
  let sha = null;

  const getRes = await fetchFn(getUrl, { headers: ghHeaders() });
  if (getRes.ok) {
    const existing = await getRes.json();
    // If repo is empty or file is binary, guard content access
    if (existing && existing.sha) sha = existing.sha;
  }

  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
    ...(branch ? { branch } : {})
  };

  const putRes = await fetchFn(getUrl.replace(/\?ref=.*$/, ''), {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!putRes.ok) {
    const text = await putRes.text().catch(() => '');
    throw new Error(`GitHub upsertFile failed: ${putRes.status} ${putRes.statusText} | ${text}`);
  }

  return putRes.json();
}

// -------------------- JIRA HELPER --------------------
async function getJiraIssue(jiraKey) {
  if (!jiraKey) return null;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    console.warn('⚠️ JIRA env not set; skipping JIRA fetch');
    return null;
  }
  const url = `${JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(jiraKey)}`;
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  const r = await fetchFn(url, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json'
    }
  });

  if (!r.ok) {
    console.warn(`⚠️ JIRA fetch failed for ${jiraKey}: ${r.status} ${r.statusText}`);
    return null;
  }

  const data = await r.json();

  let description = 'No description';
  const adf = data?.fields?.description;
  if (typeof adf === 'string') {
    description = adf;
  } else if (adf?.content?.length) {
    try {
      description = adf.content
        .flatMap(block => (block.content || []).map(i => i.text).filter(Boolean))
        .filter(Boolean)
        .join('\n') || 'No description';
    } catch {
      description = 'No description';
    }
  }

  return {
    key: data?.key,
    summary: data?.fields?.summary || 'No summary',
    status: data?.fields?.status?.name || 'Unknown',
    priority: data?.fields?.priority?.name || 'None',
    issueType: data?.fields?.issuetype?.name || 'Task',
    assignee: data?.fields?.assignee?.displayName || 'Unassigned',
    reporter: data?.fields?.reporter?.displayName || 'Unknown',
    description
  };
}

// -------------------- GEMINI (SDK with fallback) --------------------
async function summarizeWithGemini({ title, body, commits, jira }) {
  if (!GEMINI_API_KEY) {
    console.warn('⚠️ No GEMINI_API_KEY; skipping LLM summary');
    return null;
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  const prompt = `
Summarize this pull request and (if present) its related JIRA ticket into concise, doc-ready Markdown.

PR Title: ${title}
PR Description: ${body || '(none)'}
Commits:
${(commits || []).map((c, i) => `${i + 1}. ${c.commit?.message || c.message || ''}`).join('\n')}

${jira ? `JIRA: ${jira.key} — ${jira.summary}
Status: ${jira.status} | Priority: ${jira.priority}
Description:
${jira.description}` : 'No JIRA provided.'}

Return sections:
1. **Summary**
2. **Technical Changes**
3. **Risks/Edge Cases**
4. **Docs/Follow-ups**
`.trim();

  // Try modern models in order; fall back if one isn't available in your project/region.
  const MODEL_CANDIDATES = [
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro',
    'gemini-1.0-pro'
  ];

  for (const modelName of MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1200 }
      });
      const text = result?.response?.text?.();
      if (text && text.trim()) return text.trim();
    } catch (err) {
      console.warn(`⚠️ Gemini model failed (${modelName}): ${err?.message || err}`);
    }
  }

  console.warn('⚠️ All Gemini model attempts failed; using fallback summary.');
  return null;
}

// -------------------- RENDERER (HOUSE STYLE) --------------------
function renderChangelogEntry({ pr, commits, jira, llm }) {
  const mergedAt = pr.merged_at || pr.updated_at || new Date().toISOString();
  const author   = pr.user?.login || 'unknown';
  const base     = pr.base?.ref || 'main';
  const head     = pr.head?.ref || 'HEAD';

  const prUrl = pr.html_url ||
    `https://github.com/${pr.base?.repo?.owner?.login}/${pr.base?.repo?.name}/pull/${pr.number}`;
  const compareUrl = (pr.base?.repo && pr.base?.sha && pr.head?.sha)
    ? `https://github.com/${pr.base.repo.owner.login}/${pr.base.repo.name}/compare/${pr.base.sha}...${pr.head.sha}`
    : (pr.base?.repo
        ? `https://github.com/${pr.base.repo.owner.login}/${pr.base.repo.name}/compare/${base}...${head}`
        : null);

  const fallbackSummary = truncate(firstNonEmpty(pr.body, pr.title, 'No summary provided.'));
  const summary = (llm && llm.trim())
    ? llm.trim()
    : `**LLM disabled or unavailable.**\n\n${fallbackSummary}`;

  const techBullets = pickTopCommitBullets(commits, 6);
  const techSection = techBullets.length ? techBullets.join('\n') : '- See diff for details.';

  const jiraBlock = jira ? [
    `### JIRA`,
    `- **${jira.key} — ${jira.summary}** • Status: ${jira.status} • Priority: ${jira.priority}`,
    jira.description ? truncate(jira.description, 800) : '',
    ''
  ].join('\n') : '';

  return [
    `## PR #${pr.number}: ${pr.title}`,
    `*Merged:* ${isoDateOnly(mergedAt)} • *Author:* ${author} • *Base:* ${base} ← *Head:* ${head}`,
    ``,
    `### Summary`,
    summary,
    ``,
    `### Technical Changes`,
    techSection,
    ``,
    `### Risks / Edge Cases`,
    `- (fill in if applicable; e.g., migration, perf, feature flag rollout)`,
    ``,
    `### Rollback Plan`,
    `- Use GitHub “Revert” on PR #${pr.number} (auto-creates a revert PR).`,
    `- Undo any external side effects (migrations/config/docs).`,
    ``,
    `### Docs / Follow-ups`,
    `- (list docs to update or follow-up tasks/tickets/owners)`,
    ``,
    jiraBlock,
    `### Links`,
    `- PR: ${prUrl}`,
    compareUrl ? `- Diff: ${compareUrl}` : null,
    ``,
    `---`,
    ``
  ].filter(Boolean).join('\n');
}

// -------------------- MAIN --------------------
(async () => {
  try {
    console.log(`🔧 Processing ${owner}/${repo} PR #${prNumber}${jiraKeyArg ? ` with JIRA ${jiraKeyArg}` : ''} ...`);

    const pr = await getPR(owner, repo, prNumber);
    const commits = await getPRCommits(owner, repo, prNumber);

    const jira = jiraKeyArg ? await getJiraIssue(jiraKeyArg) : null;

    const llm = await summarizeWithGemini({
      title: pr.title,
      body: pr.body,
      commits,
      jira
    });

    const section = renderChangelogEntry({ pr, commits, jira, llm });

    const PATH = 'READLOG.md';
    let existing = '';
    const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(PATH)}`;
    const getRes = await fetchFn(getUrl, { headers: ghHeaders() });
    if (getRes.ok) {
      const blob = await getRes.json();
      if (blob?.content) {
        existing = Buffer.from(blob.content, 'base64').toString('utf8');
      } else {
        existing = '# Release / Change Log\n\n';
      }
    } else {
      existing = '# Release / Change Log\n\n';
    }

    const newContent = [section, existing].join('\n');
    const result = await upsertFile({
      owner, repo,
      path: PATH,
      content: newContent,
      message: `docs(readlog): add PR #${prNumber}${jira ? ` + ${jira.key}` : ''}`,
      branch: pr.base?.ref || 'main'
    });

    console.log(`✅ Updated ${PATH} at ${result?.content?.html_url || '(unknown URL)'}`);
  } catch (err) {
    console.error('❌ Failed:', err);
    process.exit(1);
  }
})();
