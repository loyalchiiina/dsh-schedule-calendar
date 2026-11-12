// dsh-schedule-calendar · 邮件模块 —— 装配 + 生命周期（内置功能模块）。
//
// 适配自 dsh-qq-mail/lib/index.js：把原来独立的宿主半边改造成可被
// dsh-schedule-calendar 的 handler 委派的子模块，暴露：
//
//   export function createMailModule(ctx) → { start, stop, handle(req,res,p,url) }
//
// 路由 base 固定 /schedule-calendar/mail（相对宿主 ROUTE_PREFIX=/schedule-calendar，
// 本模块只处理 p 里 /mail 之后的部分；同时兼容直接传全路径与旧的 /api 前缀）：
//   GET  /schedule-calendar/mail/state          状态快照（账号/seq/配置/credentialsSeam）
//   GET  /schedule-calendar/mail/list?since=   增量邮件
//   GET  /schedule-calendar/mail/mail?id=      单封正文预览
//   GET  /schedule-calendar/mail/config        配置（含每账号 hasAuthCode，不含授权码）
//   POST /schedule-calendar/mail/config        存全局设置 + 账号元信息
//   POST /schedule-calendar/mail/account/save  增/改账号（可带 authCode，走 secrets）
//   POST /schedule-calendar/mail/account/delete 删账号（含授权码）
//   POST /schedule-calendar/mail/account/test  测试账号登录
//   POST /schedule-calendar/mail/mock-inject   注入一封模拟邮件（验证四条提醒链路）
//
// 默认 enabled:false：未开启绝不启动任何 IMAP / 定时器，不打扰现有日程。
// 数据/配置/授权码全部走 data/mail-*.json，与日程 store.json 完全隔离。

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { PLUGIN_ID, loadConfig, saveConfig, publicConfig } from "./config.js";
import { bindCredentials, hasCredentialsSeam, authCodeSet, setAuthCode, getAuthCode, deleteAuthCode } from "./secrets.js";
import { loadState, saveState, getAccountState, appendMail, listSince, findMail } from "./store.js";
import { showToast, playSound } from "./toast.js";
import { AccountWatcher, testAccount } from "./watcher.js";
import { sendMail } from "./smtp.js";

export { PLUGIN_ID };

const MODULE_VERSION = "1.0.0";
const LOG_PREFIX = "[dsh-schedule-calendar] mail";
const MAIL_BASE = "/schedule-calendar/mail"; // 全路径 base（容错用）
// 附件上限：单封 8MB/个、合计 20MB（base64 会膨胀 4/3，故请求体上限给到 28MB）
const MAX_ATTACH_ONE = 8 * 1024 * 1024;
const MAX_ATTACH_TOTAL = 20 * 1024 * 1024;
const MAX_SEND_BODY = 28 * 1024 * 1024;

const HERE = dirname(fileURLToPath(import.meta.url)); // .../lib/mail
// 收信附件落盘目录（与 watcher.js 的 ATTACH_DIR 必须一致）
const ATTACH_DIR = join(HERE, "..", "..", "data", "mail-files");

// 0.7.2：发信附件也要落盘到同一目录树（sent-<seq>/），否则「已发送」里的附件
// 既没缩略图、也没法交给 Windows 默认应用打开 —— 服务器上的副本我们没同步。
function safeAttachName(name, i) {
  const base = String(name || ("附件" + (i + 1))).replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "_").trim();
  return (base || "附件" + (i + 1)).slice(0, 120);
}
const PKG_VERSION = (function () {
  try {
    return JSON.parse(readFileSync(join(HERE, "..", "..", "package.json"), "utf8")).version || MODULE_VERSION;
  } catch {
    return MODULE_VERSION;
  }
})();

// 保存 createMailModule 传入的宿主 ctx（start 时使用）。
let moduleCtx = null;

// 模块级运行态（同一宿主进程单实例；createMailModule 复用）。
const RT = {
  ctx: null,
  cfg: null,
  state: null,
  watchers: new Map(), // accountId -> AccountWatcher
  mockTimer: null,
  bootTimer: null,
  started: false,
  log: (m) => {
    try {
      if (RT.ctx && RT.ctx.logger && RT.ctx.logger.info) RT.ctx.logger.info(m);
      else console.log(m);
    } catch {
      /* ignore */
    }
  },
};

function log(m) {
  RT.log(LOG_PREFIX + " " + m);
}

// ── 提醒：新邮件到达时（toast + sound；inApp 由客户端轮询 list 后自行弹） ──
function notifyNewMail(record) {
  const cfg = RT.cfg || {};
  const n = cfg.notify || {};
  if (n.toast !== false) {
    try {
      showToast({
        title: "新邮件 · " + (record.accountLabel || "QQ邮箱"),
        body:
          (record.from && (record.from.name || record.from.address) ? (record.from.name || record.from.address) + "：" : "") +
          record.subject,
        sound: false,
      });
    } catch (error) {
      log("toast failed: " + String((error && error.message) || error));
    }
  }
  if (n.sound !== false) {
    try {
      playSound();
    } catch (error) {
      log("sound failed: " + String((error && error.message) || error));
    }
  }
}

// 宿主侧「新邮件」总入口：落盘 → 提醒（客户端靠 seq 增量自行弹窗）
// opts.history=true（首次连接回填的历史邮件）只入库，不 toast / 不响铃。
function handleNewMail(record, opts) {
  try {
    const history = !!(opts && opts.history);
    const maxPer = (RT.cfg && RT.cfg.storeMaxPerAccount) || 200;
    const seq = appendMail(RT.state, { ...record, history }, maxPer);
    if (seq == null) return; // 重复
    saveState(RT.state);
    log((history ? "history mail #" : "new mail #") + seq + " from=" + (record.from && record.from.address) + " subject=" + record.subject);
    if (!history) notifyNewMail({ ...record, seq });
  } catch (error) {
    log("handleNewMail error: " + String((error && error.message) || error));
  }
}

// ── 轮询器调度 ──
async function reconcileWatchers() {
  const cfg = RT.cfg;
  // 🔴 未开启时绝不启动任何 IMAP；同时清掉可能残留的 watcher。
  if (!cfg || !cfg.enabled) {
    stopAllWatchers();
    return;
  }
  const wanted = new Set();
  for (const acc of cfg.accounts) {
    if (!acc.enabled) continue;
    wanted.add(acc.id);
    if (RT.watchers.has(acc.id)) continue;
    let code = null;
    try {
      code = await getAuthCode(acc.id);
    } catch {
      code = null;
    }
    if (!code) {
      const st = getAccountState(RT.state, acc.id);
      st.lastError = "未配置 IMAP 授权码";
      st.lastCheckAt = Date.now();
      saveState(RT.state);
      log("account " + acc.label + " skipped: no auth code");
      continue;
    }
    const w = new AccountWatcher(
      {
        log: (m) => log(m),
        getConfig: () => RT.cfg,
        getState: () => RT.state,
        saveState: () => saveState(RT.state),
        onNewMail: (rec, opts) => handleNewMail(rec, opts),
      },
      acc,
      code,
    );
    RT.watchers.set(acc.id, w);
    w.start();
  }
  // 停掉不再需要的
  for (const [id, w] of Array.from(RT.watchers.entries())) {
    if (!wanted.has(id)) {
      RT.watchers.delete(id);
      try {
        await w.stop();
      } catch {
        /* ignore */
      }
    }
  }
  log("watchers active: [" + Array.from(RT.watchers.keys()).join(",") + "]");
}

function stopAllWatchers() {
  for (const [, w] of RT.watchers) {
    try {
      w.stop();
    } catch {
      /* ignore */
    }
  }
  RT.watchers.clear();
}

// ── 模拟模式：无真实账号时也能验证链路 ──
let mockCounter = 0;
function injectMockMail() {
  mockCounter += 1;
  const now = new Date();
  const rec = {
    accountId: "mock",
    accountLabel: "模拟邮箱",
    uid: 100000 + mockCounter,
    uidValidity: "mock",
    from: { name: "测试发件人 " + mockCounter, address: "noreply@example.com" },
    subject: "【模拟测试】第 " + mockCounter + " 封新邮件",
    date: now.toISOString(),
    snippet:
      "这是一封用于验证提醒链路的模拟邮件。界面内弹窗、悬浮提醒卡、邮件列表面板、声音提示与系统桌面通知应同时触发。时间 " +
      now.toLocaleString("zh-CN"),
    preview:
      "这是一封用于验证提醒链路的模拟邮件。界面内弹窗、悬浮提醒卡、邮件列表面板、声音提示与系统桌面通知应同时触发。\n\n如果你看到了这条系统通知、听到了提示音、悬浮卡也弹出了，说明四条链路全部打通。",
    hasAttach: false,
    messageId: "mock-" + Date.now() + "-" + mockCounter,
  };
  handleNewMail(rec);
  return rec;
}

function startMockTimer() {
  stopMockTimer();
  if (!(RT.cfg && RT.cfg.enabled && RT.cfg.mock && RT.cfg.mock.enabled)) return;
  const sec = Math.max(10, Number(RT.cfg.mock.intervalSec) || 30);
  RT.mockTimer = setInterval(() => injectMockMail(), sec * 1000);
  if (RT.mockTimer.unref) RT.mockTimer.unref();
  log("mock timer started, interval=" + sec + "s");
}
function stopMockTimer() {
  if (RT.mockTimer) {
    clearInterval(RT.mockTimer);
    RT.mockTimer = null;
  }
}

// ── HTTP 工具 ──
function sendJson(res, status, obj) {
  try {
    const body = JSON.stringify(obj);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(body);
  } catch {
    try {
      res.end("{}");
    } catch {
      /* ignore */
    }
  }
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > (limit || 2 * 1024 * 1024)) {
        reject(new Error("body too large"));
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function buildStatePayload() {
  let cfg = RT.cfg;
  let state = RT.state;
  if (!cfg) { try { cfg = loadConfig(); } catch (e) { cfg = null; } }
  if (!state) { try { state = loadState(); } catch (e) { state = null; } }
  if (!RT.cfg && cfg) RT.cfg = cfg;
  if (!RT.state && state) RT.state = state;
  const c = cfg || { enabled: false, pollIntervalSec: 30, snippetChars: 120, storeMaxPerAccount: 200, notify: { inApp: true, toast: true, sound: true }, mock: { enabled: false, intervalSec: 30 }, accounts: [] };
  const st0 = state || { seq: 0, accounts: {}, mails: [] };
  const accs = Array.isArray(c.accounts) ? c.accounts : [];
  let codes = {};
  try {
    codes = await authCodeSet(accs);
  } catch {
    codes = {};
  }
  return {
    ok: true,
    version: PKG_VERSION,
    enabled: !!c.enabled,
    pollIntervalSec: c.pollIntervalSec,
    snippetChars: c.snippetChars,
    storeMaxPerAccount: c.storeMaxPerAccount,
    notify: c.notify,
    mock: c.mock,
    latestSeq: st0.seq || 0,
    total: (st0.mails || []).length,
    // 🔴 绝不直读 RT.ctx.credentials：Cordis 未 inject 时读属性会抛
    // "cannot get property credentials without inject"，让整条状态接口 500。
    credentialsSeam: hasCredentialsSeam(),
    accounts: accs.map((a) => {
      const st = (st0.accounts && st0.accounts[a.id]) || {};
      return {
        id: a.id,
        label: a.label,
        email: a.email,
        imapHost: a.imapHost,
        imapPort: a.imapPort,
        tls: a.tls,
        enabled: a.enabled,
        pollIntervalSec: a.pollIntervalSec,
        hasAuthCode: !!codes[a.id],
        lastError: st.lastError || "",
        lastCheckAt: st.lastCheckAt || 0,
        baseline: !!st.baseline,
        lastUid: st.lastUid || 0,
      };
    }),
  };
}

// 把传入的 p（可能是 /mail/state、/schedule-calendar/mail/state、/state 或旧 /api/state）
// 归一化为 /state 之类。url 为宿主已解析好的 URL 对象（可缺省）。
function normalizePath(p, url) {
  let pp = String(p || (url && url.pathname) || "/");
  // 容错：即使调用方把 "?query" / "#hash" 带进来也先剥掉（正常宿主传的是 url.pathname）。
  const qcut = pp.search(/[?#]/);
  if (qcut >= 0) pp = pp.slice(0, qcut);
  if (pp.startsWith(MAIL_BASE)) pp = pp.slice(MAIL_BASE.length) || "/";
  else if (pp.startsWith("/mail/")) pp = pp.slice("/mail".length) || "/";
  else if (pp === "/mail") pp = "/";
  // 容错旧的 /api 前缀
  if (pp === "/api") pp = "/";
  else if (pp.startsWith("/api/")) pp = pp.slice("/api".length);
  if (!pp.startsWith("/")) pp = "/" + pp;
  return pp;
}

function ensureRuntime() {
  if (!RT.cfg) {
    try { RT.cfg = loadConfig(); } catch (e) { /* ignore */ }
  }
  if (!RT.state) {
    try { RT.state = loadState(); } catch (e) { /* ignore */ }
  }
}

async function handle(req, res, p, url) {
  let u;
  if (url && typeof url.searchParams !== "undefined") {
    u = url;
  } else {
    try {
      u = new URL(req.url, "http://localhost");
    } catch {
      return sendJson(res, 400, { ok: false, error: "bad url" });
    }
  }
  const pp = normalizePath(p, u);
  ensureRuntime();

  // 只读状态 / 列表
  if (req.method === "GET" && (pp === "/state" || pp === "/" || pp === "/ping")) {
    return sendJson(res, 200, await buildStatePayload());
  }
  if (req.method === "GET" && pp === "/list") {
    const since = Number(u.searchParams.get("since")) || 0;
    const r = listSince(RT.state, since);
    // 列表不带全文（每封最多 8KB，22 封 × 8s 一轮会把 payload 撑到几百 KB）；
    // 全文由点开时的 POST /body 单封取。
    const items = (r.items || []).map((m) => {
      if (!m || !m.text) return m;
      const { text, ...rest } = m;
      return { ...rest, hasText: true };
    });
    return sendJson(res, 200, { ok: true, items, latestSeq: r.latestSeq, total: r.total });
  }
  if (req.method === "GET" && pp === "/mail") {
    const m = findMail(RT.state, u.searchParams.get("id") || "");
    return m ? sendJson(res, 200, { ok: true, item: m }) : sendJson(res, 404, { ok: false, error: "not found" });
  }

  // ── 单封操作：正文 / 已读标记 / 删除（0.6.0） ──
  // 统一按 seq 定位（客户端列表拿到的就是 seq，比 messageId 稳）。
  const findMailBySeq = (seq) => (RT.state && Array.isArray(RT.state.mails)
    ? RT.state.mails.find((m) => m && Number(m.seq) === Number(seq))
    : null);

  if (req.method === "POST" && pp === "/body") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message) });
    }
    const m = findMailBySeq(body.seq);
    if (!m) return sendJson(res, 404, { ok: false, error: "邮件不存在（可能已被删除）" });
    if (m.text) return sendJson(res, 200, { ok: true, seq: m.seq, text: m.text, cached: true });
    // 0.5.x 入库的旧邮件没有缓存全文 → 现取一次并回写 store
    let text = "";
    try {
      const w = RT.watchers.get(m.accountId);
      if (w && typeof w.fetchText === "function" && m.uid) text = await w.fetchText(m.uid);
    } catch (error) {
      log("body fetch failed seq=" + m.seq + ": " + String((error && error.message) || error));
    }
    if (!text) text = String(m.preview || m.snippet || "");
    m.text = text;
    try {
      saveState(RT.state);
    } catch {
      /* ignore */
    }
    return sendJson(res, 200, { ok: true, seq: m.seq, text, cached: false });
  }

  if (req.method === "POST" && pp === "/mark-read") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message) });
    }
    const m = findMailBySeq(body.seq);
    if (!m) return sendJson(res, 404, { ok: false, error: "邮件不存在" });
    const seen = body.seen !== false;
    const was = m.seen === true;
    m.seen = seen;
    try {
      saveState(RT.state);
    } catch {
      /* ignore */
    }
    // IMAP 侧同步（失败只记日志，本地状态已生效）
    if (was !== seen && m.uid) {
      try {
        const w = RT.watchers.get(m.accountId);
        if (w && typeof w.setSeen === "function") await w.setSeen(m.uid, seen);
      } catch (error) {
        log("mark-read sync failed seq=" + m.seq + ": " + String((error && error.message) || error));
      }
    }
    return sendJson(res, 200, { ok: true, seq: m.seq, seen });
  }

  if (req.method === "POST" && pp === "/delete") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message) });
    }
    const m = findMailBySeq(body.seq);
    if (!m) return sendJson(res, 404, { ok: false, error: "邮件不存在" });
    RT.state.mails = (RT.state.mails || []).filter((x) => x && Number(x.seq) !== Number(m.seq));
    try {
      saveState(RT.state);
    } catch {
      /* ignore */
    }
    if (m.uid) {
      try {
        const w = RT.watchers.get(m.accountId);
        if (w && typeof w.removeMail === "function") await w.removeMail(m.uid);
      } catch (error) {
        log("delete sync failed seq=" + m.seq + ": " + String((error && error.message) || error));
      }
    }
    return sendJson(res, 200, { ok: true, seq: m.seq, left: (RT.state.mails || []).length });
  }

  // ── 0.7.0：收藏 / 垃圾邮件 / 垃圾箱（垃圾箱是软删除，可还原；彻底删除仍走 /delete）──
  if (req.method === "POST" && pp === "/star") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message) });
    }
    const m = findMailBySeq(body.seq);
    if (!m) return sendJson(res, 404, { ok: false, error: "邮件不存在" });
    m.starred = body.starred === undefined ? m.starred !== true : !!body.starred;
    try {
      saveState(RT.state);
    } catch {
      /* ignore */
    }
    // IMAP 侧标 \Flagged（失败只记日志，本地状态已生效）
    if (m.uid) {
      try {
        const w = RT.watchers.get(m.accountId);
        if (w && typeof w.setFlagged === "function") await w.setFlagged(m.uid, "\\Flagged", m.starred);
      } catch (error) {
        log("star sync failed seq=" + m.seq + ": " + String((error && error.message) || error));
      }
    }
    return sendJson(res, 200, { ok: true, seq: m.seq, starred: m.starred });
  }

  if (req.method === "POST" && pp === "/spam") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message) });
    }
    const m = findMailBySeq(body.seq);
    if (!m) return sendJson(res, 404, { ok: false, error: "邮件不存在" });
    m.spam = body.spam === undefined ? m.spam !== true : !!body.spam;
    if (m.spam) m.trashed = false; // 标成垃圾就离开垃圾箱，别两头挂着
    try {
      saveState(RT.state);
    } catch {
      /* ignore */
    }
    return sendJson(res, 200, { ok: true, seq: m.seq, spam: m.spam, trashed: !!m.trashed });
  }

  if (req.method === "POST" && pp === "/trash") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message) });
    }
    const m = findMailBySeq(body.seq);
    if (!m) return sendJson(res, 404, { ok: false, error: "邮件不存在" });
    m.trashed = true;
    try {
      saveState(RT.state);
    } catch {
      /* ignore */
    }
    return sendJson(res, 200, { ok: true, seq: m.seq, trashed: true });
  }

  if (req.method === "POST" && pp === "/restore") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message) });
    }
    const m = findMailBySeq(body.seq);
    if (!m) return sendJson(res, 404, { ok: false, error: "邮件不存在" });
    m.trashed = false;
    m.spam = false;
    try {
      saveState(RT.state);
    } catch {
      /* ignore */
    }
    return sendJson(res, 200, { ok: true, seq: m.seq, trashed: false, spam: false });
  }

  if (req.method === "GET" && pp === "/unread") {
    const unread = (RT.state.mails || []).filter((m) => m && m.seen !== true && m.folder !== "sent" && m.trashed !== true && m.spam !== true).length;
    return sendJson(res, 200, { ok: true, unread });
  }

  // ── 收信附件读取（0.6.6）：GET /attach?seq=<邮件seq>&i=<附件序号> ──
  // 附件在 watcher 解析时已落盘到 data/mail-files/，这里只做受控读取，不回源 IMAP。
  if (req.method === "GET" && pp === "/attach") {
    const seq = Number(u.searchParams.get("seq") || 0);
    const idx = Number(u.searchParams.get("i") || 0);
    const m = findMailBySeq(seq);
    if (!m) return sendJson(res, 404, { ok: false, error: "邮件不存在（seq=" + seq + "）" });
    const list = Array.isArray(m.attachments) ? m.attachments : [];
    const a = list[idx];
    if (!a || !a.file) return sendJson(res, 404, { ok: false, error: "这封邮件没有该附件（i=" + idx + "）" });
    let buf;
    try {
      const rel = String(a.file).split("/").map((s) => decodeURIComponent(s)).join("/");
      if (rel.includes("..")) return sendJson(res, 400, { ok: false, error: "非法附件路径" });
      buf = readFileSync(join(ATTACH_DIR, rel));
    } catch {
      return sendJson(res, 404, { ok: false, error: "本地还没有这个附件文件（旧邮件需重新收一次）" });
    }
    const ct = a.contentType || "application/octet-stream";
    const ascii = String(a.filename || "file").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    const disp = "inline; filename=\"" + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(String(a.filename || "file"));
    res.writeHead(200, {
      "content-type": ct,
      "content-length": buf.length,
      "content-disposition": disp,
      "cache-control": "max-age=300",
    });
    res.end(buf);
    return true;
  }


/** 用系统默认关联程序打开（explorer 优先，rundll32 兜底）。
 *  不用 `cmd /c start`：cmd 走 GBK 代码页，路径/链接含中文会静默失败，
 *  且会闪一个控制台窗口（用户铁律：本机插件不许有黑框）。 */
function openWithShell(target) {
  const attempts = [
    ["explorer.exe", [target]],
    ["rundll32.exe", ["url.dll,FileProtocolHandler", target]],
  ];
  let lastErr;
  for (const [exe, args] of attempts) {
    try {
      const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
      if (child && typeof child.unref === "function") child.unref();
      return { ok: true, via: exe };
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr) };
}

  // ── 附件交给 Windows 默认应用打开（0.7.2）：POST /attach-open {seq,i} ──
  // 界面里的 window.open 只能做浏览器内预览，唤不起系统关联程序（DSH 是 Electron 自定义协议）；
  // 所以「用默认应用打开」必须由宿主 spawn cmd /c start，路径限制在 ATTACH_DIR 内。
  if (req.method === "POST" && pp === "/attach-open") {
    let ab;
    try {
      ab = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    }
    const seq = Number((ab && ab.seq) || 0);
    const idx = Number((ab && ab.i) || 0);
    const m = findMailBySeq(seq);
    if (!m) return sendJson(res, 404, { ok: false, error: "邮件不存在（seq=" + seq + "）" });
    const a = (Array.isArray(m.attachments) ? m.attachments : [])[idx];
    if (!a || !a.file) return sendJson(res, 404, { ok: false, error: "这封邮件的附件没有本地副本（0.7.2 之前发出的邮件没有存盘，无法补回）" });
    const rel = String(a.file).split("/").map((s) => decodeURIComponent(s)).join("/");
    if (rel.includes("..")) return sendJson(res, 400, { ok: false, error: "非法附件路径" });
    const abs = join(ATTACH_DIR, rel);
    if (!existsSync(abs)) return sendJson(res, 404, { ok: false, error: "附件文件不在本地（可能被清理过）" });
    const opened = openWithShell(abs);
    if (!opened.ok) return sendJson(res, 500, { ok: false, error: "唤起系统默认应用失败：" + opened.error });
    log("attach open: " + abs);
    return sendJson(res, 200, { ok: true, opened: true, path: abs, filename: a.filename || "" });
  }
  // ── 外部链接交给系统默认浏览器（0.7.2）：POST /open-url {url} ──
  // 邮件正文里的网址在 Electron 自定义协议页面里可能被 CSP 拦掉，
  // 这里统一由宿主 cmd /c start 交给系统默认浏览器打开。
  if (req.method === "POST" && pp === "/open-url") {
    let ub;
    try {
      ub = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    }
    const rawUrl = String((ub && ub.url) || "").trim();
    if (!/^https?:\/\//i.test(rawUrl)) return sendJson(res, 400, { ok: false, error: "只允许 http/https 链接" });
    if (rawUrl.length > 2048) return sendJson(res, 400, { ok: false, error: "链接过长" });
    const openedUrl = openWithShell(rawUrl);
    if (!openedUrl.ok) return sendJson(res, 500, { ok: false, error: "唤起浏览器失败：" + openedUrl.error });
    log("open url: " + rawUrl);
    return sendJson(res, 200, { ok: true, url: rawUrl });
  }

  // ── 发信（0.6.0）：走零依赖 smtp.js，授权码取 credentials ──
  if (req.method === "POST" && pp === "/send") {
    let body;
    try {
      body = await readBody(req, MAX_SEND_BODY);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message) });
    }
    const accList = RT.cfg.accounts || [];
    const wantId = String(body.accountId || "");
    const acc = (wantId ? accList.find((a) => a.id === wantId) : null) || accList.find((a) => a.enabled) || accList[0];
    if (!acc) return sendJson(res, 400, { ok: false, error: "先添加一个邮箱账号再发信" });
    const to = String(body.to || "").trim();
    const subject = String(body.subject || "").trim();
    const text = String(body.text || "");
    if (!to) return sendJson(res, 400, { ok: false, error: "缺少收件人" });
    // 附件：客户端传 [{filename, contentType, base64}]（base64 不带 data: 前缀也兼容带前缀）
    const attachments = [];
    let attachBytes = 0;
    {
      const raw = Array.isArray(body.attachments) ? body.attachments : [];
      for (const a of raw) {
        if (!a || typeof a.base64 !== "string" || !a.base64) continue;
        const b64 = a.base64.startsWith("data:") && a.base64.includes(",") ? a.base64.slice(a.base64.indexOf(",") + 1) : a.base64;
        const name = String(a.filename || "attachment.bin").replace(/^.*[\\/]/, "").replace(/[\r\n"]/g, "_").slice(0, 180) || "attachment.bin";
        let bytes = 0;
        try {
          bytes = Buffer.byteLength(b64, "base64");
        } catch {
          return sendJson(res, 400, { ok: false, error: "附件「" + name + "」内容编码不合法" });
        }
        if (bytes > MAX_ATTACH_ONE) {
          return sendJson(res, 413, { ok: false, error: "附件「" + name + "」超过单个 8MB 上限" });
        }
        attachBytes += bytes;
        if (attachBytes > MAX_ATTACH_TOTAL) {
          return sendJson(res, 413, { ok: false, error: "附件合计超过 20MB 上限，请分几封发" });
        }
        attachments.push({ filename: name, contentType: String(a.contentType || ""), base64: b64 });
      }
    }
    if (!subject && !text && !attachments.length) {
      return sendJson(res, 400, { ok: false, error: "主题和正文不能都为空" });
    }
    let code = "";
    try {
      code = (await getAuthCode(acc.id)) || "";
    } catch {
      code = "";
    }
    if (!code) return sendJson(res, 400, { ok: false, error: "该账号没有保存授权码，先去账号区填写" });
    let result;
    try {
      result = await sendMail({
        host: RT.cfg.smtpHost || "smtp.qq.com",
        port: Number(RT.cfg.smtpPort) || 465,
        user: acc.email,
        pass: code,
        fromName: acc.label || "",
        to,
        cc: body.cc || "",
        subject,
        text,
        attachments,
      });
    } catch (error) {
      const msg = String((error && error.message) || error);
      log("send failed: " + msg);
      return sendJson(res, 200, { ok: false, error: msg });
    }
    // 成功的发信也入本地库（folder:"sent"，客户端「已发送」筛选能看到）
    let seq = null;
    try {
      const maxPer = (RT.cfg && RT.cfg.storeMaxPerAccount) || 200;
      seq = appendMail(
        RT.state,
        {
          accountId: acc.id,
          accountLabel: acc.label,
          uid: 0,
          uidValidity: "sent",
          from: { name: acc.label || "", address: acc.email },
          subject: subject || "(无主题)",
          date: new Date().toISOString(),
          snippet: text.slice(0, 120),
          preview: text.slice(0, 2000),
          text: text.slice(0, 8000),
          hasAttach: attachments.length > 0,
          attachments: attachments.map((a, i) => ({
            i,
            filename: String(a.filename || ("附件" + (i + 1))),
            contentType: String(a.contentType || "application/octet-stream"),
            size: Buffer.byteLength(a.base64, "base64"),
          })),
          seen: true,
          folder: "sent",
          messageId: "",
        },
        maxPer,
      );
      // 0.7.2：附件实体写到 data/mail-files/sent-<seq>/，并补上 file 字段，
      // 让「已发送」里的附件能出缩略图、能交给系统默认应用打开。
      if (seq && attachments.length) {
        try {
          const dirRel = "sent-" + seq;
          mkdirSync(join(ATTACH_DIR, dirRel), { recursive: true });
          const rec = findMailBySeq(seq);
          const saved = attachments.map((a, i) => {
            const nm = safeAttachName(a.filename, i);
            const file = dirRel + "/" + encodeURIComponent(nm);
            try {
              writeFileSync(join(ATTACH_DIR, file), Buffer.from(String(a.base64 || ""), "base64"));
            } catch (error) {
              log("sent attach write failed: " + nm + " " + String((error && error.message) || error));
            }
            return {
              i,
              filename: String(a.filename || ("附件" + (i + 1))),
              contentType: String(a.contentType || "application/octet-stream"),
              size: Buffer.byteLength(String(a.base64 || ""), "base64"),
              file,
            };
          });
          if (rec) rec.attachments = saved;
        } catch (error) {
          log("sent attach dir failed: " + String((error && error.message) || error));
        }
      }
      saveState(RT.state);
    } catch (error) {
      log("sent record append failed: " + String((error && error.message) || error));
    }
    log("send ok to=" + to + " att=" + attachments.length + " ms=" + (result && result.ms));
    return sendJson(res, 200, {
      ok: true,
      seq,
      to: result && result.to,
      ms: result && result.ms,
      attachments: (result && result.attachments) || 0,
    });
  }
  if (req.method === "GET" && pp === "/config") {
    let codes = {};
    try {
      codes = await authCodeSet(RT.cfg.accounts);
    } catch {
      codes = {};
    }
    return sendJson(res, 200, { ok: true, config: publicConfig(RT.cfg, codes) });
  }

  // 保存全局设置 + 账号元信息（不含授权码）
  if (req.method === "POST" && pp === "/config") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message) });
    }
    const next = { ...RT.cfg };
    for (const k of ["enabled", "pollIntervalSec", "snippetChars", "storeMaxPerAccount"]) {
      if (body[k] !== undefined) next[k] = body[k];
    }
    if (body.notify) next.notify = { ...next.notify, ...body.notify };
    if (body.mock) next.mock = { ...next.mock, ...body.mock };
    RT.cfg = saveConfig(next);
    startMockTimer();
    await reconcileWatchers();
    return sendJson(res, 200, { ok: true, state: await buildStatePayload() });
  }

  // 新增/更新账号（可带授权码）
  if (req.method === "POST" && pp === "/account/save") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message) });
    }
    const email = String(body.email || "").trim();
    if (!email) return sendJson(res, 400, { ok: false, error: "邮箱地址不能为空" });
    let id = String(body.id || "").trim();
    const accounts = RT.cfg.accounts.slice();
    // 🔴 同一邮箱只留一个账号：未指定 id 且已有同邮箱账号时复用，
    // 并清掉历史遗留的重复条目（每条都会各起一条 IMAP 连接，互相踢线 → 看起来「不能用」）。
    if (!id) {
      const key = email.toLowerCase();
      const same = accounts.filter((a) => String(a.email || "").trim().toLowerCase() === key);
      if (same.length > 0) {
        id = same[0].id;
        for (const extra of same.slice(1)) {
          try {
            await deleteAuthCode(extra.id);
          } catch {
            /* ignore */
          }
        }
        for (let i = accounts.length - 1; i >= 0; i--) {
          if (accounts[i].id !== id && String(accounts[i].email || "").trim().toLowerCase() === key) accounts.splice(i, 1);
        }
      }
    }
    if (!id) id = "acc-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const idx = accounts.findIndex((a) => a.id === id);
    const meta = {
      id,
      label: String(body.label || email).trim() || email,
      email,
      imapHost: String(body.imapHost || "imap.qq.com").trim() || "imap.qq.com",
      imapPort: Number(body.imapPort) || 993,
      tls: body.tls !== false,
      enabled: body.enabled !== false,
      pollIntervalSec: body.pollIntervalSec == null || body.pollIntervalSec === "" ? null : Number(body.pollIntervalSec),
    };
    if (idx >= 0) accounts[idx] = meta;
    else accounts.push(meta);
    RT.cfg = saveConfig({ ...RT.cfg, accounts });
    if (body.authCode != null && String(body.authCode).length > 0) {
      try {
        await setAuthCode(id, String(body.authCode), email);
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: "授权码保存失败：" + String((e && e.message) || e) });
      }
    }
    await reconcileWatchers();
    return sendJson(res, 200, { ok: true, id, state: await buildStatePayload() });
  }

  if (req.method === "POST" && pp === "/account/delete") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message) });
    }
    const id = String(body.id || "").trim();
    if (!id) return sendJson(res, 400, { ok: false, error: "缺少账号 id" });
    const accounts = RT.cfg.accounts.filter((a) => a.id !== id);
    RT.cfg = saveConfig({ ...RT.cfg, accounts });
    try {
      await deleteAuthCode(id);
    } catch {
      /* ignore */
    }
    try {
      delete RT.state.accounts[id];
      saveState(RT.state);
    } catch {
      /* ignore */
    }
    await reconcileWatchers();
    return sendJson(res, 200, { ok: true, state: await buildStatePayload() });
  }

  if (req.method === "POST" && pp === "/account/test") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message) });
    }
    let email = String(body.email || "").trim();
    let code = body.authCode != null ? String(body.authCode) : "";
    if (body.id) {
      const acc = RT.cfg.accounts.find((a) => a.id === body.id);
      if (acc) email = email || acc.email;
      if (!code) {
        try {
          code = (await getAuthCode(body.id)) || "";
        } catch {
          code = "";
        }
      }
    }
    if (!email) return sendJson(res, 400, { ok: false, error: "缺少邮箱地址" });
    if (!code) return sendJson(res, 400, { ok: false, error: "缺少授权码（QQ 邮箱需在网页版开启 IMAP 后生成授权码）" });
    const acc = {
      email,
      imapHost: String(body.imapHost || "imap.qq.com"),
      imapPort: Number(body.imapPort) || 993,
      tls: body.tls !== false,
    };
    const r = await testAccount(acc, code);
    return sendJson(res, 200, r);
  }

  if (req.method === "POST" && pp === "/purge-mock") {
    const before = Array.isArray(RT.state.mails) ? RT.state.mails.length : 0;
    RT.state.mails = (RT.state.mails || []).filter((m) => m && m.accountId !== "mock");
    saveState(RT.state);
    return sendJson(res, 200, { ok: true, removed: before - RT.state.mails.length, left: RT.state.mails.length });
  }

  if (req.method === "POST" && pp === "/mock-inject") {
    const rec = injectMockMail();
    return sendJson(res, 200, { ok: true, seq: RT.state.seq, item: rec });
  }

  return sendJson(res, 404, { ok: false, error: "no route: " + pp });
}

// ── 生命周期：start / stop ──
function start() {
  if (RT.started) return;
  RT.ctx = moduleCtx;
  RT.started = true;
  log("mail module mounted (v" + MODULE_VERSION + ")");

  // 配置读取
  try {
    RT.cfg = loadConfig();
  } catch (e) {
    log("loadConfig failed, using defaults: " + String((e && e.message) || e));
    RT.cfg = null;
  }
  RT.state = loadState();

  // 凭据 seam：可选绑定（绑定后再 align 一次轮询器）
  try {
    if (moduleCtx && moduleCtx.credentials) bindCredentials(moduleCtx);
  } catch {
    /* ignore */
  }
  try {
    if (moduleCtx && typeof moduleCtx.inject === "function") {
      moduleCtx.inject(["credentials"], (injected) => {
        if (bindCredentials(injected)) {
          log("credentials seam bound");
          reconcileWatchers().catch(() => {});
        }
      });
    }
  } catch {
    /* 无 credentials 服务则走本地兜底 */
  }

  // 延迟 ~600ms 启动（等凭据注入落定）；未开启则不起 watcher/timer。
  RT.bootTimer = setTimeout(() => {
    if (!RT.cfg || !RT.cfg.enabled) {
      log("mail module disabled (enabled=false), watchers/timers not started");
      return;
    }
    reconcileWatchers().catch((e) => log("reconcile error: " + String((e && e.message) || e)));
    startMockTimer();
  }, 600);
  if (RT.bootTimer.unref) RT.bootTimer.unref();
}

function stop() {
  try {
    if (RT.bootTimer) clearTimeout(RT.bootTimer);
  } catch {
    /* ignore */
  }
  RT.bootTimer = null;
  stopMockTimer();
  stopAllWatchers();
  RT.started = false;
  log("mail module stopped");
}

// createMailModule：装配入口。ctx 由 dsh-schedule-calendar 的 apply() 传入。
export function createMailModule(ctx) {
  moduleCtx = ctx || null;
  RT.ctx = moduleCtx;
  return {
    get version() {
      return MODULE_VERSION;
    },
    start,
    stop,
    handle,
    // 便于宿主/测试直接调用
    handleNewMail,
    injectMockMail,
  };
}

export { handleNewMail, injectMockMail, buildStatePayload };
