// revert.js (ESM) — Semantic revert with code + docs, and conceptKey roundup
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
const AWS_REGION     = process.env.AWS_REGION || 'us-east-1';
const DYNAMO_TABLE   = process.env.DYNAMODB_TABLE_NAME;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_API_TOKEN;

const BRANCH      = 'main';
const TARGET_FILE = 'READLOG.md'; // primary doc we rewrite

// -------------------- ARGS --------------------
const [OWNER, REPO, TARGET_TXN_ID] = process.argv.slice(2);
if (!OWNER || !REPO || !TARGET_TXN_ID) {
  console.error('Usage: node revert.js <owner> <repo> <targetTransactionId>');
  console.error('Example: node revert.js jwlebert htn25-test "TXN#2025-09-14T02:06:25.774Z#PR#4"');
  process.exit(1);
}

// -------------------- CLIENTS --------------------
const octo = new Octokit({ auth: GITHUB_TOKEN });
const dbClient = new DynamoDBClient({ region: AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);

// -------------------- UTILS --------------------
const sha256 = (s) => crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');
const nowIso = () => new Date().toISOString();

function ensureEnv(varName, val) {
  if (!val) throw new Error(`Missing required env var: ${varName}`);
}
function isTxn(item) {
  return item && typeof item.SK === 'string' && item.SK.startsWith('TXN#');
}
function compareIsoGT(a, b) {
  try { return new Date(a).getTime() > new Date(b).getTime(); } catch { return false; }
}
function unique(arr) { return Array.from(new Set(arr)); }

// Fallback surgical remover if LLM is unavailable: removes blocks starting at headings "## PR #<n>:" or lines mentioning concept
function removeConceptBlocksHeuristic(original, { prNumber, conceptKey, extraPhrases = [] }) {
  if (!original) return original || '';
  const lines = original.split('\n');
  const toRemoveIdx = new Set();

  const headingPattern = prNumber ? new RegExp(`^##\\s+PR\\s+#${prNumber}\\b`) : null;

  const mentionPatterns = [];
  if (conceptKey) {
    const c = String(conceptKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    mentionPatterns.push(new RegExp(c, 'i'));
  }
  for (const phrase of extraPhrases) {
    const p = String(phrase || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (p) mentionPatterns.push(new RegExp(p, 'i'));
  }

  // Remove whole PR block
  if (headingPattern) {
    let i = 0;
    while (i < lines.length) {
      if (headingPattern.test(lines[i])) {
        let j = i + 1;
        while (j < lines.length && !/^##\s+PR\s+#\d+/.test(lines[j])) j++;
        for (let k = i; k < j; k++) toRemoveIdx.add(k);
        i = j;
      } else {
        i++;
      }
    }
  }

  // Remove scattered concept mentions (with small context)
  for (let i = 0; i < lines.length; i++) {
    if (mentionPatterns.some(rx => rx.test(lines[i]))) {
      for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 5); k++) {
        toRemoveIdx.add(k);
      }
    }
  }

  const kept = [];
  for (let i = 0; i < lines.length; i++) if (!toRemoveIdx.has(i)) kept.push(lines[i]);
  const collapsed = kept.join('\n').replace(/\n{3,}/g, '\n\n');
  return collapsed.trimEnd() + '\n';
}

// -------------------- DATA FETCH --------------------
async function getTargetTxnAndRelated({ owner, repo, targetTxnId }) {
  ensureEnv('DYNAMODB_TABLE_NAME', DYNAMO_TABLE);
  const repoBranchId = `${owner}/${repo}#${BRANCH}`;

  const { Item: target } = await docClient.send(new GetCommand({
    TableName: DYNAMO_TABLE,
    Key: { RepoBranch: repoBranchId, SK: targetTxnId }
  }));
  if (!target) throw new Error(`Transaction not found: ${targetTxnId}`);
  if (!isTxn(target)) throw new Error(`Key is not a transaction: ${targetTxnId}`);

  const createdAt  = target.createdAt || target.timestamp || null;
  const conceptKey = target.conceptKey || null;

  let related = [];
  if (conceptKey && createdAt) {
    const q = await docClient.send(new QueryCommand({
      TableName: DYNAMO_TABLE,
      KeyConditionExpression: 'RepoBranch = :rb AND begins_with(#sk, :p)',
      ExpressionAttributeNames: { '#sk': 'SK' },
      ExpressionAttributeValues: { ':rb': repoBranchId, ':p': 'TXN#' }
    }));
    related = (q.Items || []).filter(isTxn).filter(it =>
      it.txnKind === 'DOC_ONLY' &&
      it.conceptKey === conceptKey &&
      it.createdAt && compareIsoGT(it.createdAt, createdAt)
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
  const fileSha   = data?.content?.sha || null;
  return { commitSha, fileSha };
}

// -------------------- CODE REVERT --------------------
async function revertGitCommit(mergeCommitSha, prTitle) {
  console.log(`Attempting to revert Git commit: ${mergeCommitSha}`);
  try {
    // Current branch tip
    const { data: refData } = await octo.git.getRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}` });
    const tipSha = refData.object.sha;

    // The merge commit we want to revert
    const { data: commitToRevert } = await octo.git.getCommit({ owner: OWNER, repo: REPO, commit_sha: mergeCommitSha });
    if (!commitToRevert.parents?.length) {
      throw new Error('Target commit has no parents; cannot revert.');
    }

    // Use the first parent’s tree as a practical revert target (approximation of "git revert")
    const baseParentSha = commitToRevert.parents[0].sha;
    const { data: parentCommit } = await octo.git.getCommit({ owner: OWNER, repo: REPO, commit_sha: baseParentSha });
    const treeSha = parentCommit.tree.sha;

    const { data: newCommit } = await octo.git.createCommit({
      owner: OWNER,
      repo: REPO,
      message: `Revert: "${prTitle || '(PR)'}"\n\nThis reverts commit ${mergeCommitSha}.`,
      tree: treeSha,
      parents: [tipSha]
    });

    await octo.git.updateRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}`, sha: newCommit.sha });
    console.log(`✅ Code revert commit created: ${newCommit.sha}`);
    return newCommit.sha;
  } catch (err) {
    console.error('❌ Code revert failed:', err.message || err);
    throw new Error('Git code revert operation failed (permissions/conflicts or non-merge history).');
  }
}

// -------------------- LLM --------------------
async function llmRewriteReadlog({ original, target, conceptKey, relatedDocOnly }) {
  if (!GEMINI_API_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

    const docOnlyBullets = (relatedDocOnly || [])
      .map(x => `- ${x.message || '(no message)'} @ ${x.createdAt || ''}`)
      .slice(0, 20)
      .join('\n');

    const prompt = `
You are an expert technical writer performing a *semantic revert* in a monolithic changelog file named READLOG.md.

Current READLOG.md content:
---
${original}
---

Remove the entire concept identified by:
- conceptKey: ${conceptKey || '(none)'}
- Primary PR: #${target.prNumber || '(unknown)'} — ${target.prTitle || ''}

Also remove *later doc-only edits* of the same concept:
${docOnlyBullets || '(none)'}

Preserve all unrelated changes. Output ONLY the full, final file contents (no fences).
    `.trim();

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
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

// -------------------- RECORD REVERT TXN --------------------
async function recordRevertTxn({ repoBranchId, target, relatedDocOnly, conceptKey, docFileSha, docsRevertCommitSha, codeRevertCommitSha, newContent }) {
  if (!DYNAMO_TABLE) {
    console.warn('⚠️ DYNAMODB_TABLE_NAME not set; skipping REVERT txn record.');
    return;
  }
  const newTxnSK = `TXN#${nowIso()}#REVERT`;

  const { Item: head } = await docClient.send(new GetCommand({
    TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: 'HEAD' }
  }));
  const parentHead = head?.latestTxnSK || 'ROOT';

  const item = {
    RepoBranch: repoBranchId,
    SK: newTxnSK,
    parentTxnSK: parentHead,
    type: 'REVERT',
    txnKind: 'REVERT',
    createdAt: nowIso(),

    revertedTxnSK: target.SK,
    alsoRemovedTxnSKs: (relatedDocOnly || []).map(r => r.SK),

    conceptKey: conceptKey || null,
    docFilePath: TARGET_FILE,
    docFileSha: docFileSha || null,

    // New commits created by this revert
    codeRevertCommitSha: codeRevertCommitSha || null,
    docsRevertCommitSha: docsRevertCommitSha || null,

    // Hash of final doc content
    docChangeHash: sha256(newContent || ''),
    docChangeType: 'UTF8_CONTENT_SHA256'
  };

  await docClient.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: DYNAMO_TABLE, Item: item } },
      { Put: { TableName: DYNAMO_TABLE, Item: { RepoBranch: repoBranchId, SK: 'HEAD', latestTxnSK: newTxnSK, updatedAt: nowIso() } } }
    ]
  }));

  console.log(`🧾 Recorded REVERT transaction ${newTxnSK} (reverted=${target.SK}${(item.alsoRemovedTxnSKs || []).length ? ` + ${item.alsoRemovedTxnSKs.length} doc-only` : ''})`);
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

    // 1) Revert CODE (if we have a PR merge commit SHA)
    let codeRevertCommitSha = null;
    if (target.mergeCommitSha) {
      codeRevertCommitSha = await revertGitCommit(target.mergeCommitSha, target.prTitle || '(no title)');
    } else {
      console.log('ℹ️  No mergeCommitSha on target txn; skipping code revert.');
    }

    // 2) Revert DOCS (READLOG) — LLM or heuristic rewrite
    const { content: currentReadlog, sha: prevSha } = await fetchReadlog(OWNER, REPO, TARGET_FILE, BRANCH);

    const llmNew = await llmRewriteReadlog({
      original: currentReadlog,
      target,
      conceptKey,
      relatedDocOnly
    });

    const newContent = llmNew || removeConceptBlocksHeuristic(currentReadlog, {
      prNumber: target.prNumber || null,
      conceptKey,
      extraPhrases: unique([
        target.prTitle || '',
        ...(relatedDocOnly || []).map(r => r.message || '')
      ]).filter(Boolean)
    });

    if (!newContent || newContent.trim() === currentReadlog.trim()) {
      throw new Error('Rewriter produced no changes; aborting to avoid no-op commit.');
    }

    const commitMsg = `docs(revert): remove concept ${conceptKey || target.prNumber || '(unknown)'} (revert ${target.SK})`;
    const { commitSha: docsRevertCommitSha, fileSha: docFileSha } =
      await commitReadlog(OWNER, REPO, TARGET_FILE, newContent, prevSha, commitMsg);

    console.log(`✅ Pushed docs revert commit ${docsRevertCommitSha} updating ${TARGET_FILE} (sha ${docFileSha})`);

    // 3) Record REVERT transaction
    await recordRevertTxn({
      repoBranchId,
      target,
      relatedDocOnly,
      conceptKey,
      docFileSha,
      docsRevertCommitSha,
      codeRevertCommitSha,
      newContent
    });

    console.log('\n✨ Revert completed (code + docs).');
  } catch (error) {
    console.error(`\n❌ Revert failed: ${error.message}`);
    process.exit(1);
  }
})();
