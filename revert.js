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
const TARGET_FILE = process.env.DOC_LOG_FILE || 'CHANGELOG.md';

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

function renderRevertEntry({ owner, repo, target, prNumber, codeRevertCommitSha }) {
  const date = new Date().toISOString().slice(0, 10);
  const title = target.prTitle || `PR #${prNumber}`;
  const prUrl = prNumber ? `https://github.com/${owner}/${repo}/pull/${prNumber}` : null;

  return [
    `## REVERT of PR #${prNumber}: ${title}`,
    `*Reverted:* ${date} • *Original Merge:* ${target.prMergedAt || 'unknown'} • *Author:* ${target.prAuthor || 'unknown'}`,
    ``,
    `### Summary`,
    `This entry documents a revert of the original change introduced by PR #${prNumber}. No prior changelog entries were removed; the log remains append-only.`,
    ``,
    `### What Changed`,
    target.mergeCommitSha
      ? `- Code reverted to the first parent of merge commit \`${target.mergeCommitSha}\` via new commit \`${codeRevertCommitSha || 'n/a'}\`.`
      : `- Code revert did not specify a merge commit (nothing changed or handled manually).`,
    `- Documentation: earlier entries remain intact; this entry records the revert.`,

    ``,
    `### Links`,
    prUrl ? `- Original PR: ${prUrl}` : null,
    target.mergeCommitSha ? `- Merge commit: \`${target.mergeCommitSha}\`` : null,
    codeRevertCommitSha ? `- Revert commit: \`${codeRevertCommitSha}\`` : null,
    ``,
    `---`,
    ``
  ].filter(Boolean).join('\n');
}

async function fetchChangelog(owner, repo, path = TARGET_FILE, branch = BRANCH) {
  try {
    const { data } = await octo.repos.getContent({ owner, repo, path, ref: branch });
    const sha = !Array.isArray(data) ? data.sha : undefined;
    const content = !Array.isArray(data) ? Buffer.from(data.content, 'base64').toString('utf8') : '';
    return { content, sha };
  } catch (e) {
    if (e.status === 404) return { content: '# Changelog\n\n', sha: undefined };
    throw e;
  }
}

async function recordRevertTxn({ repoBranchId, target, docsRevertCommitSha, docFileSha, codeRevertCommitSha, newSection, prNumbers }) {
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
    docChangeType: 'CHANGELOG_SECTION_SHA256',
    docChangeHash: sha256(newSection || '')
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

    // 2) Append a REVERT entry to the changelog (append-only, latest-first)
    const { content: currentReadlog, sha: prevSha } = await fetchChangelog(OWNER, REPO, TARGET_FILE, BRANCH);
    const section = renderRevertEntry({
      owner: OWNER,
      repo: REPO,
      target,
      prNumber,
      codeRevertCommitSha
    });
    const newContent = [section, currentReadlog || '# Changelog\n\n'].join('\n');

    const { docsRevertCommitSha, docFileSha } = await commitReadlog(
      OWNER, REPO, TARGET_FILE, newContent, prevSha,
      `docs(revert): add REVERT entry for PR #${prNumber} (revert ${target.SK})`
    );
    console.log(`✅ Docs reverted: ${docsRevertCommitSha}`);

    // 3) Record REVERT txn
    await recordRevertTxn({
      repoBranchId,
      target,
      docsRevertCommitSha,
      docFileSha,
      codeRevertCommitSha,
      // store only the appended entry hash (like index.js)
      newSection: section,
      prNumbers: prNumbersToRemove
    });

    console.log('\n✨ Revert completed (code + docs).');
  } catch (err) {
    console.error(`\n❌ Revert failed: ${err.message}`);
    process.exit(1);
  }
})();
