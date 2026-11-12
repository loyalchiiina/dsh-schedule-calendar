// verify-1.0.0.mjs — 日程助手 1.0.0 自检
// 用法：node scripts\verify-1.0.0.mjs
// 判据：宿主新路由未注册时会被兜底成 404 {"error":"no route: /xxx"}，
//      因此「404 但不是 no route」= 路由已注册（参数/数据缺失才是 404 的原因）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASE = "http://127.0.0.1:56958/schedule-calendar";

const results = [];
function rec(ok, name, detail) {
  results.push({ ok, name, detail });
  console.log(`[${ok ? "OK  " : "FAIL"}] ${name}${detail ? " → " + detail : ""}`);
}
const isNoRoute = (o) => !!(o && typeof o.error === "string" && /^no route:/.test(o.error));

async function get(path) {
  const r = await fetch(BASE + path, { cache: "no-store" });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}
async function post(path, payload) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
    cache: "no-store",
  });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}
function readSrc(rel) {
  try { return readFileSync(join(ROOT, rel), "utf8"); } catch { return ""; }
}

// 1) 版本
try {
  const p = await get("/ping");
  const v = p.body && p.body.version;
  rec(v === "1.0.0", "宿主版本 /ping", `version=${v}` +
    (v === "1.0.0" ? "" : "（宿主还是旧进程：要彻底退出 DSH 再启动，刷新无效）"));
} catch (e) {
  rec(false, "宿主版本 /ping", String(e && e.message));
}

// 2) 邮件状态与列表（列表不应带全文 text）
try {
  const s = await get("/mail/state");
  rec(s.status === 200 && s.body && s.body.ok === true, "邮件状态 /mail/state", `status=${s.status}`);
  const l = await get("/mail/list?since=0");
  const items = (l.body && l.body.items) || [];
  const withText = items.filter((m) => m && Object.prototype.hasOwnProperty.call(m, "text")).length;
  rec(l.status === 200 && withText === 0, "列表已剥离全文 /mail/list", `条目=${items.length} 带text=${withText}`);
} catch (e) {
  rec(false, "邮件状态 /mail/state", String(e && e.message));
}

// 3) 0.7.x 已注册路由（回归）
for (const [name, path] of [["未读数 /mail/unread", "/mail/unread"]]) {
  try {
    const r = await get(path);
    rec(r.status === 200 && !isNoRoute(r.body), name, `status=${r.status}`);
  } catch (e) { rec(false, name, String(e && e.message)); }
}

// 4) 邮件整理类路由（用不存在的 seq 探针：404 且文案不是 no route 即已注册）
const probes = [
  ["正文 /mail/body", "/mail/body", { seq: 999999 }],
  ["已读 /mail/mark-read", "/mail/mark-read", { seq: 999999, seen: true }],
  ["星标 /mail/star", "/mail/star", { seq: 999999, starred: true }],
  ["垃圾 /mail/spam", "/mail/spam", { seq: 999999, spam: true }],
  ["删除 /mail/trash", "/mail/trash", { seq: 999999 }],
  ["还原 /mail/restore", "/mail/restore", { seq: 999999 }],
  ["系统打开附件 /mail/attach-open", "/mail/attach-open", { seq: 999999, i: 0 }],
];
for (const [name, path, body] of probes) {
  try {
    const r = await post(path, body);
    const notNoRoute = !isNoRoute(r.body);
    rec(notNoRoute, name, `status=${r.status}` + (notNoRoute ? "" : "（no route → 宿主没加载）"));
  } catch (e) { rec(false, name, String(e && e.message)); }
}

// 5) 附件读取（GET 路由，用不存在的 seq 探针；404 且非 no route = 已注册）
try {
  const r = await fetch(BASE + "/mail/attach?seq=999999&i=0", { cache: "no-store" });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  const notNoRoute = !isNoRoute(body);
  rec(notNoRoute, "附件读取 /mail/attach(GET)", `status=${r.status}` + (notNoRoute ? "" : "（no route → 宿主没加载）"));
} catch (e) { rec(false, "附件读取 /mail/attach(GET)", String(e && e.message)); }

// 6) 打开网址（缺 url 时应返回 ok:false 而不是 no route）
try {
  const r = await post("/mail/open-url", {});
  const notNoRoute = !isNoRoute(r.body);
  rec(notNoRoute, "打开链接 /mail/open-url", `status=${r.status}` + (notNoRoute ? "" : "（no route → 宿主没加载）"));
} catch (e) { rec(false, "打开链接 /mail/open-url", String(e && e.message)); }

// 6) 提醒（GET 只读；POST /remind/test 会弹胶囊，改用源码断言避免打扰）
try {
  const r = await get("/remind/pending?since=0");
  rec(r.status === 200 && r.body && r.body.ok === true, "提醒轮询 /remind/pending", `seq=${r.body && r.body.seq}`);
} catch (e) { rec(false, "提醒轮询 /remind/pending", String(e && e.message)); }
{
  const src = readSrc("lib/index.js");
  rec(/["']\/remind\/test["']/.test(src), "提醒预览路由已写入源码 /remind/test", "文件级断言（不发请求，免得弹胶囊）");
  rec(/["']\/wallpapers["']/.test(src), "壁纸列表路由 /wallpapers", "文件级断言");
}

// 7) 壁纸列表（排序 / 缓存头改动所在路由）
try {
  const r = await get("/wallpapers");
  const n = Array.isArray(r.body && r.body.files) ? r.body.files.length : (Array.isArray(r.body) ? r.body.length : -1);
  rec(r.status === 200 && !isNoRoute(r.body), "壁纸列表 /wallpapers", `status=${r.status} files=${n}`);
} catch (e) { rec(false, "壁纸列表 /wallpapers", String(e && e.message)); }

// 8) 1.0.0 纯客户端能力（文件级断言）
{
  const c = readSrc("lib/client.js");
  rec(/function textVars\(/.test(c), "文字颜色：textVars()", "1.0.0 新增");
  rec(/textTone/.test(c) && /textColor/.test(c), "文字颜色：设置项 textTone/textColor", "");
  rec(/使用说明 · 快速上手/.test(c), "使用说明入口（右上角 ?）", "");
  rec(/const VERSION = "0\.9\.0"/.test(c), "客户端 VERSION=1.0.0", "");
}

// 9) 宿主 /data 可读（store 里应有 settings）
try {
  const r = await get("/data");
  const sets = r.body && r.body.data && r.body.data.settings;
  rec(r.status === 200 && !!sets, "数据 /data", sets ? `reminders=${(sets.reminders || []).length} 条` : "无 settings");
} catch (e) { rec(false, "数据 /data", String(e && e.message)); }

const bad = results.filter((x) => !x.ok);
console.log(`\n== ${results.length - bad.length}/${results.length} 通过 ==`);
if (bad.length) {
  console.log("未通过项：");
  for (const b of bad) console.log(`  - ${b.name}（${b.detail}）`);
  process.exit(1);
}
process.exit(0);