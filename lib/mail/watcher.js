// dsh-schedule-calendar · 邮件模块 —— 单账号 IMAP 轮询器。
//
// 适配自 dsh-qq-mail/lib/imap-watcher.js（逻辑基本原样），仅改日志前缀与 IMAP ID 标识。
//
// 每个启用的账号一个 AccountWatcher：连接 imap.qq.com:993(TLS) → 登录(email + 授权码) →
// 首次记录 UIDNEXT 基线（不把历史当新邮件）→ 之后每 pollIntervalSec 增量拉取新 UID →
// mailparser 解析出发件人/主题/时间/正文摘要 → 交给宿主 onNewMail 落盘+提醒。
//
// 设计要点：
//   - 单账号单连接、串行轮询；出错指数退避（尾延迟最长 5 分钟），避免 QQ 限流/踢线。
//   - 依赖 imapflow / mailparser（纯 JS），动态 import 以便缺失时优雅报错。
//   - UIDVALIDITY 变化 = 邮箱重建 → 重置基线，不当成新邮件洪水。
//   - 所有异常只记 lastError，绝不抛回宿主。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ATTACH_DIR = path.join(PKG_ROOT, "data", "mail-files");
function safeFile(name, i) {
  const base = String(name || "file").replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 80) || ("file-" + i);
  return i + "-" + base;
}

const INITIAL_BATCH = 50; // 单次最多解析多少封，防刷屏
const BACKFILL = 20; // 首次连接回填最近多少封历史邮件（只入库，不提醒）

function charSlice(str, n) {
  return Array.from(String(str == null ? "" : str)).slice(0, n).join("");
}

function stripHtml(html) {
  // 0.6.5：旧版把所有标签一律换成一个空格再 \s+ 压平，
  // 结果是整封 HTML 邮件被挤成一坨连续文字（段落、列表全没了），
  // 图片内容也凭空消失 —— 用户看到的就是「没法阅读」。
  let s = String(html || "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ");
  // 图片先占位，别让"正文全是图"的邮件看起来是空的
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = (tag.match(/\balt\s*=\s*"([^"]*)"/i) || tag.match(/\balt\s*=\s*'([^']*)'/i) || [])[1];
    const a = String(alt || "").trim();
    return a && a.length < 40 ? "[图片：" + a + "]" : "[图片]";
  });
  // 块级元素与 <br> 还原成换行，保住段落结构
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\s*\/?\s*(p|div|tr|li|h[1-6]|blockquote|table|section|article|ul|ol|dl|dd|dt)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&hellip;/gi, "…")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–");
  s = s.replace(/[ \t\u00a0]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// 0.6.5：mailparser 给的 text/plain 常把每个链接写成「[https://…]」，
// 营销/招聘类邮件里链接字符能占到一半以上，读起来就是一串网址。
// 链接占比过高时改用（已结构化的）HTML 文本，并对超长链接降噪。
function looksUrly(s) {
  const str = String(s || "");
  const urls = str.match(/https?:\/\/\S+/g) || [];
  if (!urls.length) return false;
  const n = urls.reduce((a, u) => a + u.length, 0);
  return n / Math.max(1, str.length) > 0.25;
}
function tidyBody(s) {
  return String(s || "")
    .replace(/\[\s*(https?:\/\/[^\]\s]{30,})\s*\]/g, "[链接]")
    .replace(/<(https?:\/\/[^>\s]{30,})>/g, "[链接]")
    .replace(/(https?:\/\/\S{60,})/g, (m) => m.slice(0, 58) + "…")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
function pickBody(parsed) {
  const t = String((parsed && parsed.text) || "").trim();
  const h = stripHtml(parsed && parsed.html);
  if (!t) return tidyBody(h);
  if (h && looksUrly(t) && h.length >= Math.min(200, t.length * 0.3)) return tidyBody(h);
  return tidyBody(t);
}

function firstAddress(env, parsed) {
  try {
    const e = env && Array.isArray(env.from) && env.from[0];
    if (e) return { name: e.name || "", address: e.address || "" };
  } catch {
    /* ignore */
  }
  try {
    const v = parsed && parsed.from && parsed.from.value && parsed.from.value[0];
    if (v) return { name: v.name || "", address: v.address || "" };
  } catch {
    /* ignore */
  }
  return { name: "", address: "" };
}

export class AccountWatcher {
  /**
   * @param {object} host  宿主注入：{ log, getConfig, getState, saveState, onNewMail }
   * @param {object} account 账号配置 { id,label,email,imapHost,imapPort,tls,enabled,pollIntervalSec }
   * @param {string} authCode IMAP 授权码
   */
  constructor(host, account, authCode) {
    this.host = host;
    this.account = account;
    this.authCode = authCode;
    this.client = null;
    this.stopped = false;
    this.busy = false;
    this.timer = null;
    this.errCount = 0;
    this.log = (m) => host.log("[dsh-schedule-calendar] mail[" + account.label + "] " + m);
  }

  intervalMs() {
    const g = this.host.getConfig();
    const sec = this.account.pollIntervalSec || g.pollIntervalSec || 30;
    return Math.max(10, Number(sec) || 30) * 1000;
  }

  start() {
    this.stopped = false;
    this.log("watcher started, interval=" + this.intervalMs() + "ms");
    this._schedule(300); // 启动尽快跑一次
  }

  async stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this._closeClient();
    this.log("watcher stopped");
  }

  _schedule(delay) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._tick(), Math.max(200, delay));
    if (this.timer.unref) this.timer.unref();
  }

  async _tick() {
    if (this.stopped) return;
    if (this.busy) {
      this._schedule(this.intervalMs());
      return;
    }
    this.busy = true;
    let ok = false;
    try {
      await this._poll();
      ok = true;
      this.errCount = 0;
    } catch (error) {
      this.errCount += 1;
      const msg = String((error && error.message) || error);
      this.log("poll error (#" + this.errCount + "): " + msg);
      const acc = this.host.getState().accounts[this.account.id];
      if (acc) {
        acc.lastError = msg;
        acc.lastCheckAt = Date.now();
        this.host.saveState();
      }
      await this._closeClient();
    } finally {
      this.busy = false;
    }
    let next = this.intervalMs();
    if (!ok && this.errCount > 0) {
      next = Math.min(this.intervalMs() * Math.pow(2, Math.min(this.errCount, 5)), 300000);
      this.log("backoff, next poll in " + Math.round(next / 1000) + "s");
    }
    this._schedule(next);
  }

  async _ensureClient() {
    if (this.client && this.client.usable) return this.client;
    if (this.client) {
      await this._closeClient();
    }
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: this.account.imapHost || "imap.qq.com",
      port: Number(this.account.imapPort) || 993,
      secure: this.account.tls !== false,
      auth: { user: this.account.email, pass: this.authCode },
      logger: false,
      tls: { rejectUnauthorized: false },
    });
    client.on("error", (e) => this.log("imap client error: " + String((e && e.message) || e)));
    await client.connect();
    // QQ 邮箱识别客户端：发 IMAP ID 命令（部分账号不发会被拒/异常）。
    try {
      if (typeof client.id === "function") {
        await client.id({ name: "dsh-schedule-calendar", version: "1.0.0", vendor: "deepseek-harness" });
      }
    } catch (e) {
      this.log("ID command skipped: " + String((e && e.message) || e));
    }
    this.client = client;
    await this._ensureMailbox(client);
    return client;
  }

  /**
   * 确保 INBOX 已选中。imapflow 的 status() 不选邮箱，而 search()/fetchOne() 必须作用于
   * 已选中的邮箱；未选中时 search 返回 undefined、fetchOne 抛 "No mailbox is selected"，
   * 旧代码又把 search 异常静默吞成空数组 → 表现为「永远收不到新邮件、日志零报错」（0.5.1 修复）。
   */
  async _ensureMailbox(client) {
    if (client.mailbox && client.mailbox.path) return;
    await client.mailboxOpen("INBOX");
    this.log("mailbox opened: INBOX exists=" + (client.mailbox && client.mailbox.exists));
  }

  async _closeClient() {
    const c = this.client;
    this.client = null;
    if (!c) return;
    try {
      await c.logout();
    } catch {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
  }

  async _poll() {
    const state = this.host.getState();
    const acc = this.host.getState().accounts[this.account.id] || (state.accounts[this.account.id] = {});
    const client = await this._ensureClient();
    await this._ensureMailbox(client);
    const status = await client.status("INBOX", { uidNext: true, uidValidity: true, messages: true });
    const uidValidity = status && status.uidValidity != null ? String(status.uidValidity) : null;
    const uidNext = Number(status && status.uidNext) || 1;

    // 首次 / UIDVALIDITY 变更 → 建基线 + 回填最近 BACKFILL 封历史（历史邮件不提醒）。
    if (!acc.baseline || (uidValidity && acc.uidValidity && acc.uidValidity !== uidValidity)) {
      acc.uidValidity = uidValidity;
      acc.lastUid = Math.max(0, uidNext - 1);
      acc.baseline = true;
      acc.lastError = "";
      acc.lastCheckAt = Date.now();
      this.host.saveState();
      this.log("baseline set: uidValidity=" + uidValidity + " lastUid=" + acc.lastUid);
      try {
        await this._backfill(client, uidNext, uidValidity);
        acc.backfilledAt = Date.now();
        this.host.saveState();
      } catch (e) {
        this.log("backfill failed: " + String((e && e.message) || e));
      }
      return;
    }
    // 历史回填只做一次：旧版存库没有 backfilledAt 字段，重启后补做一次，
    // 避免「基线早已建好、历史永远为空」（0.5.1 修复：用户之前只看到 mock 残留的原因）。
    if (!acc.backfilledAt) {
      try {
        await this._backfill(client, uidNext, uidValidity);
        acc.backfilledAt = Date.now();
        this.host.saveState();
        this.log("deferred backfill done: backfilledAt=" + acc.backfilledAt);
      } catch (e) {
        this.log("deferred backfill failed: " + String((e && e.message) || e));
      }
    }
    acc.uidValidity = uidValidity;
    acc.lastCheckAt = Date.now();

    const fromUid = (Number(acc.lastUid) || 0) + 1;
    let uids = [];
    try {
      const raw = await client.search({ uid: fromUid + ":*" }, { uid: true });
      if (!Array.isArray(raw)) throw new Error("search returned " + String(raw));
      uids = raw;
    } catch (e) {
      // 绝不静默：未选中邮箱时 search 返回 undefined，静默会被误判成「没有新邮件」
      const msg = "search failed: " + String((e && e.message) || e);
      acc.lastError = msg;
      this.host.saveState();
      this.log(msg);
      return;
    }
    uids = (Array.isArray(uids) ? uids : [])
      .map((u) => Number(u))
      .filter((u) => Number.isFinite(u) && u >= fromUid)
      .sort((a, b) => a - b);
    if (uids.length === 0) {
      acc.lastError = "";
      this.host.saveState();
      return;
    }
    if (uids.length > INITIAL_BATCH) uids = uids.slice(uids.length - INITIAL_BATCH);

    const g = this.host.getConfig();
    const snippetChars = Math.max(40, Number(g.snippetChars) || 120);
    let maxUid = Number(acc.lastUid) || 0;

    for (const uid of uids) {
      try {
        const record = await this._parseOne(client, uid, uidValidity, snippetChars);
        if (!record) continue;
        this.host.onNewMail(record);
        if (uid > maxUid) maxUid = uid;
      } catch (e) {
        this.log("fetch uid=" + uid + " failed: " + String((e && e.message) || e));
      }
    }
    acc.lastUid = maxUid;
    acc.lastError = "";
    this.host.saveState();
    this.log("poll ok: " + uids.length + " new, lastUid=" + maxUid);
  }

  /** 解析单封邮件为记录（poll 与 backfill 共用，避免两套逻辑漂移）。 */
  async _parseOne(client, uid, uidValidity, snippetChars) {
    const { simpleParser } = await import("mailparser");
    const msg = await client.fetchOne(
      uid,
      { uid: true, envelope: true, internalDate: true, source: true, flags: true },
      { uid: true },
    );
    if (!msg) return null;
    let parsed = {};
    try {
      parsed = await simpleParser(msg.source);
    } catch {
      parsed = {};
    }
    const from = firstAddress(msg.envelope, parsed);
    const subject = (msg.envelope && msg.envelope.subject) || parsed.subject || "(无主题)";
    const dateRaw = msg.internalDate || (msg.envelope && msg.envelope.date) || parsed.date || new Date();
    const date = dateRaw instanceof Date ? dateRaw.toISOString() : new Date(dateRaw).toISOString();
    const text = pickBody(parsed);
    const snippet = charSlice(text, snippetChars) || "(无正文)";
    const preview = charSlice(text, 2000);
    const messageId = String((parsed.messageId || (msg.envelope && msg.envelope.messageId) || "")).replace(/[<>]/g, "");
    const hasAttach = !!(parsed.attachments && parsed.attachments.length);
    // 0.6.6：附件落盘到 data/mail-files/<uidValidity>-<uid>/，客户端点开邮件就能预览。
    // 此前只记 hasAttach=true，用户点开邮件一个附件都看不到 —— 这就是「附件有时候能看有时候不能看」的收信侧那一半。
    let attachments = [];
    if (hasAttach) {
      try {
        const dir = path.join(ATTACH_DIR, uidValidity + "-" + uid);
        fs.mkdirSync(dir, { recursive: true });
        attachments = parsed.attachments.slice(0, 20).map((a, i) => {
          const nm = safeFile(a.filename, i);
          try {
            fs.writeFileSync(path.join(dir, nm), a.content || Buffer.alloc(0));
          } catch (e) {
            this.log("attach write failed: " + String((e && e.message) || e));
          }
          return {
            i,
            filename: String(a.filename || ("附件" + (i + 1))),
            contentType: String(a.contentType || ""),
            size: Number(a.size || (a.content && a.content.length) || 0),
            file: uidValidity + "-" + uid + "/" + encodeURIComponent(nm),
          };
        });
      } catch (e) {
        this.log("attach save failed: " + String((e && e.message) || e));
      }
    }
    // flags 在 imapflow 里是 Set<string>（\\Seen / \\Answered ...）；兼容数组形态。
    const flags = msg.flags;
    const seen =
      flags && typeof flags.has === "function"
        ? flags.has("\\Seen")
        : Array.isArray(flags)
          ? flags.includes("\\Seen")
          : false;
    return {
      accountId: this.account.id,
      accountLabel: this.account.label,
      uid,
      uidValidity,
      from,
      subject: String(subject),
      date,
      snippet,
      preview,
      text: charSlice(text, 8000),
      hasAttach,
      attachments,
      seen,
      messageId,
    };
  }

  /** 把某封邮件在 IMAP 侧设为已读/未读（界面点开邮件时同步服务器状态，best-effort）。 */
  async setSeen(uid, seen) {
    const client = await this._ensureClient();
    await this._ensureMailbox(client);
    const flags = ["\\Seen"];
    if (seen) await client.messageFlagsAdd(uid, flags, { uid: true });
    else await client.messageFlagsRemove(uid, flags, { uid: true });
    this.log("setSeen uid=" + uid + " -> " + (seen ? "\\Seen" : "unseen"));
  }

  /** 0.7.0：在 IMAP 侧加/去一个自定义 flag（收藏用 \Flagged，垃圾可扩展 keyword），best-effort。 */
  async setFlagged(uid, flag, on) {
    const client = await this._ensureClient();
    await this._ensureMailbox(client);
    const flags = [String(flag || "\\Flagged")];
    if (on) await client.messageFlagsAdd(uid, flags, { uid: true });
    else await client.messageFlagsRemove(uid, flags, { uid: true });
    this.log("setFlagged uid=" + uid + " " + flags[0] + " -> " + (on ? "on" : "off"));
  }

  /** 在 IMAP 侧删除一封邮件（界面删除时同步服务器，best-effort；失败不影响本地删除）。 */
  async removeMail(uid) {
    const client = await this._ensureClient();
    await this._ensureMailbox(client);
    await client.messageDelete(uid, { uid: true });
    this.log("removeMail uid=" + uid + " deleted on server");
  }

  /** 按需取单封正文全文（0.5.x 入库的旧邮件没有缓存 text，点开时补取一次）。 */
  async fetchText(uid) {
    const client = await this._ensureClient();
    await this._ensureMailbox(client);
    const msg = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
    if (!msg || !msg.source) return "";
    const { simpleParser } = await import("mailparser");
    let parsed = {};
    try {
      parsed = await simpleParser(msg.source);
    } catch {
      parsed = {};
    }
    const text = pickBody(parsed);
    return charSlice(text, 8000);
  }

  /**
   * 首次建基线后，把最近 BACKFILL 封历史邮件入库（history=true：只展示、不提醒）。
   * 目的：邮件页不再是空白，用户能立刻确认「接通了」。
   */
  async _backfill(client, uidNext, uidValidity) {
    const g = this.host.getConfig();
    const snippetChars = Math.max(40, Number(g.snippetChars) || 120);
    const last = Math.max(1, Number(uidNext) - 1);
    const first = Math.max(1, last - BACKFILL + 1);
    await this._ensureMailbox(client);
    let uids = [];
    try {
      const raw = await client.search({ uid: first + ":" + last }, { uid: true });
      if (!Array.isArray(raw)) throw new Error("search returned " + String(raw));
      uids = raw;
    } catch (e) {
      this.log("backfill search failed: " + String((e && e.message) || e));
      return;
    }
    uids = (Array.isArray(uids) ? uids : [])
      .map((u) => Number(u))
      .filter((u) => Number.isFinite(u))
      .sort((a, b) => a - b)
      .slice(-BACKFILL);
    if (uids.length === 0) return;
    let n = 0;
    for (const uid of uids) {
      try {
        const record = await this._parseOne(client, uid, uidValidity, snippetChars);
        if (!record) continue;
        this.host.onNewMail(record, { history: true });
        n += 1;
      } catch (e) {
        this.log("backfill uid=" + uid + " failed: " + String((e && e.message) || e));
      }
    }
    this.log("backfill imported " + n + "/" + uids.length + " recent messages");
  }
}

/** 测试某账号能否登录（设置页「测试」按钮用）。 */
export async function testAccount(account, authCode) {
  let client = null;
  try {
    const { ImapFlow } = await import("imapflow");
    client = new ImapFlow({
      host: account.imapHost || "imap.qq.com",
      port: Number(account.imapPort) || 993,
      secure: account.tls !== false,
      auth: { user: account.email, pass: authCode },
      logger: false,
      tls: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      if (typeof client.id === "function") await client.id({ name: "dsh-schedule-calendar", version: "1.0.0" });
    } catch {
      /* ignore */
    }
    const status = await client.status("INBOX", { messages: true, uidNext: true });
    return { ok: true, messages: Number(status && status.messages) || 0 };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch {
        try {
          client.close();
        } catch {
          /* ignore */
        }
      }
    }
  }
}
