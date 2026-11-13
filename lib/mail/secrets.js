// dsh-schedule-calendar · 邮件模块 —— 账号 IMAP 授权码的安全存储。
//
// 适配自 dsh-qq-mail/lib/secrets.js，仅改：
//   - credentials owner 改为 dsh-schedule-calendar，key 前缀 qqmail-<accId>
//     → 记录寻址 "dsh-schedule-calendar/qqmail-<id>"。
//   - 兜底文件改为 <data>/mail-secrets.json（随包 data，仍不进仓库）。
//   - 新增 describeRecord()：只回 {configured}，永不回显授权码值。
//
// 首选（也是唯一）：ctx.credentials 记录 seam（宿主凭据服务，用户私有，不随包走）。
// 按 DS-C 规范 C-12：不再读写任何本地明文凭据文件（原 data/mail-secrets.json 兜底已移除）。
//
// 🔴 授权码只在这两处之一，绝不写进 mail-config.json、绝不进仓库、日志打码。

// 按 DS-C 规范 C-12：凭据只走 ctx.credentials，本文件不再做任何文件 IO。


const CRED_OWNER = "dsh-schedule-calendar";

let credCtx = null;

/** 绑定可选 credentials 服务（ctx.inject(["credentials"], c => bindCredentials(c))）。 */
export function bindCredentials(ctx) {
  try {
    credCtx = ctx && ctx.credentials ? ctx.credentials : null;
  } catch {
    credCtx = null;
  }
  return !!credCtx;
}

export function hasCredentialsSeam() {
  return !!credCtx;
}

/** 规范化账号 id 为 credentials 记录可接受的 <owner>/<key>（owner 固定 dsh-schedule-calendar，key 加 qqmail- 前缀）。 */
function recordKey(accountId) {
  const id =
    String(accountId)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "") || "acc";
  return CRED_OWNER + "/qqmail-" + id;
}

function readLocal() {
  // 按 DS-C 规范 C-12：凭据只走 ctx.credentials，不再读本地明文文件。
  return {};
}

function writeLocal(_obj) {
  // 按 DS-C 规范 C-12：不再落盘明文凭据。
}

function removeLocal(_accountId) {
  // 按 DS-C 规范 C-12：无本地副本可删。
}

/** 写入/更新某账号授权码。 */
export async function setAuthCode(accountId, authCode, email) {
  const code = String(authCode == null ? "" : authCode);
  if (!code) return false;
  if (credCtx) {
    try {
      await credCtx.modifyRecord(recordKey(accountId), async () => ({
        kind: "grant",
        payload: { authCode: code, email: String(email || "") },
      }));
      removeLocal(accountId); // 保证不留明文副本
      return true;
    } catch {
      /* 落到本地兜底 */
    }
  }
  const s = readLocal();
  s[accountId] = { authCode: code, email: String(email || ""), updatedAt: new Date().toISOString() };
  writeLocal(s);
  return true;
}

/** 读取某账号授权码（仅宿主内部使用，绝不回传客户端）。 */
export async function getAuthCode(accountId) {
  if (credCtx) {
    try {
      const rec = await credCtx.readRecord(recordKey(accountId));
      if (rec) {
        const payload = rec.payload || rec;
        if (payload && payload.authCode) return String(payload.authCode);
      }
    } catch {
      /* 落到本地兜底 */
    }
  }
  const s = readLocal();
  const local = s[accountId];
  return local && local.authCode ? String(local.authCode) : null;
}

export async function hasAuthCode(accountId) {
  return !!(await getAuthCode(accountId));
}

export async function deleteAuthCode(accountId) {
  if (credCtx) {
    try {
      await credCtx.deleteRecord(recordKey(accountId));
    } catch {
      /* ignore */
    }
  }
  removeLocal(accountId);
  return true;
}

/** 只描述某账号凭据状态：只回 {configured}，永不回显授权码值。 */
export async function describeRecord(accountId) {
  let configured = false;
  try {
    configured = await hasAuthCode(accountId);
  } catch {
    configured = false;
  }
  return { configured: !!configured };
}

/** 给一组账号生成 { id: 是否已配置授权码 } 映射（供 publicConfig）。 */
export async function authCodeSet(accounts) {
  const out = {};
  for (const a of Array.isArray(accounts) ? accounts : []) {
    try {
      out[a.id] = await hasAuthCode(a.id);
    } catch {
      out[a.id] = false;
    }
  }
  return out;
}
