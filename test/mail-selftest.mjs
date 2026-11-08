// dsh-schedule-calendar · 邮件模块 —— 数据链路 + 路由 + toast 自测
// （模拟数据，绝不碰真实邮箱、真实 store.json、真实 mail-*；数据目录全部重定向到临时目录）。
//
// 用法：node test\mail-selftest.mjs
//
// 覆盖：
//   1) 配置：默认 enabled=false、normalize 范围、原子写落盘
//   2) store：追加/去重/增量 listSince/findMail/每账号裁剪
//   3) secrets：describeRecord 只回 configured、set/get/delete 授权码（不写 config）
//   4) 路由：createMailModule().handle 的 /state /config /mock-inject /list /mail/404
//   5) 系统通知：真实执行 scripts/toast.ps1 看退出码
// 界面内弹窗 / 悬浮卡 / 邮件列表面板属客户端 DOM，需挂载后目视验证（不在本脚本范围）。

import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const TMP = mkdtempSync(join(tmpdir(), "dsh-schedule-mail-selftest-"));
process.env.DSH_SCHEDULE_CALENDAR_MAIL_DATA_DIR = TMP;

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || "" });
  console.log((cond ? "PASS" : "FAIL") + " · " + name + (detail ? " — " + detail : ""));
}

// ── 1) 配置 ──
const { loadConfig, saveConfig, DATA_DIR, CONFIG_PATH, STORE_PATH } = await import(
  pathToFileURL(join(SRC, "lib", "mail", "config.js")).href
);
const { loadState, saveState, getAccountState, appendMail, listSince, findMail } = await import(
  pathToFileURL(join(SRC, "lib", "mail", "store.js")).href
);
const { describeRecord, setAuthCode, getAuthCode, deleteAuthCode } = await import(
  pathToFileURL(join(SRC, "lib", "mail", "secrets.js")).href
);

const cfg0 = loadConfig();
check("数据目录重定向到临时目录", DATA_DIR === TMP, "DATA_DIR=" + DATA_DIR);
check("config 首次创建并落盘", existsSync(CONFIG_PATH), "path=" + CONFIG_PATH);
check("默认 enabled=false（不打扰日程）", cfg0.enabled === false, "enabled=" + cfg0.enabled);
check("默认 pollIntervalSec=30", cfg0.pollIntervalSec === 30, "=" + cfg0.pollIntervalSec);
check("默认 snippetChars=120", cfg0.snippetChars === 120, "=" + cfg0.snippetChars);

const cfg1 = saveConfig({
  version: 1,
  enabled: true,
  pollIntervalSec: 5, // 低于下限 → clamp 到 10
  snippetChars: 5000, // 高于上限 → clamp 到 2000
  accounts: [{ id: "acc-1", email: "dsh-mail-selftest@qq.com", label: "测试" }],
});
check("normalize 下限 clamp pollIntervalSec=10", cfg1.pollIntervalSec === 10, "=" + cfg1.pollIntervalSec);
check("normalize 上限 clamp snippetChars=2000", cfg1.snippetChars === 2000, "=" + cfg1.snippetChars);
check("账号入库 1 个", cfg1.accounts.length === 1 && cfg1.accounts[0].imapHost === "imap.qq.com");
check("落盘无 BOM", readFileSync(CONFIG_PATH)[0] !== 0xef, "firstByte=" + readFileSync(CONFIG_PATH)[0]);

// ── 2) store ──
const state = loadState();
const longText = "这是一封用于验证的模拟邮件正文。".repeat(20);
const rec1 = {
  accountId: "acc-a",
  accountLabel: "模拟A",
  uid: 101,
  uidValidity: "1",
  from: { name: "张三", address: "zhangsan@example.com" },
  subject: "第一封：周报",
  date: new Date().toISOString(),
  snippet: Array.from(longText).slice(0, 120).join(""),
  preview: Array.from(longText).slice(0, 2000).join(""),
  hasAttach: true,
  messageId: "m1",
};
const seq1 = appendMail(state, rec1, 200);
saveState(state);
const rec2 = {
  accountId: "acc-b",
  accountLabel: "模拟B",
  uid: 202,
  uidValidity: "9",
  from: { name: "李四", address: "lisi@example.com" },
  subject: "第二封：会议",
  date: new Date().toISOString(),
  snippet: "下午三点会议。",
  preview: "下午三点会议。",
  hasAttach: false,
  messageId: "m2",
};
const seq2 = appendMail(state, rec2, 200);
saveState(state);
check("append 单调 seq", seq1 === 1 && seq2 === 2, "seq1=" + seq1 + " seq2=" + seq2);
check("摘要截断到 120 字", Array.from(rec1.snippet).length === 120, "len=" + Array.from(rec1.snippet).length);
check("同 uid 重复被去重", appendMail(state, { ...rec1 }, 200) === null);
const listAll = listSince(state, 0);
check("list 返回 2 封且新的在前", listAll.items.length === 2 && listAll.items[0].seq === 2, "total=" + listAll.total);
check("since=1 只返回 1 封", listSince(state, 1).items.length === 1);
check("findMail(id) 可查单封", (findMail(state, "2") || {}).subject === "第二封：会议");
check("store 落盘无 BOM", existsSync(STORE_PATH) && readFileSync(STORE_PATH)[0] !== 0xef);

// ── 3) secrets ──
check("describeRecord 未配置 → configured=false", (await describeRecord("acc-1")).configured === false);
await setAuthCode("acc-1", "abcdefghijklmnop", "dsh-mail-selftest@qq.com");
check("setAuthCode 后 getAuthCode 可取回", (await getAuthCode("acc-1")) === "abcdefghijklmnop");
const desc = await describeRecord("acc-1");
check("describeRecord 只回 configured（不含 authCode 值）", desc.configured === true && !("authCode" in desc), JSON.stringify(desc));
const rawCfgTxt = readFileSync(CONFIG_PATH, "utf8");
check("授权码绝不写进 mail-config.json", !rawCfgTxt.includes("abcdefghijklmnop"));
await deleteAuthCode("acc-1");
check("deleteAuthCode 后 configured=false", (await describeRecord("acc-1")).configured === false);

// ── 4) 路由（createMailModule.handle） ──
// 关掉 toast/sound，避免自测时真的弹系统通知。
saveConfig({ enabled: false, notify: { inApp: true, toast: false, sound: false }, mock: { enabled: false } });
const { createMailModule } = await import(pathToFileURL(join(SRC, "lib", "mail", "index.js")).href);
const mod = createMailModule({});
mod.start();

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(s) {
      this.body = s;
      this.done = true;
    },
  };
}
function makeReq(method, path, bodyObj) {
  const listeners = {};
  const req = {
    method,
    url: path,
    headers: { host: "127.0.0.1" },
    on(evt, cb) {
      (listeners[evt] = listeners[evt] || []).push(cb);
      return req;
    },
    destroy() {},
  };
  process.nextTick(() => {
    if (bodyObj !== undefined) (listeners.data || []).forEach((cb) => cb(Buffer.from(JSON.stringify(bodyObj))));
    (listeners.end || []).forEach((cb) => cb());
  });
  return req;
}
async function invoke(method, p, bodyObj) {
  const req = makeReq(method, p, bodyObj);
  const res = makeRes();
  const url = new URL("http://localhost" + p);
  // 真实宿主里 p 传的是 url.pathname（不含 query）；这里照此模拟。
  const pForHandle = url.pathname.replace("/schedule-calendar", "");
  await mod.handle(req, res, pForHandle, url);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

const rState = await invoke("GET", "/schedule-calendar/mail/state");
check("GET /mail/state → ok+enabled", rState.status === 200 && rState.json.ok === true && rState.json.enabled === false);

const rInject = await invoke("POST", "/schedule-calendar/mail/mock-inject");
check("POST /mail/mock-inject → ok+seq", rInject.status === 200 && rInject.json.ok === true && rInject.json.seq >= 1);

const rList = await invoke("GET", "/schedule-calendar/mail/list?since=0");
check("GET /mail/list → 至少 1 封", rList.status === 200 && rList.json.ok === true && rList.json.items.length >= 1);

const firstId = rList.json.items[0].seq;
const rMail = await invoke("GET", "/schedule-calendar/mail/mail?id=" + firstId);
check("GET /mail/mail?id → 单封正文", rMail.status === 200 && rMail.json.ok === true && !!rMail.json.item);

const rCfg = await invoke("GET", "/schedule-calendar/mail/config");
check("GET /mail/config → 配置无授权码", rCfg.status === 200 && rCfg.json.ok === true && !JSON.stringify(rCfg.json).includes("abcdefghijklmnop"));

const rPostCfg = await invoke("POST", "/schedule-calendar/mail/config", { enabled: false });
check("POST /mail/config → ok", rPostCfg.status === 200 && rPostCfg.json.ok === true);

const r404 = await invoke("GET", "/schedule-calendar/mail/nope");
check("未知路由 → 404", r404.status === 404);

mod.stop();

// ── 5) 系统通知链路：直接执行 toast.ps1 看退出码 ──
const ps1 = join(SRC, "scripts", "toast.ps1");
check("toast.ps1 存在", existsSync(ps1), ps1);
if (existsSync(ps1)) {
  const ps = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", ps1, "-Title", "dsh-schedule-calendar 邮件自测", "-Body", "如果你看到这条系统通知，说明 Toast 链路 OK。"],
    { encoding: "utf8", timeout: 20000 },
  );
  check("toast.ps1 退出码 0", ps.status === 0, "status=" + ps.status + " stderr=" + String(ps.stderr || "").slice(0, 120));
}

// ── 汇总 ──
const failed = results.filter((r) => !r.ok);
console.log("\n==== 结果：" + (results.length - failed.length) + "/" + results.length + " 通过 ====");
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
  process.exit(1);
}
process.exit(0);
