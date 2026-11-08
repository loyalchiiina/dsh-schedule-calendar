// dsh-schedule-calendar · 邮件模块 —— 运行时配置与存储路径。
//
// 适配自 dsh-qq-mail/lib/config.js，仅改：
//   - 落盘目录：<packages>/data（schedule 的数据随包走，不是 ~/.dsh/data），
//     文件名改为 mail-config.json / mail-store.json / mail-secrets.json，
//     与日程 store.json 完全隔离（🔴 绝不碰 data/store.json）。
//   - 默认 enabled:false（未显式开启绝不启动任何 IMAP / 定时器，不打扰现有日程）。
//   - 测试钩子：设 DSH_SCHEDULE_CALENDAR_MAIL_DATA_DIR 可把整个数据目录挪走（自测用）。
//
// 🔴 账号 IMAP 授权码【绝不】进本文件：走 lib/mail/secrets.js。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "dsh-schedule-calendar";

// 本文件位于 <pkg>/lib/mail/config.js → 上溯两级到包根。
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..", "..");

function resolveDataDir() {
  const fromEnv = process.env.DSH_SCHEDULE_CALENDAR_MAIL_DATA_DIR;
  if (fromEnv !== undefined && String(fromEnv).trim().length > 0) return resolve(String(fromEnv).trim());
  return join(PKG_ROOT, "data");
}

export const DATA_DIR = resolveDataDir();
export const CONFIG_PATH = join(DATA_DIR, "mail-config.json");
export const STORE_PATH = join(DATA_DIR, "mail-store.json");
export const SECRETS_PATH = join(DATA_DIR, "mail-secrets.json");

export function ensureDirs() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

/** 默认配置（首次启动写盘的就是它）。enabled 默认 false：未开启绝不启动 IMAP/定时器。 */
export function defaultConfig() {
  return {
    version: 1,
    enabled: false,
    pollIntervalSec: 30,
    snippetChars: 120,
    storeMaxPerAccount: 200,
    notify: { inApp: true, toast: true, sound: true },
    mock: { enabled: false, intervalSec: 30 },
    accounts: [
      // { id, label, email, imapHost:"imap.qq.com", imapPort:993, tls:true,
      //   enabled:true, pollIntervalSec:null(继承全局) }
    ],
  };
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 合并/规整外部配置，保证结构完整、范围合法。 */
export function normalizeConfig(raw) {
  const d = defaultConfig();
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {
    version: 1,
    // 🔴 只有显式 true 才开启；undefined/false 都是关闭（默认 false）。
    enabled: src.enabled === true,
    pollIntervalSec: clampInt(src.pollIntervalSec, 10, 3600, d.pollIntervalSec),
    snippetChars: clampInt(src.snippetChars, 40, 2000, d.snippetChars),
    storeMaxPerAccount: clampInt(src.storeMaxPerAccount, 20, 2000, d.storeMaxPerAccount),
    notify: {
      inApp: !(src.notify && src.notify.inApp === false),
      toast: !(src.notify && src.notify.toast === false),
      sound: !(src.notify && src.notify.sound === false),
    },
    mock: {
      enabled: !!(src.mock && src.mock.enabled),
      intervalSec: clampInt(src.mock && src.mock.intervalSec, 10, 3600, d.mock.intervalSec),
    },
    accounts: [],
  };
  const seen = new Set();
  for (const a of Array.isArray(src.accounts) ? src.accounts : []) {
    if (!a || typeof a !== "object") continue;
    const id = String(a.id || "").trim();
    const email = String(a.email || "").trim();
    if (!id || !email || seen.has(id)) continue;
    seen.add(id);
    out.accounts.push({
      id,
      label: String(a.label || email).trim() || email,
      email,
      imapHost: String(a.imapHost || "imap.qq.com").trim() || "imap.qq.com",
      imapPort: clampInt(a.imapPort, 1, 65535, 993),
      tls: a.tls !== false,
      enabled: a.enabled !== false,
      pollIntervalSec: a.pollIntervalSec == null ? null : clampInt(a.pollIntervalSec, 10, 3600, 30),
    });
  }
  return out;
}

export function loadConfig() {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, ""));
    return normalizeConfig(raw);
  } catch {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      renameSync(CONFIG_PATH, CONFIG_PATH + ".broken-" + stamp);
    } catch {
      /* ignore */
    }
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
}

/** 原子写（tmp + rename），无 BOM。 */
export function saveConfig(cfg) {
  ensureDirs();
  const norm = normalizeConfig(cfg);
  const tmp = CONFIG_PATH + ".tmp-" + process.pid + "-" + Date.now();
  writeFileSync(tmp, JSON.stringify(norm, null, 2) + "\n", "utf8");
  renameSync(tmp, CONFIG_PATH);
  return norm;
}

/** 把 bundle 行的 config 浅层覆盖到文件配置上（仅显式给出的键）。 */
export function applyBundleOverride(cfg, override) {
  if (!override || typeof override !== "object") return cfg;
  const merged = { ...cfg };
  for (const k of ["enabled", "pollIntervalSec", "snippetChars", "storeMaxPerAccount"]) {
    if (override[k] !== undefined) merged[k] = override[k];
  }
  if (override.notify && typeof override.notify === "object") merged.notify = { ...merged.notify, ...override.notify };
  if (override.mock && typeof override.mock === "object") merged.mock = { ...merged.mock, ...override.mock };
  if (Array.isArray(override.accounts)) merged.accounts = override.accounts;
  return normalizeConfig(merged);
}

/** 去掉任何机密、并补上「是否已配置授权码」，供客户端安全展示。 */
export function publicConfig(cfg, authCodeSet) {
  return {
    ...cfg,
    accounts: cfg.accounts.map((a) => ({
      ...a,
      hasAuthCode: !!(authCodeSet && authCodeSet[a.id]),
    })),
  };
}
