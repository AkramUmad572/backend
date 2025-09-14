// revert.js (ESM) — Semantic revert with conceptKey roundup (PAIR + subsequent DOC_ONLY) for READLOG.md
import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import { Buffer } from 'node:buffer';
import crypto from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  DynamoDBClient
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand
} from '@aws-sdk/lib-dynamodb';

// -------------------- ENV & CONSTS --------------------
const AWS_REGION   = process.env.AWS_REGION || 'us-east-1';
const DYNAMO_TABLE = process.env.DYNAMODB_TABLE_NAME;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_API_TOKEN;

const BRANCH = 'main';
const TARGET_FILE = 'READLOG.md'; // Primary doc we rewrite

// -------------------- ARGS --------------------
const [OWNER, REPO, TARGET_TXN_ID] = process.argv.slice(2);
if (!OWNER || !REPO || !TARGET_TXN_ID) {
  console.error('Usage: node revert.js <owner> <repo> <targetTransactionId>');
  console.error('Example: node revert.js jwlebert htn25-test "TXN#2025-09-14T02:06:25.774Z#PR#42"');
  process.exit(1);
}

// -------------------- CLIENTS --------------------
const octo = new Octokit({ auth: GITHUB_TOKEN });
const dbClient = new DynamoDBClient({ region: AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);

// -------------------- UTILS --------------------
const sha256 = (s) => crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');

function ensureEnv(varName, val) {
  if (!val) throw new Error(`Missing required env var: ${varName}`);
}

function parseMaybeJson(x) {
  try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return x; }
}

function isTxn(item) {
  return item && typeof item.SK === 'string' && item.SK.startsWith('TXN#');
}

function compareIso(a, b) {
  // returns true if a > b (both ISO strings)
  try { return new Date(a).getTime() > new Date(b).getTime(); } catch { return false; }
}

function unique(arr) {
  return Array.from(new Set(arr));
}

// Fallback surgical remover if LLM is unavailable: removes blocks starting at headings "## PR #<n>:" or lines mentioning concept
function removeConceptBlocksHeuristic(original, { prNumber, conceptKey, extraPhrases = [] }) {
  if (!original) return original || '';

  const lines = original.split('\n');
  const toRemoveIdx = new Set();

  // Identify ranges that start with "## PR #<n>:" for the target PR
  const headingPattern = prNumber ? new RegExp(`^##\\s+PR\\s+#${prNumber}\\b`) : null;

  // We'll also remove lines that explicitly mention the conceptKey (e.g., JIRA: ABC-123) or extra phrases
  const mentionPatterns = [];
  if (conceptKey) {
    // Concept keys look like "JIRA:ABC-123" or "PR#42"
    const c = String(conceptKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    mentionPatterns.push(new RegExp(c, 'i'));
  }
  for (const phrase of extraPhrases) {
    const p = String(phrase || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (p) mentionPatterns.push(new RegExp(p, 'i'));
  }

  // Pass 1: mark complete PR blocks by heading
  if (headingPattern) {
    let i = 0;
    while (i < lines.length) {
      if (headingPattern.test(lines[i])) {
        // remove until next "## PR #" or end
        let j = i + 1;
        while (j < lines.length && !/^##\s+PR\s+#\d+/.test(lines[j])) j++;
        for (let k = i; k < j; k++) toRemoveIdx.add(k);
        i = j;
      } else {
        i++;
      }
    }
  }

  // Pass 2: remove scattered lines mentioning the concept, small context window
  for (let i = 0; i < lines.length; i++) {
    if (mentionPatterns.some(rx => rx.test(lines[i]))) {
      // remove up to 5 lines around the mention to catch bullet blocks
      for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 5); k++) {
        toRemoveIdx.add(k);
      }
    }
  }

  // Build result, also collapse multiple blank lines
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (!toRemoveIdx.has(i)) kept.push(lines[i]);
  }
  const collapsed = kept.join('\n').replace(/\n{3,}/g, '\n\n');
  return collapsed.trimEnd() + '\n';
}

// -------------------- DATA FETCH --------------------
async function getTargetTxnAndRelated({ owner, repo, targetTxnId }) {
  ensureEnv('DYNAMODB_TABLE_NAME', DYNAMO_TABLE);
  const repoBranchId = `${owner}/${repo}#${BRANCH}`;

  // 1) Load target txn
  const { Item: target } = await docClient.send(new GetCommand({
    TableName: DYNAMO_TABLE,
    Key: { RepoBranch: repoBranchId, SK: targetTxnId }
  }));
  if (!target) throw new Error(`Transaction not found: ${targetTxnId}`);
  if (!isTxn(target)) throw new Error(`Key is not a transaction: ${targetTxnId}`);

  // 2) Round up later DOC_ONLY txns with matching conceptKey
  const createdAt = target.createdAt || target.timestamp || null;
  const conceptKey = target.conceptKey || null;

  let related = [];
  if (conceptKey && createdAt) {
    // Query all TXN# for this branch; DynamoDB can't filter "after ISO" server-side without sort schema,
    // so we fetch and filter client-side.
    const q = await docClient.send(new QueryCommand({
      TableName: DYNAMO_TABLE,
      KeyConditionExpression: 'RepoBranch = :rb AND begins_with(#sk, :p)',
      ExpressionAttributeNames: { '#sk': 'SK' },
      ExpressionAttributeValues: { ':rb': repoBranchId, ':p': 'TXN#' }
    }));

    related = (q.Items || []).filter(isTxn).filter(it =>
      it.txnKind === 'DOC_ONLY' &&
      it.conceptKey === conceptKey &&
      it.createdAt && compareIso(it.createdAt, createdAt)
    ).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }

  return { target, conceptKey, relatedDocOnly: related, repoBranchId };
}

async function fetchReadlog(owner, repo, path = TARGET_FILE, branch = BRANCH) {
  try {
    const { data } = await octo.repos.getContent({ owner, repo, path, ref: branch });
    const sha = !Array.isArray(data) ? data.sha : undefined;
    const content = !Array.isArray(data) ? Buffer.from(data.content, 'base64').toString('utf8') : '';
    return { content, sha };
  } catch (e) {
    if (e.status === 404) {
      return { content: '# Release / Change Log\n\n', sha: undefined };
    }
    throw e;
  }
}

async function commitReadlog(owner, repo, path, newContent, prevSha, message) {
  const { data } = await octo.repos.createOrUpdateFileContents({
    owner, repo, path,
    message,
    content: Buffer.from(newContent, 'utf8').toString('base64'),
    branch: BRANCH,
    ...(prevSha ? { sha: prevSha } : {})
  });
  const commitSha = data?.commit?.sha || null;
  const fileSha = data?.content?.sha || null;
  return { commitSha, fileSha };
}

// -------------------- LLM --------------------
async function llmRewriteReadlog({ original, target, conceptKey, relatedDocOnly, owner, repo }) {
  if (!GEMINI_API_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

    const prNumber = target.prNumber || null;
    const prTitle  = target.prTitle  || null;
    const docOnlyBullets = (relatedDocOnly || []).map(x => `- ${x.message || '(no message)'} @ ${x.createdAt || ''}`).slice(0, 20).join('\n');

    const prompt = `
You are an expert technical writer performing a *semantic revert* in a monolithic changelog file named READLOG.md.

Current READLOG.md content (truncated may be long):
---
${original}
---

The feature concept to remove is identified by:
- conceptKey: ${conceptKey || '(none)'}
- Primary PR: ${prNumber ? `#${prNumber}` : '(unknown)'} ${prTitle ? '— ' + prTitle : ''}
- Additional doc-only edits to also remove (later patches of the same concept):
${docOnlyBullets || '(none)'}

Your task:
1) Remove the *entire* concept introduced by the Primary PR and any *subsequent doc-only edits* listed above.
2) Preserve every other unrelated change.
3) Keep the file well-formed markdown. Do *not* add explanation; output the full new file content.
4) Output ONLY the raw file contents for READLOG.md (no code fences).
    `.trim();

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
    });
    const text = result?.response?.text?.();
    if (text && text.trim()) return text.trimEnd() + (text.endsWith('\n') ? '' : '\n');
  } catch (e) {
    console.warn('⚠️ Gemini rewrite failed:', e.message || e);
  }
  return null;
}

// -------------------- DYNAMO RECORD --------------------
async function recordRevertTxn({ repoBranchId, target, relatedDocOnly, conceptKey, docFileSha, botCommitSha, newContent }) {
  if (!DYNAMO_TABLE) {
    console.warn('⚠️ DYNAMODB_TABLE_NAME not set; skipping REVERT txn record.');
    return;
  }
  const newTxnSK = `TXN#${new Date().toISOString()}#REVERT`;

  const relatedIds = relatedDocOnly.map(r => r.SK);
  const item = {
    RepoBranch: repoBranchId,
    SK: newTxnSK,
    parentTxnSK: (await getHead(repoBranchId)) || 'ROOT',
    type: 'REVERT',
    txnKind: 'REVERT',
    createdAt: new Date().toISOString(),

    revertedTxnSK: target.SK,
    alsoRemovedTxnSKs: relatedIds,

    conceptKey: conceptKey || null,
    docFilePath: TARGET_FILE,
    docFileSha: docFileSha || null,
    botCommitSha: botCommitSha || null,

    parentChangeHash: null,
    parentChangeType: null,
    docChangeHash: sha256(newContent || ''),
    docChangeType: 'UTF8_CONTENT_SHA256'
  };

  await docClient.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: DYNAMO_TABLE, Item: item } },
      { Put: { TableName: DYNAMO_TABLE, Item: { RepoBranch: repoBranchId, SK: 'HEAD', latestTxnSK: newTxnSK, updatedAt: new Date().toISOString() } } }
    ]
  }));

  console.log(`🧾 Recorded REVERT transaction ${newTxnSK} (reverted=${target.SK}${relatedIds.length ? ` + ${relatedIds.length} doc-only` : ''})`);
}

async function getHead(repoBranchId) {
  const { Item } = await docClient.send(new GetCommand({
    TableName: DYNAMO_TABLE,
    Key: { RepoBranch: repoBranchId, SK: 'HEAD' }
  }));
  return Item?.latestTxnSK || null;
}

// -------------------- MAIN --------------------
(async () => {
  try {
    ensureEnv('GITHUB_TOKEN', GITHUB_TOKEN);

    const { target, conceptKey, relatedDocOnly, repoBranchId } =
      await getTargetTxnAndRelated({ owner: OWNER, repo: REPO, targetTxnId: TARGET_TXN_ID });

    console.log(`🎯 Target txn: ${TARGET_TXN_ID}`);
    console.log(`🔗 conceptKey: ${conceptKey || '(none)'}`);
    if (relatedDocOnly.length) {
      console.log(`📎 Also removing ${relatedDocOnly.length} related DOC_ONLY patches:`);
      for (const r of relatedDocOnly) console.log(`  - ${r.SK} :: ${r.message || '(no message)'} @ ${r.createdAt || ''}`);
    } else {
      console.log('ℹ️  No related DOC_ONLY patches found (or conceptKey missing).');
    }

    // 1) Load current READLOG.md
    const { content: originalReadlog, sha: prevSha } = await fetchReadlog(OWNER, REPO, TARGET_FILE, BRANCH);

    // 2) Try LLM rewrite; fallback to heuristics if unavailable
    const llmNew = await llmRewriteReadlog({
      original: originalReadlog,
      target,
      conceptKey,
      relatedDocOnly,
      owner: OWNER,
      repo: REPO
    });

    const newContent = llmNew || removeConceptBlocksHeuristic(originalReadlog, {
      prNumber: target.prNumber || null,
      conceptKey,
      extraPhrases: unique([
        target.prTitle || '',
        ...(relatedDocOnly || []).map(r => r.message || '')
      ]).filter(Boolean)
    });

    if (!newContent || newContent.trim() === originalReadlog.trim()) {
      throw new Error('Rewriter produced no changes; aborting to avoid no-op commit.');
    }

    // 3) Commit updated READLOG.md
    const commitMsg = `docs(revert): remove concept ${conceptKey || target.prNumber || '(unknown)'} (revert ${target.SK})`;
    const { commitSha: botCommitSha, fileSha: docFileSha } =
      await commitReadlog(OWNER, REPO, TARGET_FILE, newContent, prevSha, commitMsg);

    console.log(`✅ Pushed revert commit ${botCommitSha} updating ${TARGET_FILE} (sha ${docFileSha})`);

    // 4) Record REVERT transaction in DynamoDB
    await recordRevertTxn({
      repoBranchId,
      target,
      relatedDocOnly,
      conceptKey,
      docFileSha,
      botCommitSha,
      newContent
    });

    console.log('\n✨ Semantic revert completed successfully.');
  } catch (error) {
    console.error(`\n❌ Revert failed: ${error.message}`);
    process.exit(1);
  }
})();
