// dsh-schedule-calendar —— 日程回归保护自测（防并入邮件模块时误碰真实日程数据）。
//
// 用法：node test\schedule-regression.mjs
//
// 断言：
//   1) 真实 <pkg>/data/store.json 前后 SHA256 完全一致（邮件模块读写只落临时目录，绝不碰它）
//   2) 真实 <pkg>/data/defaults.json 前后 SHA256 一致
//   3) 真实 data 目录里不会多出任何 mail-*.json（邮件数据已重定向到临时目录）
//   4) store.json / defaults.json 仍可正常解析为 JSON 对象（结构未损坏）
//   5) 邮件 config 的 DATA_DIR 确实指向临时目录，而非真实 data 目录

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const REAL_DATA = join(SRC, "data");
const STORE_JSON = join(REAL_DATA, "store.json");
const DEFAULTS_JSON = join(REAL_DATA, "defaults.json");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || "" });
  console.log((cond ? "PASS" : "FAIL") + " · " + name + (detail ? " — " + detail : ""));
}
function sha256(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return "<missing>";
  }
}

// 改动前基线
const storeBefore = sha256(STORE_JSON);
const defaultsBefore = sha256(DEFAULTS_JSON);
const dataListingBefore = existsSync(REAL_DATA) ? readdirSync(REAL_DATA).sort().join(",") : "";

// 把邮件数据目录重定向到临时目录，执行一轮邮件数据链路（模拟真实使用）
const TMP = mkdtempSync(join(tmpdir(), "dsh-schedule-regression-"));
process.env.DSH_SCHEDULE_CALENDAR_MAIL_DATA_DIR = TMP;

const { loadConfig, saveConfig, DATA_DIR } = await import(pathToFileURL(join(SRC, "lib", "mail", "config.js")).href);
const { loadState, saveState, appendMail } = await import(pathToFileURL(join(SRC, "lib", "mail", "store.js")).href);
const { setAuthCode } = await import(pathToFileURL(join(SRC, "lib", "mail", "secrets.js")).href);

check("邮件 DATA_DIR 指向临时目录（非真实 data）", DATA_DIR === TMP && DATA_DIR !== REAL_DATA, "DATA_DIR=" + DATA_DIR);

loadConfig();
saveConfig({ enabled: true, accounts: [{ id: "reg-1", email: "reg@example.com" }] });
const st = loadState();
appendMail(
  st,
  {
    accountId: "reg-1",
    accountLabel: "回归",
    uid: 1,
    uidValidity: "1",
    from: { name: "x", address: "x@example.com" },
    subject: "回归测试",
    date: new Date().toISOString(),
    snippet: "s",
    preview: "p",
    hasAttach: false,
    messageId: "reg-1",
  },
  200,
);
saveState(st);
await setAuthCode("reg-1", "regcode", "reg@example.com");

// 改动后对比
const storeAfter = sha256(STORE_JSON);
const defaultsAfter = sha256(DEFAULTS_JSON);
const dataListingAfter = existsSync(REAL_DATA) ? readdirSync(REAL_DATA).sort().join(",") : "";

check("真实 store.json SHA256 前后一致", storeBefore === storeAfter, storeBefore.slice(0, 12) + " vs " + storeAfter.slice(0, 12));
check("真实 defaults.json SHA256 前后一致", defaultsBefore === defaultsAfter, defaultsBefore.slice(0, 12));
check("真实 data 目录文件清单前后一致（无新增 mail-*）", dataListingBefore === dataListingAfter, dataListingAfter);

// 结构完整性
let storeOk = false;
let storeKeys = "";
try {
  const obj = JSON.parse(readFileSync(STORE_JSON, "utf8").replace(/^\uFEFF/, ""));
  storeOk = obj && typeof obj === "object" && !Array.isArray(obj);
  storeKeys = Object.keys(obj).slice(0, 8).join(",");
} catch {
  storeOk = false;
}
check("store.json 仍可解析为 JSON 对象（结构完好）", storeOk, "keys=" + storeKeys);

let defaultsOk = false;
try {
  const obj = JSON.parse(readFileSync(DEFAULTS_JSON, "utf8").replace(/^\uFEFF/, ""));
  defaultsOk = obj && typeof obj === "object";
} catch {
  defaultsOk = false;
}
check("defaults.json 仍可解析", defaultsOk);

// 汇总
const failed = results.filter((r) => !r.ok);
console.log("\n==== 结果：" + (results.length - failed.length) + "/" + results.length + " 通过 ====");
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
  process.exit(1);
}
process.exit(0);
