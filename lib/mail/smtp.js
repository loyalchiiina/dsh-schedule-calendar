// dsh-schedule-calendar · 邮件模块 —— 极简 SMTP 发信（零依赖，QQ 邮箱 465 隐式 TLS）。
//
// 为什么手写而不是引入 nodemailer：
//   本插件目录由 pnpm 管理（node_modules 里有 .pnpm 硬链接树），实测 `npm install` 直接崩
//   （npm error Cannot read properties of null (reading 'matches')），改走 pnpm add 又会改写
//   锁文件、影响 profile 的安装恢复。发信只需要 greeting/EHLO/AUTH LOGIN/MAIL FROM/RCPT TO/
//   DATA/QUIT 七步，node:tls 足够，且完全不碰依赖树。
//
// 约束：
//   - 只做 465 隐式 TLS（QQ / 163 / Gmail 都支持）；不做 STARTTLS 升级。
//   - 正文按 UTF-8 + base64 发送，主题/显示名按 RFC 2047 encoded-word 编码，避免中文乱码。
//   - 任何一步响应码不符即抛错，由调用方转成界面上的一句人话错误。

import { connect as tlsConnect } from "node:tls";

const CRLF = "\r\n";
const TIMEOUT_MS = 25000;

/** 按 SMTP 多行响应切分：最后一行形如 "250 xxx"，之前的续行形如 "250-xxx"。 */
class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.waiter = null;
    this.error = null;
    this.closed = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      this._pump();
    });
    socket.on("error", (err) => {
      this.error = err;
      this._pump();
    });
    socket.on("close", () => {
      this.closed = true;
      this._pump();
    });
  }

  _pump() {
    if (!this.waiter) return;
    const lines = this.buffer.split(CRLF);
    let end = -1;
    // 只看完整的行（最后一个分片可能只到一半）
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) {
        end = i;
        break;
      }
    }
    if (end < 0) {
      if (this.closed || this.error) {
        const w = this.waiter;
        this.waiter = null;
        if (w) w.reject(this.error || new Error("SMTP 连接被关闭"));
      }
      return;
    }
    const reply = lines.slice(0, end + 1);
    this.buffer = lines.slice(end + 1).join(CRLF);
    const w = this.waiter;
    this.waiter = null;
    w.resolve(reply);
  }

  read(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.error) return reject(this.error);
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error("SMTP 响应超时（" + (timeoutMs || TIMEOUT_MS) + "ms 无回应）"));
      }, timeoutMs || TIMEOUT_MS);
      this.waiter = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this._pump();
    });
  }

  write(text) {
    this.socket.write(text);
  }
}

function codeOf(reply) {
  const line = reply[reply.length - 1] || "";
  return Number(String(line).slice(0, 3)) || 0;
}

async function expect(session, want, timeoutMs) {
  const reply = await session.read(timeoutMs);
  const code = codeOf(reply);
  if (code !== want) {
    throw new Error("SMTP 期待 " + want + " 实际 " + code + "：" + reply.join(" | ").slice(0, 300));
  }
  return reply;
}

async function command(session, text, want, timeoutMs) {
  session.write(text + CRLF);
  return expect(session, want, timeoutMs);
}

function base64(text) {
  return Buffer.from(String(text == null ? "" : text), "utf8").toString("base64");
}

/** RFC 2047 encoded-word（中文主题 / 显示名） */
function encodeWord(text) {
  const s = String(text == null ? "" : text);
  if (!s) return "";
  // 纯 ASCII 且不含特殊字符时原样返回，避免收件方把英文主题显示成 =?UTF-8?B?...
  if (/^[\x20-\x7e]*$/.test(s) && !/[\r\n]/.test(s)) return s;
  return "=?UTF-8?B?" + base64(s) + "?=";
}

/** 正文 base64 + 76 字符折行 */
function base64Body(text) {
  const raw = Buffer.from(String(text == null ? "" : text), "utf8").toString("base64");
  const out = [];
  for (let i = 0; i < raw.length; i += 76) out.push(raw.slice(i, i + 76));
  return out.join(CRLF);
}

function normaliseAddressList(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : String(list).split(/[,;，；\s]+/);
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const addr = String(raw || "").trim().replace(/^<|>$/g, "");
    if (!addr || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

/** RFC 5987 百分号编码（filename*=UTF-8''…），中文附件名用它才不会乱码 */
function rfc5987(text) {
  let out = "";
  for (const byte of Buffer.from(String(text || ""), "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9!#$&+\-.^_`|~]/.test(ch)) out += ch;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** 附件名兜底：去路径、去引号/换行（防头部注入），限长 */
function safeName(name) {
  const s = String(name || "")
    .replace(/^.*[\\/]/, "")
    .replace(/[\r\n"\\]/g, "_")
    .trim()
    .slice(0, 180);
  return s || "attachment.bin";
}

/** 已是 base64 的内容重新折到 76 列（SMTP 行宽上限 998，76 是惯例） */
function foldB64(b64) {
  const raw = String(b64 || "").replace(/\s+/g, "");
  const out = [];
  for (let i = 0; i < raw.length; i += 76) out.push(raw.slice(i, i + 76));
  return out.join(CRLF);
}

const MIME_TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  md: "text/markdown",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  gz: "application/gzip",
  tar: "application/x-tar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function guessType(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && MIME_TYPES[m[1]]) || "application/octet-stream";
}

function buildMime({ fromName, fromAddress, to, cc, subject, text, attachments }) {
  const list = Array.isArray(attachments) ? attachments.filter((a) => a && typeof a.base64 === "string" && a.base64) : [];
  const headers = [];
  headers.push("From: " + (fromName ? encodeWord(fromName) + " " : "") + "<" + fromAddress + ">");
  headers.push("To: " + to.map((a) => "<" + a + ">").join(", "));
  if (cc.length) headers.push("Cc: " + cc.map((a) => "<" + a + ">").join(", "));
  headers.push("Subject: " + encodeWord(subject || "(无主题)"));
  headers.push("Date: " + new Date().toUTCString().replace("GMT", "+0000"));
  const domain = String(fromAddress).split("@")[1] || "localhost";
  headers.push("Message-ID: <" + Date.now() + "." + Math.random().toString(36).slice(2, 10) + "@" + domain + ">");
  headers.push("MIME-Version: 1.0");

  if (!list.length) {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: base64");
    return headers.join(CRLF) + CRLF + CRLF + base64Body(text);
  }

  const boundary = "=_dsc_mix_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  headers.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');

  const parts = [];
  parts.push(["Content-Type: text/plain; charset=\"UTF-8\"", "Content-Transfer-Encoding: base64", "", base64Body(text)].join(CRLF));
  for (const a of list) {
    const name = safeName(a.filename);
    const type = String(a.contentType || guessType(name)).replace(/[\r\n"'\\]/g, "") || "application/octet-stream";
    const ascii = /^[\x20-\x7e]*$/.test(name);
    // ASCII 名用 filename="x.pdf"；中文名用 filename*=UTF-8''…（RFC 5987），两者都被主流客户端识别
    const disposition = ascii ? 'filename="' + name + '"' : "filename*=UTF-8''" + rfc5987(name);
    const typeName = ascii ? '; name="' + name + '"' : "";
    parts.push(
      [
        "Content-Type: " + type + typeName,
        "Content-Transfer-Encoding: base64",
        "Content-Disposition: attachment; " + disposition,
        "",
        foldB64(a.base64),
      ].join(CRLF)
    );
  }
  const body = parts.map((p) => "--" + boundary + CRLF + p + CRLF).join("") + "--" + boundary + "--";
  return headers.join(CRLF) + CRLF + CRLF + body;
}

/**
 * 发一封邮件（纯文本正文 + 可选附件）。
 * @param {{host?:string, port?:number, user:string, pass:string, fromName?:string,
 *          to:string|string[], cc?:string|string[], subject:string, text:string,
 *          attachments?: Array<{filename:string, contentType?:string, base64:string}>}} opts
 *   attachments[].base64 是文件原始字节的 base64（不带 data: 前缀），由调用方做大小限制。
 */
export async function sendMail(opts) {
  const host = String(opts.host || "smtp.qq.com");
  const port = Number(opts.port) || 465;
  const user = String(opts.user || "").trim();
  const pass = String(opts.pass || "").replace(/\s+/g, "");
  if (!user) throw new Error("缺少发件邮箱地址");
  if (!pass) throw new Error("缺少 SMTP 授权码");
  const to = normaliseAddressList(opts.to);
  if (!to.length) throw new Error("收件人地址不合法（示例：someone@example.com）");
  const cc = normaliseAddressList(opts.cc);

  const socket = await new Promise((resolve, reject) => {
    const s = tlsConnect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      // 握手完成即取消 socket 级空闲超时：带附件 DATA 阶段服务器可能沉默几十秒，
      // 由每一段 read(timeoutMs) 自己计时，不能让 25s 的空闲超时把连接掐掉。
      s.setTimeout(0);
      resolve(s);
    });
    s.setTimeout(TIMEOUT_MS, () => {
      s.destroy();
      reject(new Error("SMTP 连接超时（" + host + ":" + port + "）"));
    });
    s.once("error", (err) => reject(new Error("SMTP 连接失败：" + String((err && err.message) || err))));
  });

  const session = new SmtpSession(socket);
  const startedAt = Date.now();
  try {
    await expect(session, 220);
    await command(session, "EHLO dsh-schedule-calendar", 250);
    await command(session, "AUTH LOGIN", 334);
    await command(session, base64(user), 334);
    await command(session, base64(pass), 235);
    await command(session, "MAIL FROM:<" + user + ">", 250);
    for (const rcpt of to.concat(cc)) {
      await command(session, "RCPT TO:<" + rcpt + ">", 250);
    }
    await command(session, "DATA", 354, 60000);
    const mime = buildMime({
      fromName: opts.fromName || "",
      fromAddress: user,
      to,
      cc,
      subject: opts.subject,
      text: opts.text,
      attachments: opts.attachments,
    });
    session.write(mime + CRLF + "." + CRLF);
    // 带附件时服务器收完 DATA 才应答，20MB 附件可能要几十秒 → 这一段单独放宽到 3 分钟
    await expect(session, 250, 180000);
    await command(session, "QUIT", 221).catch(() => {});
    const attached = Array.isArray(opts.attachments) ? opts.attachments.filter((a) => a && a.base64) : [];
    return {
      ok: true,
      to,
      cc,
      attachments: attached.length,
      bytes: Buffer.byteLength(mime, "utf8"),
      ms: Date.now() - startedAt,
    };
  } finally {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
}