// index.js (ESM) — PR merge → CHANGELOG append + DynamoDB PAIR transaction (two hashes) + docs/ generation
import dotenv from 'dotenv';
dotenv.config();

import { Buffer } from 'node:buffer';
import crypto from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetchImport from 'node-fetch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

// Ensure fetch exists in Node environments < 18
const fetchFn = (typeof fetch !== 'undefined') ? fetch : fetchImport;

// -------------------- ENV --------------------
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_API_TOKEN;

const JIRA_BASE_URL  = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
const JIRA_EMAIL     = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || process.env.JIRA_API_KEY;

const AWS_REGION     = process.env.AWS_REGION || 'us-east-1';
const DYNAMO_TABLE   = process.env.DYNAMODB_TABLE_NAME;

// New: docs generation settings (non-breaking additions)
const DOCS_DIR             = process.env.DOCS_DIR || 'docs';
const DOC_LOG_FILE         = process.env.DOC_LOG_FILE || 'CHANGELOG.md';
const DOCS_AUTO            = String(process.env.DOCS_AUTO || 'true').toLowerCase() !== 'false'; // default on
const DOCS_MAX_FILES       = Number(process.env.DOCS_MAX_FILES || 6);  // upper bound for safety
const DOCS_MODEL_CANDIDATES = (process.env.DOCS_MODEL_CANDIDATES || 'gemini-2.5-pro,gemini-1.5-pro,gemini-1.5-flash,gemini-1.5-flash-latest,gemini-1.0-pro')
  .split(',').map(s => s.trim()).filter(Boolean);

// -------------------- ARGS --------------------
const [,, owner, repo, prNumberArg, jiraKeyArg] = process.argv;
if (!owner || !repo || !prNumberArg) {
  console.error('Usage: node index.js <owner> <repo> <prNumber> [jiraKey]');
  process.exit(1);
}
const prNumber = Number(prNumberArg);

// -------------------- UTILS --------------------
const sha256 = (s) => crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');

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

// Lightweight heuristic to detect "docs-worthy" changes from diff text
function extractDocsSignalsFromDiff(diffText = '') {
  const lines = (diffText || '').split('\n');
  const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const removed = lines.filter(l => l.startsWith('-') && !l.startsWith('---'));
  const signals = {
    apis: [],           // e.g., new endpoints
    env: [],            // environment variables
    cli: [],            // CLI flags/commands
    config: [],         // config keys
    types: [],          // exported types/interfaces/classes
    functions: [],      // exported/def functions or signatures
    pythonFunctions: [],// python def signatures
    pythonClasses: [],  // python class additions
    breaking: false,    // indicative of breaking changes
    fileHints: []       // file/module hints that look core
  };

  const pushMatch = (arr, regex, line, pickIndex = 1) => {
    const m = line.match(regex);
    if (m && m[pickIndex]) arr.push(m[pickIndex]);
  };

  for (const l of added) {
    // generic web/API style endpoints
    pushMatch(signals.apis, /\b(router|app)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/i, l, 3);
    pushMatch(signals.apis, /\bpath:\s*['"`]([^'"`]+)['"`]\s*,\s*method:\s*['"`](get|post|put|patch|delete)['"`]/i, l, 1);

    // env/config/cli
    pushMatch(signals.env, /\bprocess\.env\.([A-Z0-9_]+)/, l, 1);
    pushMatch(signals.env, /ENV\[['"`]([A-Z0-9_]+)['"`]\]/i, l, 1);
    pushMatch(signals.cli, /\s--([a-z0-9][a-z0-9-]*)\b/, l, 1);
    pushMatch(signals.config, /\b([A-Z0-9_]+)\s*[:=]\s*[^=]/, l, 1);

    // TypeScript/JS exports
    pushMatch(signals.types, /\bexport\s+type\s+([A-Za-z0-9_]+)/, l, 1);
    pushMatch(signals.types, /\bexport\s+interface\s+([A-Za-z0-9_]+)/, l, 1);
    pushMatch(signals.functions, /\bexport\s+(async\s+)?function\s+([A-Za-z0-9_]+)/, l, 2);

    // Python: new defs/classes (treat as user-facing if in core modules)
    pushMatch(signals.pythonFunctions, /^\+def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/, l, 0); // keep raw signature
    pushMatch(signals.pythonClasses, /^\+class\s+([A-Za-z_]\w*)\s*[:\(]/, l, 1);

    if (/BREAKING|remove[d]? required|rename[d]? parameter|delete\s+endpoint/i.test(l)) {
      signals.breaking = true;
    }
    if (/(core|engine|kernel|path[_-]?finder|routing|planner|match(er)?|auth|payment)/i.test(l)) {
      signals.fileHints.push('core-logic');
    }
  }

  // crude indicator of signature changes: removal + addition of def lines
  const removedDefs = removed.filter(l => /^-def\s+[A-Za-z_]\w*\s*\(/.test(l)).length;
  const addedDefs = added.filter(l => /^\+def\s+[A-Za-z_]\w*\s*\(/.test(l)).length;
  if (addedDefs && removedDefs) {
    signals.breaking = signals.breaking || (addedDefs !== removedDefs); // possible signature drift
  }

  // De-dup and shorten
  const uniq = (arr) => Array.from(new Set(arr)).slice(0, 50);
  signals.apis = uniq(signals.apis);
  signals.env = uniq(signals.env);
  signals.cli = uniq(signals.cli);
  signals.config = uniq(signals.config);
  signals.types = uniq(signals.types);
  signals.functions = uniq(signals.functions);
  signals.pythonFunctions = uniq(signals.pythonFunctions);
  signals.pythonClasses = uniq(signals.pythonClasses);
  signals.fileHints = uniq(signals.fileHints);

  // docs-worthy if we see any meaningful area or hints
  const docsWorthy = signals.apis.length || signals.env.length || signals.cli.length ||
                     signals.config.length || signals.types.length || signals.functions.length ||
                     signals.pythonFunctions.length || signals.pythonClasses.length ||
                     signals.fileHints.length || signals.breaking;

  return { signals, docsWorthy: !!docsWorthy };
}

// NEW: meta-based trigger from PR title/body and commit messages
function extractDocsSignalsFromMeta(pr, commits = []) {
  const text = [
    pr?.title || '',
    pr?.body || '',
    ...(commits || []).map(c => c?.commit?.message || c?.message || '')
  ].join('\n').toLowerCase();

  const keywords = [
    'api', 'endpoint', 'endpoints', 'route', 'graphql', 'schema',
    'config', 'configuration', 'env', 'environment variable',
    'cli', 'flag', 'command',
    'parameter', 'arg', 'argument', 'signature',
    'breaking', 'deprecate', 'deprecated', 'migrate', 'migration', 'rename',
    'feature flag', 'enable', 'toggle',
    'algorithm', 'pathfinding', 'path-finding', 'path finder', 'core', 'module', 'library'
  ];

  const matched = keywords.filter(k => text.includes(k));
  const docsWorthyMeta = matched.length > 0;

  return {
    matchedKeywords: matched,
    docsWorthyMeta
  };
}

// Summarize existing docs quickly to avoid duplication
async function fetchDocsDirectorySummary(owner, repo, branch, dir = DOCS_DIR) {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(dir)}?ref=${encodeURIComponent(branch)}`;
    const r = await fetchFn(url, { headers: ghHeaders({ 'Accept': 'application/vnd.github+json' }) });
    if (!r.ok) return { files: [], snippets: [] };
    const arr = await r.json();
    if (!Array.isArray(arr)) return { files: [], snippets: [] };

    const files = arr.filter(x => x.type === 'file' && /\.mdx?$/.test(x.name));
    // Pull first ~600 chars of up to 6 files to guide the LLM
    const snippets = [];
    for (const f of files.slice(0, 6)) {
      try {
        const rf = await fetchFn(`${f.download_url}`, { headers: { 'User-Agent': 'DocFlow' } });
        const txt = await rf.text();
        snippets.push({
          path: f.path,
          head: txt.slice(0, 600)
        });
      } catch (_) { /* ignore */ }
    }
    return { files: files.map(f => f.path), snippets };
  } catch {
    return { files: [], snippets: [] };
  }
}

// -------------------- CLIENTS --------------------
const dbClient = new DynamoDBClient({ region: AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);

// -------------------- GITHUB HELPERS --------------------
const ghHeaders = (extra = {}) => {
  if (!GITHUB_TOKEN) {
    console.error('❌ Missing GITHUB_TOKEN env var');
    process.exit(1);
  }
  return {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': 'DocFlow',
    ...extra
  };
};

async function getPR(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  const r = await fetchFn(url, { headers: ghHeaders({ 'Accept': 'application/vnd.github+json' }) });
  if (!r.ok) throw new Error(`GitHub getPR failed: ${r.status} ${r.statusText}`);
  return r.json();
}

async function getPRCommits(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits`;
  const r = await fetchFn(url, { headers: ghHeaders({ 'Accept': 'application/vnd.github+json' }) });
  if (!r.ok) throw new Error(`GitHub getPRCommits failed: ${r.status} ${r.statusText}`);
  return r.json();
}

async function getPRDiff(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  const r = await fetchFn(url, { headers: ghHeaders({ 'Accept': 'application/vnd.github.v3.diff' }) });
  if (!r.ok) throw new Error(`GitHub getPRDiff failed: ${r.status} ${r.statusText}`);
  return r.text();
}

async function upsertFile({ owner, repo, path, content, message, branch }) {
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const getUrl = branch ? `${baseUrl}?ref=${encodeURIComponent(branch)}` : baseUrl;

  // GET existing sha (if any)
  let sha = null;
  const getRes = await fetchFn(getUrl, { headers: ghHeaders({ 'Accept': 'application/vnd.github+json' }) });
  if (getRes.ok) {
    const existing = await getRes.json();
    if (existing && existing.sha) sha = existing.sha;
  }

  // PUT new content
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
    ...(branch ? { branch } : {})
  };

  const putRes = await fetchFn(baseUrl, {
    method: 'PUT',
    headers: ghHeaders({ 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }),
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

  const MODEL_CANDIDATES = [
    "gemini-2.5-pro",
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

// New: Robust docs generator prompt (returns a JSON "docs pack")
async function generateDocsPackWithGemini({ pr, commits, jira, diffText, existingDocs, signals, meta }) {
  if (!GEMINI_API_KEY || !DOCS_AUTO) return null;

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  const commitsList = (commits || [])
    .map((c, i) => `${i + 1}. ${c.commit?.message || c.message || ''}`)
    .join('\n');

  const existingFilesList = (existingDocs?.files || []).map(p => `- ${p}`).join('\n') || '(none)';
  const existingSnippets = (existingDocs?.snippets || [])
    .map(s => `PATH: ${s.path}\nHEAD:\n${s.head}`)
    .join('\n---\n');

  const signalsBlock = JSON.stringify(signals || {}, null, 2);
  const metaBlock = JSON.stringify(meta || {}, null, 2);

  const prompt = `
You are a senior technical writer generating *concise, high-signal* documentation updates for a codebase.
A PR has been merged. You must decide what to document and produce a set of Markdown files (in JSON) to upsert into the repository under the "docs/" directory.

**CRITICAL RULES**
- The changelog is already updated elsewhere; do NOT produce or mention a changelog here.
- Only document *non-trivial* changes that affect usability or understanding:
  - new or changed API endpoints, routes, message schemas, GraphQL ops
  - new CLI commands or flags
  - new environment variables or configuration keys
  - new public functions/classes/exports, importantly their inputs/outputs
  - core algorithm changes that materially affect behavior (e.g., pathfinding)
  - breaking changes, migrations, deprecations, feature flags
  - usage guides or examples required to successfully use new functionality
- Ignore trivial/internal-only changes: formatting, refactors with no surface change, UI alignment (e.g., centering a div), comment edits.
- Avoid repetition with existing docs. If a section already exists, *update that section only*, do not duplicate content.
- Keep everything concise, precise, and helpful (“how to use” over “what changed”).
- Use Markdown only. No HTML. No frontmatter. Keep headings clear (##, ###).
- Where appropriate, include code examples and request/response samples.
- Maintain a single "docs/overview.md" that tracks **Active Features** as a bullet list with one-line explanations and links to deeper pages.
  - Update “Active Features” entries if new user-visible features are introduced or changed.

**INPUT CONTEXT**
PR Title: ${pr.title}
PR Description: ${pr.body || '(none)'}
Commits:
${commitsList || '(none)'}
JIRA: ${jira ? `${jira.key} — ${jira.summary} (Status=${jira.status}, Priority=${jira.priority})` : '(none)'}
JIRA Description:
${jira?.description || '(none)'}
Heuristic Signals (from diff):
${signalsBlock}
Meta Signals (keywords from title/body/commits):
${metaBlock}

Unified Diff (truncated to first ~12k chars if longer):
${(diffText || '').slice(0, 12000)}

Existing docs files:
${existingFilesList}

Existing docs snippets (first ~600 chars each):
${existingSnippets || '(none)'}

**OUTPUT FORMAT**
Return ONLY a JSON object with this exact shape (no prose around it):
{
  "files": [
    { "path": "docs/<relative>.md", "mode": "upsert", "reason": "<why this file is touched>", "content": "<full markdown content>" }
  ],
  "notes": "<one-line operator note (optional)>"
}

**CONTENT GUIDELINES**
- If NOTHING deserves documentation, return { "files": [] }.
- Paths to prefer:
  - docs/overview.md (ensure "Active Features" section stays current)
  - docs/api/<area>.md (REST/GraphQL/API endpoints and schemas)
  - docs/cli/<tool>.md (commands/flags)
  - docs/configuration.md (env vars & config keys)
  - docs/how-to/<topic>.md (task-focused guides)
  - docs/modules/<module>.md (core modules like path_finder)
- In updated files, include only the *full revised content* (we will replace file content).
- Use explicit sections: "Overview", "When to use", "Parameters", "Responses", "Examples", "Breaking Changes", "Migration", "Feature Flags".
- Keep it crisp and to the point.
`.trim();

  for (const modelName of DOCS_MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 3000 }
      });
      const raw = result?.response?.text?.();
      if (!raw) continue;

      // Try to parse JSON body; handle accidental fencing
      const jsonStr = raw.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(jsonStr);
      if (parsed && Array.isArray(parsed.files)) {
        // Safety clamp number of files
        parsed.files = parsed.files.slice(0, DOCS_MAX_FILES);
        return parsed;
      }
    } catch (err) {
      console.warn(`⚠️ Docs model failed (${modelName}): ${err?.message || err}`);
    }
  }

  return null;
}

// Apply docs pack by upserting each file into docs/
async function applyDocsPack({ owner, repo, branch, pack }) {
  if (!pack || !Array.isArray(pack.files) || pack.files.length === 0) return { applied: 0, results: [] };

  const results = [];
  let applied = 0;

  for (const f of pack.files) {
    if (!f || f.mode !== 'upsert' || !f.path || typeof f.content !== 'string') continue;
    // ensure path under DOCS_DIR
    const normalized = f.path.startsWith(`${DOCS_DIR}/`) ? f.path : `${DOCS_DIR}/${f.path}`.replaceAll('//', '/');

    try {
      const res = await upsertFile({
        owner, repo,
        path: normalized,
        content: f.content,
        message: `docs(update): PR #${prNumber} — ${f.reason || 'documentation update'}`,
        branch
      });
      applied++;
      results.push({ path: normalized, ok: true, sha: res?.content?.sha || null });
    } catch (e) {
      console.warn(`⚠️ Failed to upsert ${normalized}: ${e.message}`);
      results.push({ path: normalized, ok: false, error: e.message });
    }
  }

  return { applied, results };
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

    const pr      = await getPR(owner, repo, prNumber);
    const commits = await getPRCommits(owner, repo, prNumber);
    const prDiff  = await getPRDiff(owner, repo, prNumber); // raw unified diff text
    const jira    = jiraKeyArg ? await getJiraIssue(jiraKeyArg) : null;

    const llm = await summarizeWithGemini({
      title: pr.title,
      body: pr.body,
      commits,
      jira
    });

    const section = renderChangelogEntry({ pr, commits, jira, llm });

    // === Append to CHANGELOG.md (append-only) ===
    const PATH = DOC_LOG_FILE;
    const branch = pr.base?.ref || 'main';
    let existing = '';
    const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(PATH)}?ref=${encodeURIComponent(branch)}`;
    const getRes = await fetchFn(getUrl, { headers: ghHeaders({ 'Accept': 'application/vnd.github+json' }) });
    if (getRes.ok) {
      const blob = await getRes.json();
      existing = Buffer.isBuffer(blob?.content)
        ? Buffer.from(blob.content, 'base64').toString('utf8')
        : (blob?.content ? Buffer.from(blob.content, 'base64').toString('utf8') : '');
    }
    if (!existing) existing = '# Changelog\n\n';

    // Append new section at the TOP to keep latest-first, without deleting older entries
    const newContent = [section, existing].join('\n');

    const writeResult = await upsertFile({
      owner, repo,
      path: PATH,
      content: newContent,
      message: `docs(changelog): add PR #${prNumber}${jira ? ` + ${jira.key}` : ''}`,
      branch
    });

    console.log(`✅ Updated ${PATH} at ${writeResult?.content?.html_url || '(unknown URL)'} (sha ${writeResult?.content?.sha || 'n/a'})`);

    // === Generate docs/ updates (non-trivial items only; append-only docs upserts) ===
    try {
      const { signals, docsWorthy } = extractDocsSignalsFromDiff(prDiff || '');
      const meta = extractDocsSignalsFromMeta(pr, commits);
      const docsTrigger = docsWorthy || meta.docsWorthyMeta;

      if (!DOCS_AUTO) {
        console.log('ℹ️ DOCS_AUTO disabled; skipping docs generation.');
      } else if (!docsTrigger) {
        console.log('ℹ️ No docs-worthy signals detected in diff/meta; skipping docs generation.');
      } else {
        // Read existing docs to avoid duplication
        const existingDocs = await fetchDocsDirectorySummary(owner, repo, branch, DOCS_DIR);
        const pack = await generateDocsPackWithGemini({
          pr, commits, jira, diffText: prDiff || '', existingDocs, signals, meta
        });

        if (pack && Array.isArray(pack.files) && pack.files.length) {
          const applied = await applyDocsPack({ owner, repo, branch, pack });
          console.log(`🧾 Docs pack applied: ${applied.applied} file(s).`);
        } else {
          console.log('ℹ️ LLM returned no docs files to update.');
        }
      }
    } catch (e) {
      console.warn(`⚠️ Docs generation failed: ${e.message}`);
    }

    // === Record DynamoDB Transaction as PAIR ===
    if (!DYNAMO_TABLE) {
      console.warn('⚠️ DYNAMODB_TABLE_NAME not set; skipping tx record.');
      return;
    }

    const repoBranchId = `${owner}/${repo}#${branch}`;
    const { Item: parentHead } = await docClient.send(new GetCommand({
      TableName: DYNAMO_TABLE,
      Key: { RepoBranch: repoBranchId, SK: 'HEAD' }
    }));

    const parentTxnSK = parentHead ? parentHead.latestTxnSK : 'ROOT';
    const newTxnSK = `TXN#${new Date().toISOString()}#PR#${prNumber}`;

    const parentChangeHash = sha256(prDiff || '');
    const docChangeHash = sha256(section || '');
    const conceptKey = jira?.key ? `JIRA:${jira.key}` : `PR#${prNumber}`;

    const botDocCommitSha = writeResult?.commit?.sha || null;
    const docFileSha      = writeResult?.content?.sha || null;

    const txnItem = {
      RepoBranch: repoBranchId,
      SK: newTxnSK,
      parentTxnSK,
      type: 'PR_MERGE',
      txnKind: 'PAIR',                       // has both hashes
      createdAt: new Date().toISOString(),

      // PR metadata
      prNumber,
      prTitle: pr.title,
      prAuthor: pr.user?.login || null,
      prMergedAt: pr.merged_at || null,
      mergeCommitSha: pr.merge_commit_sha || null,

      // JIRA (optional)
      jiraKey: jira?.key || null,

      // Hashes for reversibility
      parentChangeHash,              // sha256 of PR diff text
      parentChangeType: 'GITHUB_PR_DIFF_SHA256',
      docChangeHash,                 // sha256 of the CHANGELOG section we prepended
      docChangeType: 'CHANGELOG_SECTION_SHA256',

      // Concept linking
      conceptKey,
      relatedConceptKeys: [conceptKey],

      // Pointers to artifacts
      docFilePath: PATH,
      docFileSha,
      botDocCommitSha,

      // For convenience
      summaryPreview: truncate(section, 400)
    };

    await docClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: DYNAMO_TABLE, Item: txnItem } },
        { Put: { TableName: DYNAMO_TABLE, Item: { RepoBranch: repoBranchId, SK: 'HEAD', latestTxnSK: newTxnSK, updatedAt: new Date().toISOString() } } }
      ]
    }));

    console.log(`🧾 Recorded PR transaction ${newTxnSK} (parent=${parentTxnSK})`);

  } catch (err) {
    console.error('❌ Failed:', err);
    process.exit(1);
  }
})();
