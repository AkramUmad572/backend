// revert.js (ESM) — Safe revert of code (merge commit) + docs (exact PR block removal)
import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import { Buffer } from 'node:buffer';
import crypto from 'crypto';
import {
  DynamoDBClient
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand
} from '@aws-sdk/lib-dynamodb';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ===== ENV / CONSTS =====
const AWS_REGION     = process.env.AWS_REGION || 'us-east-1';
const DYNAMO_TABLE   = process.env.DYNAMODB_TABLE_NAME;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_API_TOKEN;

const BRANCH      = 'main';
const TARGET_FILE = 'READLOG.md';

// ===== ARGS =====
const [OWNER, REPO, TARGET_TXN_ID] = process.argv.slice(2);
if (!OWNER || !REPO || !TARGET_TXN_ID) {
  console.error('Usage: node revert.js <owner> <repo> <targetTransactionId>');
  process.exit(1);
}

// ===== CLIENTS =====
const octo = new Octokit({ auth: GITHUB_TOKEN });
const dbClient = new DynamoDBClient({ region: AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dbClient);

// ===== UTILS =====
const nowIso = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');

function assertEnv(name, val) {
  if (!val) throw new Error(`Missing env: ${name}`);
}

function isTxn(item) {
  return item && typeof item.SK === 'string' && item.SK.startsWith('TXN#');
}

// Strict PR-block remover: remove only headings “## PR #<n>:”
function removePrBlocks(readlog, prNumbers) {
  if (!readlog) return '';
  const prSet = new Set((prNumbers || []).filter(Boolean));
  if (!prSet.size) return readlog;

  const lines = readlog.split('\n');
  const keep = [];
  for (let i = 0; i < lines.length; ) {
    const m = lines[i].match(/^##\s+PR\s+#(\d+)\b/);
    if (m && prSet.has(m[1])) {
      // skip until next PR heading or EOF
      let j = i + 1;
      while (j < lines.length && !/^##\s+PR\s+#\d+/.test(lines[j])) j++;
      i = j; // removed this block
    } else {
      keep.push(lines[i]);
      i++;
    }
  }
  return keep.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

async function fetchReadlog(owner, repo, path = TARGET_FILE, branch = BRANCH) {
  try {
    const { data } = await octo.repos.getContent({ owner, repo, path, ref: branch });
    const sha = !Array.isArray(data) ? data.sha : undefined;
    const content = !Array.isArray(data) ? Buffer.from(data.content, 'base64').toString('utf8') : '';
    return { content, sha };
  } catch (e) {
    if (e.status === 404) return { content: '# Release / Change Log\n\n', sha: undefined };
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
  return {
    docsRevertCommitSha: data?.commit?.sha || null,
    docFileSha: data?.content?.sha || null
  };
}

// Git “revertish”: create a new commit whose tree equals the first parent of the merge commit
async function revertMergeCommit(mergeCommitSha, label) {
  const { data: refData } = await octo.git.getRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}` });
  const tipSha = refData.object.sha;

  const { data: target } = await octo.git.getCommit({ owner: OWNER, repo: REPO, commit_sha: mergeCommitSha });
  if (!target.parents?.length) throw new Error('Target commit has no parents; cannot revert.');
  const parentSha = target.parents[0].sha;

  const { data: parent } = await octo.git.getCommit({ owner: OWNER, repo: REPO, commit_sha: parentSha });
  const treeSha = parent.tree.sha;

  const { data: newCommit } = await octo.git.createCommit({
    owner: OWNER, repo: REPO,
    message: `Revert: "${label || 'merge'}"\n\nThis reverts commit ${mergeCommitSha}.`,
    tree: treeSha,
    parents: [tipSha]
  });
  await octo.git.updateRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}`, sha: newCommit.sha });
  return newCommit.sha;
}

// Optional LLM cleanup (flash-first cascade to avoid pro quota)
async function llmRewrite(original, prNumbers, relatedSummaries) {
  if (!GEMINI_API_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const MODEL_CANDIDATES = ['gemini-1.5-flash', 'gemini-1.5-flash-latest', 'gemini-1.5-pro', 'gemini-1.0-pro'];
    const prompt = `
You are updating a monolithic changelog (READLOG.md).
Remove ONLY the sections whose headings start with these exact markers:
${prNumbers.map(n => `- ## PR #${n}:`).join('\n')}

Also, if any follow-up "doc-only" entries explicitly listed below clearly reference those same PRs, remove them too.

Doc-only notes:
${(relatedSummaries || []).map(s => `- ${s}`).join('\n') || '(none)'}

Return ONLY the final full file content (no fences).
---
${original}
`.trim();

    for (const name of MODEL_CANDIDATES) {
      try {
        const model = genAI.getGenerativeModel({ model: name });
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        });
        const text = result?.response?.text?.();
        if (text && text.trim()) return text.trimEnd() + (text.endsWith('\n') ? '' : '\n');
      } catch (_) { /* try next */ }
    }
  } catch (_) {}
  return null;
}

async function recordRevertTxn({ repoBranchId, target, docsRevertCommitSha, docFileSha, codeRevertCommitSha, newContent, prNumbers }) {
  const newTxnSK = `TXN#${nowIso()}#REVERT`;
  const { Item: head } = await docClient.send(new GetCommand({ TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: 'HEAD' } }));
  const parentHead = head?.latestTxnSK || 'ROOT';

  const item = {
    RepoBranch: repoBranchId,
    SK: newTxnSK,
    parentTxnSK: parentHead,
    type: 'REVERT',
    txnKind: 'REVERT',
    createdAt: nowIso(),
    revertedTxnSK: target.SK,
    prNumbersRemoved: prNumbers,
    docFilePath: TARGET_FILE,
    docFileSha: docFileSha || null,
    docsRevertCommitSha: docsRevertCommitSha || null,
    codeRevertCommitSha: codeRevertCommitSha || null,
    docChangeType: 'UTF8_CONTENT_SHA256',
    docChangeHash: sha256(newContent || '')
  };

  await docClient.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: DYNAMO_TABLE, Item: item } },
      { Put: { TableName: DYNAMO_TABLE, Item: { RepoBranch: repoBranchId, SK: 'HEAD', latestTxnSK: newTxnSK, updatedAt: nowIso() } } }
    ]
  }));

  console.log(`🧾 Recorded REVERT transaction ${newTxnSK} (reverted=${target.SK})`);
}

async function loadTargetAndRelated(owner, repo, targetTxnId) {
  const repoBranchId = `${owner}/${repo}#${BRANCH}`;
  const { Item: target } = await docClient.send(new GetCommand({
    TableName: DYNAMO_TABLE, Key: { RepoBranch: repoBranchId, SK: targetTxnId }
  }));
  if (!target) throw new Error(`Transaction not found: ${targetTxnId}`);
  if (!isTxn(target)) throw new Error(`Key is not a transaction: ${targetTxnId}`);

  // Grab any later DOC_ONLY txns with same conceptKey (if you write one)
  let relatedDocOnly = [];
  if (target.conceptKey) {
    const q = await docClient.send(new QueryCommand({
      TableName: DYNAMO_TABLE,
      KeyConditionExpression: 'RepoBranch = :rb AND begins_with(#sk,:p)',
      ExpressionAttributeNames: { '#sk': 'SK' },
      ExpressionAttributeValues: { ':rb': repoBranchId, ':p': 'TXN#' }
    }));
    relatedDocOnly = (q.Items || []).filter(x => x.txnKind === 'DOC_ONLY' && x.conceptKey === target.conceptKey);
  }
  return { target, relatedDocOnly, repoBranchId };
}

// ===== MAIN =====
(async () => {
  try {
    assertEnv('GITHUB_TOKEN', GITHUB_TOKEN);
    assertEnv('DYNAMODB_TABLE_NAME', DYNAMO_TABLE);

    const { target, relatedDocOnly, repoBranchId } = await loadTargetAndRelated(OWNER, REPO, TARGET_TXN_ID);
    const prNumber = target.prNumber || null;
    const prNumbersToRemove = prNumber ? [String(prNumber)] : [];

    console.log(`🎯 Target txn: ${TARGET_TXN_ID}`);
    console.log(`🧩 Remove PR sections: ${prNumbersToRemove.join(', ') || '(none)'}`);

    // 1) Revert code using true merge commit on main
    let codeRevertCommitSha = null;
    if (target.mergeCommitSha) {
      console.log(`🔁 Reverting merge commit: ${target.mergeCommitSha}`);
      codeRevertCommitSha = await revertMergeCommit(target.mergeCommitSha, target.prTitle || `PR #${prNumber}`);
      console.log(`✅ Code reverted: ${codeRevertCommitSha}`);
    } else {
      console.log('ℹ️ No mergeCommitSha on target txn; skipping code revert.');
    }

    // 2) Revert docs (READLOG.md)
    const { content: currentReadlog, sha: prevSha } = await fetchReadlog(OWNER, REPO, TARGET_FILE, BRANCH);

    // First, try strict heuristic (exact PR sections only)
    let newContent = removePrBlocks(currentReadlog, prNumbersToRemove);

    // If nothing changed (rare), optional LLM cleanup (flash-first cascade)
    if (newContent.trim() === currentReadlog.trim()) {
      const relatedSummaries = relatedDocOnly.map(x => x.message || x.summary || '').filter(Boolean).slice(0, 20);
      const llmContent = await llmRewrite(currentReadlog, prNumbersToRemove, relatedSummaries);
      if (llmContent && llmContent.trim() !== currentReadlog.trim()) {
        newContent = llmContent;
      }
    }

    if (newContent.trim() === currentReadlog.trim()) {
      throw new Error('Docs rewriter produced no change; aborting to avoid no-op commit.');
    }

    const { docsRevertCommitSha, docFileSha } = await commitReadlog(
      OWNER, REPO, TARGET_FILE, newContent, prevSha,
      `docs(revert): remove PR #${prNumber} section(s) (revert ${target.SK})`
    );
    console.log(`✅ Docs reverted: ${docsRevertCommitSha}`);

    // 3) Record REVERT txn
    await recordRevertTxn({
      repoBranchId,
      target,
      docsRevertCommitSha,
      docFileSha,
      codeRevertCommitSha,
      newContent,
      prNumbers: prNumbersToRemove
    });

    console.log('\n✨ Revert completed (code + docs).');
  } catch (err) {
    console.error(`\n❌ Revert failed: ${err.message}`);
    process.exit(1);
  }
})();
