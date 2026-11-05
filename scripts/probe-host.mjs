/* 宿主端探针：以假 ctx 加载 lib/index.js，校验路由注册与各分支逻辑（不依赖 DSH）。仅开发自测。 */
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(__dirname, "..");
const mod = await import(pathToFileURL(path.join(PKG, "lib", "index.js")).href + "?t=" + Date.now());

let failed = false;
function assert(c, m) { if (!c) { console.error("FAIL: " + m); failed = true; } }

assert(mod.name === "dsh-schedule-calendar", "name 错误: " + mod.name);
assert(Array.isArray(mod.inject) && mod.inject.includes("webServer"), "inject 缺 webServer");

let captured = null;
const ctx = {
  webServer: { register: (r) => { captured = r; return () => {}; } },
  effect: (fn) => fn(),
};
mod.apply(ctx);
assert(captured && captured.kind === "prefix" && captured.path === "/schedule-calendar", "路由注册参数不对");

function makeReq(method, url, headers, body) {
  const r = Readable.from(body ? [Buffer.from(body)] : []);
  r.method = method;
  r.url = url;
  r.headers = headers || {};
  return r;
}
function makeRes() {
  const out = { status: 0, headers: null, body: "" };
  return {
    writeHead(s, h) { out.status = s; out.headers = h; },
    end(b) { out.body = b || ""; out.parsed = (() => { try { return JSON.parse(out.body); } catch { return null; } })(); },
    _out: out,
  };
}
async function call(method, url, headers, body) {
  const req = makeReq(method, url, headers, body);
  const res = makeRes();
  await captured.handler(req, res);
  return res._out;
}

/* ---------- 保护用户真实数据：测试前把 store.json 挪走，结束后还原 ---------- */
const STORE = path.join(PKG, "data", "store.json");
const BAK = STORE + ".probe-bak";
let hadStore = false;
if (fs.existsSync(STORE)) { try { fs.renameSync(STORE, BAK); hadStore = true; } catch { /* ignore */ } }

async function run() {
  /* ping */
  let o = await call("GET", "/schedule-calendar/ping");
  assert(o.status === 200 && o.parsed && o.parsed.ok === true && o.parsed.version === "0.3.7", "ping/version 失败: " + o.body);

  /* data GET（无 store → 种子 2 城） */
  o = await call("GET", "/schedule-calendar/data");
  assert(o.status === 200 && o.parsed.ok && o.parsed.data && Array.isArray(o.parsed.data.persons), "data GET 失败: " + o.body);
  assert(o.parsed.data.weatherCities.length === 2, "种子城市数不是 2");

  /* data POST 同源 + 写回 */
  const payload = JSON.parse(JSON.stringify(o.parsed.data));
  payload.todos.push({ id: "t-probe", text: "probe-todo", done: false });
  o = await call("POST", "/schedule-calendar/data", { host: "127.0.0.1:1234", origin: "http://127.0.0.1:1234", "content-type": "application/json" }, JSON.stringify(payload));
  assert(o.status === 200 && o.parsed.ok, "data POST 失败: " + o.body);
  o = await call("GET", "/schedule-calendar/data");
  assert(o.parsed.data.todos.some((t) => t.id === "t-probe"), "写回后读不到新待办");

  /* 跨站 POST 应被拒 / 非 json 415 / 404 */
  o = await call("POST", "/schedule-calendar/data", { host: "127.0.0.1:1234", origin: "http://evil.example", "content-type": "application/json" }, JSON.stringify(payload));
  assert(o.status === 403, "跨站 POST 未被拒: " + o.status);
  o = await call("POST", "/schedule-calendar/data", { host: "h", "content-type": "text/plain" }, "hi");
  assert(o.status === 415, "非 json 未被拒: " + o.status);
  o = await call("GET", "/schedule-calendar/nope");
  assert(o.status === 404, "未知路径未 404: " + o.status);

  /* weather */
  o = await call("GET", "/schedule-calendar/weather?lat=39.9&lon=116.4");
  assert(o.status === 200 && o.parsed && typeof o.parsed.ok === "boolean", "weather 返回非法");
  console.log("weather:", o.parsed.ok ? ("ok days=" + (o.parsed.daily ? o.parsed.daily.time.length : 0)) : ("unavailable " + (o.parsed.error || "")));

  /* holidays */
  o = await call("GET", "/schedule-calendar/holidays?year=" + new Date().getFullYear());
  assert(o.status === 200 && o.parsed && typeof o.parsed.ok === "boolean", "holidays 返回非法");
  console.log("holidays:", o.parsed.ok ? ("ok " + Object.keys(o.parsed.map || {}).length + "条") : ("unavailable " + (o.parsed.error || "")));

  /* lunar */
  o = await call("GET", "/schedule-calendar/lunar?year=2026");
  assert(o.status === 200 && o.parsed && o.parsed.ok === true && o.parsed.days && Object.keys(o.parsed.days).length > 300, "lunar 失败: " + String(o.body).slice(0, 120));
  console.log("lunar: ok " + Object.keys(o.parsed.days).length + "天 2026-11-05=" + ((o.parsed.days["2026-11-05"] || {}).dayCn || ""));

  /* geocode（Nominatim 区级） */
  o = await call("GET", "/schedule-calendar/geocode?q=" + encodeURIComponent("朝阳区"));
  assert(o.status === 200 && o.parsed && typeof o.parsed.ok === "boolean", "geocode 返回非法");
  console.log("geocode:", o.parsed.ok ? ("ok n=" + (o.parsed.results || []).length + " 首个=" + (((o.parsed.results || [])[0]) || {}).fullName) : ("unavailable " + (o.parsed.error || "")));
}

try {
  await run();
} finally {
  /* 清理本测试写入的 store.json，并还原用户真实数据（绝不删除用户数据） */
  try { if (fs.existsSync(STORE)) fs.unlinkSync(STORE); } catch { /* ignore */ }
  if (hadStore) { try { fs.renameSync(BAK, STORE); console.log("restored user store.json"); } catch { /* ignore */ } }
}

console.log(failed ? "\n=== HOST PROBE FAIL ===" : "\n=== HOST PROBE PASS ===");
process.exit(failed ? 1 : 0);
