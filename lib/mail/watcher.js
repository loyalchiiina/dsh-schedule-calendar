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

const INITIAL_BATCH = 50; // 单次最多解析多少封，防刷屏

function charSlice(str, n) {
  return Array.from(String(str == null ? "" : str)).slice(0, n).join("");
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
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
        await client.id({ name: "dsh-schedule-calendar", version: "0.4.0", vendor: "deepseek-harness" });
      }
    } catch (e) {
      this.log("ID command skipped: " + String((e && e.message) || e));
    }
    this.client = client;
    return client;
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
    const status = await client.status("INBOX", { uidNext: true, uidValidity: true, messages: true });
    const uidValidity = status && status.uidValidity != null ? String(status.uidValidity) : null;
    const uidNext = Number(status && status.uidNext) || 1;

    // 首次 / UIDVALIDITY 变更 → 只建基线，不把历史当新邮件。
    if (!acc.baseline || (uidValidity && acc.uidValidity && acc.uidValidity !== uidValidity)) {
      acc.uidValidity = uidValidity;
      acc.lastUid = Math.max(0, uidNext - 1);
      acc.baseline = true;
      acc.lastError = "";
      acc.lastCheckAt = Date.now();
      this.host.saveState();
      this.log("baseline set: uidValidity=" + uidValidity + " lastUid=" + acc.lastUid);
      return;
    }
    acc.uidValidity = uidValidity;
    acc.lastCheckAt = Date.now();

    const fromUid = (Number(acc.lastUid) || 0) + 1;
    let uids = [];
    try {
      uids = await client.search({ uid: fromUid + ":*" }, { uid: true });
    } catch (e) {
      uids = [];
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
    const { simpleParser } = await import("mailparser");
    let maxUid = Number(acc.lastUid) || 0;

    for (const uid of uids) {
      try {
        const msg = await client.fetchOne(uid, { uid: true, envelope: true, internalDate: true, source: true }, { uid: true });
        if (!msg) continue;
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
        const text = (parsed.text && String(parsed.text).trim()) || stripHtml(parsed.html) || "";
        const snippet = charSlice(text, snippetChars) || "(无正文)";
        const preview = charSlice(text, 2000);
        const messageId = String((parsed.messageId || (msg.envelope && msg.envelope.messageId) || "")).replace(/[<>]/g, "");
        const hasAttach = !!(parsed.attachments && parsed.attachments.length);
        const record = {
          accountId: this.account.id,
          accountLabel: this.account.label,
          uid,
          uidValidity,
          from,
          subject: String(subject),
          date,
          snippet,
          preview,
          hasAttach,
          messageId,
        };
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
      if (typeof client.id === "function") await client.id({ name: "dsh-schedule-calendar", version: "0.4.0" });
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
