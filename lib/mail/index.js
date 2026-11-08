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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_ID, loadConfig, saveConfig, publicConfig } from "./config.js";
import { bindCredentials, authCodeSet, setAuthCode, getAuthCode, deleteAuthCode } from "./secrets.js";
import { loadState, saveState, getAccountState, appendMail, listSince, findMail } from "./store.js";
import { showToast, playSound } from "./toast.js";
import { AccountWatcher, testAccount } from "./watcher.js";

export { PLUGIN_ID };

const MODULE_VERSION = "0.4.0";
const LOG_PREFIX = "[dsh-schedule-calendar] mail";
const MAIL_BASE = "/schedule-calendar/mail"; // 全路径 base（容错用）

const HERE = dirname(fileURLToPath(import.meta.url)); // .../lib/mail
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
function handleNewMail(record) {
  try {
    const maxPer = (RT.cfg && RT.cfg.storeMaxPerAccount) || 200;
    const seq = appendMail(RT.state, record, maxPer);
    if (seq == null) return; // 重复
    saveState(RT.state);
    log("new mail #" + seq + " from=" + (record.from && record.from.address) + " subject=" + record.subject);
    notifyNewMail({ ...record, seq });
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
        onNewMail: (rec) => handleNewMail(rec),
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
    credentialsSeam: !!(RT.ctx && RT.ctx.credentials),
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
    return sendJson(res, 200, { ok: true, items: r.items, latestSeq: r.latestSeq, total: r.total });
  }
  if (req.method === "GET" && pp === "/mail") {
    const m = findMail(RT.state, u.searchParams.get("id") || "");
    return m ? sendJson(res, 200, { ok: true, item: m }) : sendJson(res, 404, { ok: false, error: "not found" });
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
    if (!id) id = "acc-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const accounts = RT.cfg.accounts.slice();
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
