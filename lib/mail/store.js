// dsh-schedule-calendar · 邮件模块 —— 邮件落盘存储 + 增量游标（ring buffer）。
//
// 适配自 dsh-qq-mail/lib/store.js：STORE_PATH 指向 data/mail-store.json（与日程 store.json 隔离）。
// seq/去重/裁剪/listSince/findMail 逻辑原样保留。
//
// 结构（<data>/mail-store.json，无 BOM，原子写）：
// {
//   version: 1,
//   seq: <单调递增序号，客户端用它做 since 增量拉取>,
//   accounts: { [accountId]: { lastUid, uidValidity, baseline, lastError, lastCheckAt } },
//   mails: [ { seq, accountId, accountLabel, uid, uidValidity, from:{name,address},
//              subject, date, snippet, preview, hasAttach, messageId }, ... ]  // 新的在前
// }
//
// 设计取舍：
//   - 单文件 + 内存态：邮件量级可控（每账号 ring buffer 上限），读写简单。
//   - seq 全局单调：客户端 lastSeq 存 localStorage，增量拉取只看 seq。
//   - 每账号裁剪：超过 storeMaxPerAccount 时保留最新的一批，避免无限增长。

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { STORE_PATH, ensureDirs } from "./config.js";

export function loadState() {
  ensureDirs();
  if (!existsSync(STORE_PATH)) return freshState();
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, "utf8").replace(/^\uFEFF/, ""));
    if (!raw || typeof raw !== "object") return freshState();
    return {
      version: 1,
      seq: Number(raw.seq) || 0,
      accounts: raw.accounts && typeof raw.accounts === "object" ? raw.accounts : {},
      mails: Array.isArray(raw.mails) ? raw.mails : [],
    };
  } catch {
    return freshState();
  }
}

export function freshState() {
  return { version: 1, seq: 0, accounts: {}, mails: [] };
}

export function saveState(state) {
  ensureDirs();
  const tmp = STORE_PATH + ".tmp-" + process.pid + "-" + Date.now();
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, STORE_PATH);
  return state;
}

export function getAccountState(state, accountId) {
  if (!state.accounts[accountId]) {
    state.accounts[accountId] = { lastUid: 0, uidValidity: null, baseline: false, lastError: "", lastCheckAt: 0 };
  }
  return state.accounts[accountId];
}

function trimPerAccount(state, maxPerAccount) {
  const cap = Math.max(20, Number(maxPerAccount) || 200);
  const counts = {};
  const kept = [];
  for (const m of state.mails) {
    const id = m.accountId || "_";
    counts[id] = (counts[id] || 0) + 1;
    if (counts[id] <= cap) kept.push(m);
  }
  state.mails = kept;
}

/**
 * 追加一封新邮件。返回分配到的 seq。调用方随后 saveState()。
 * 去重键：同账号同 uidValidity 同 uid（或同 messageId）已存在则跳过，返回 null。
 */
export function appendMail(state, record, maxPerAccount) {
  const dup = state.mails.some(
    (m) =>
      m.accountId === record.accountId &&
      ((record.uid != null && m.uid === record.uid && m.uidValidity === record.uidValidity) ||
        (record.messageId && m.messageId && m.messageId === record.messageId)),
  );
  if (dup) return null;
  const seq = ++state.seq;
  const item = { seq, ...record };
  state.mails.unshift(item);
  trimPerAccount(state, maxPerAccount);
  return seq;
}

/** 增量列表：seq > sinceSeq 的邮件，新的在前。 */
export function listSince(state, sinceSeq) {
  const since = Number(sinceSeq) || 0;
  const items = state.mails.filter((m) => (Number(m.seq) || 0) > since).sort((a, b) => b.seq - a.seq);
  return { items, latestSeq: state.seq, total: state.mails.length };
}

export function getAll(state) {
  return state.mails.slice().sort((a, b) => b.seq - a.seq);
}

export function findMail(state, key) {
  const k = String(key);
  return state.mails.find((m) => String(m.seq) === k) || null;
}
