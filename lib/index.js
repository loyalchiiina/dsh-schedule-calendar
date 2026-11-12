/**
 * dsh-schedule-calendar — host half（宿主端）。
 *
 * 职责（全部走本插件自带的只读/读写 HTTP 路由，客户端只 fetch 根相对路径）：
 *   GET  /schedule-calendar/ping                  → 存活探针
 *   GET  /schedule-calendar/data                  → 读取数据（store.json，缺失时用 defaults.json 种子）
 *   POST /schedule-calendar/data                  → 整体写回数据（原子写）
 *   GET  /schedule-calendar/geocode?q=            → 城市搜索（Open-Meteo Geocoding 代理）
 *   GET  /schedule-calendar/weather?lat=&lon=     → 3 天天气（Open-Meteo Forecast 代理）
 *   GET  /schedule-calendar/holidays?year=        → 中国节假日（timor.tech 代理 + 按年缓存）
 *
 * 数据存放：<插件包根>/data/store.json —— 随插件包一起走，便于打包（用户 2026-11-05 指定）。
 * 失败一律 best-effort 返回 { ok:false, available:false }，不抛到宿主。
 *
 * @module dsh-schedule-calendar
 */

import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createMailModule } from "./mail/index.js";
import { showToast } from "./mail/toast.js";
import { execFile } from "node:child_process";

export const name = "dsh-schedule-calendar";
export const inject = ["webServer"];

const VERSION = "1.0.0";
const ROUTE_PREFIX = "/schedule-calendar";
const PKG_NAME = name;
const REGISTRY = "https://registry.npmmirror.com";
const REGISTRY_PATH = "/dsh-schedule-calendar";
const PKG_REPO_URL = "https://github.com/loyalchiiina/dsh-schedule-calendar";
let MAIL = null;

function resolvePkgRoot() {
  try {
    const here = fileURLToPath(import.meta.url); // .../lib/index.js
    return path.dirname(path.dirname(here));
  } catch {
    return process.cwd();
  }
}

const PKG_ROOT = resolvePkgRoot();
const DATA_DIR = path.join(PKG_ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
// 到点提醒（久坐/喝水/摸鱼/听歌/自定义）：宿主端扫描，不依赖客户端界面是否打开。
const REMIND_FILE = path.join(DATA_DIR, "remind-state.json"); // 每条提醒上次触发时间，防重复
let REMIND_SEQ = 0; // 事件游标：客户端带 since 轮询增量
const REMIND_PENDING = []; // 最近触发、待客户端消费的提醒（内存队列）
const SEED_FILE = path.join(DATA_DIR, "defaults.json");

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  ensureDir();
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function loadStore() {
  let s = readJson(STORE_FILE, null);
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    s = readJson(SEED_FILE, null) || { version: 1 };
  }
  return s;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendErr(res, status, msg) {
  send(res, status, { ok: false, error: String(msg) });
}

/** 只允许同源请求（有 Origin 时其 host 必须等于 Host 头），防跨站写数据。 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.host || "");
  } catch {
    return false;
  }
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function fetchJson(url, ms = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "dsh-schedule-calendar/" + VERSION },
    });
    if (!r.ok) throw new Error("upstream " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function readPkgVersion() {
  try {
    const pj = readJson(path.join(PKG_ROOT, "package.json"), null);
    if (pj && pj.version) return String(pj.version);
  } catch (e) { /* ignore */ }
  return VERSION;
}

function compareVer(a, b) {
  const norm = (v) => String(v || "").replace(/^v/i, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pa = norm(a), pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function detectInstallType() {
  if (PKG_ROOT.indexOf("node_modules") >= 0) return { installType: "registry", depSpec: "", profilePath: "" };
  const cands = [];
  try {
    const dshRoot = path.resolve(PKG_ROOT, "..", "..");
    for (const pf of ["desktop", "xiufu", "web"]) cands.push(path.join(dshRoot, "profiles", pf, "package.json"));
  } catch (e) { /* ignore */ }
  try {
    const home = os.homedir();
    for (const pf of ["desktop", "xiufu", "web"]) cands.push(path.join(home, ".dsh", "profiles", pf, "package.json"));
  } catch (e) { /* ignore */ }
  let cur = PKG_ROOT;
  for (let i = 0; i < 6; i++) { cur = path.dirname(cur); cands.push(path.join(cur, "package.json")); }
  for (const f of cands) {
    const pj = readJson(f, null);
    if (pj && pj.dependencies && Object.prototype.hasOwnProperty.call(pj.dependencies, PKG_NAME)) {
      const spec = String(pj.dependencies[PKG_NAME] || "");
      const isLocal = spec.indexOf("link:") === 0 || spec.indexOf("file:") === 0 || spec.indexOf(".") === 0 || spec.indexOf("/") === 0 || spec.indexOf("local-plugins") >= 0;
      return { installType: isLocal ? "local" : "registry", depSpec: spec, profilePath: f };
    }
  }
  const isLocal = PKG_ROOT.indexOf("local-plugins") >= 0 || fs.existsSync(path.join(PKG_ROOT, ".git"));
  return { installType: isLocal ? "local" : "registry", depSpec: "", profilePath: "" };
}

async function handleUpdateCheck(res) {
  const current = readPkgVersion();
  const det = detectInstallType();
  let latest = "", hasUpdate = false, error = null;
  try {
    const meta = await fetchJson(REGISTRY + REGISTRY_PATH + "/latest", 8000);
    if (meta && meta.version) {
      latest = String(meta.version);
      hasUpdate = compareVer(latest, current) > 0;
    } else {
      error = "registry returned no version";
    }
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }
  return send(res, 200, {
    ok: true,
    available: !error,
    current, runtime: VERSION, latest, hasUpdate,
    installType: det.installType, depSpec: det.depSpec, profilePath: det.profilePath,
    source: REGISTRY + REGISTRY_PATH,
    latestUrl: latest ? REGISTRY + REGISTRY_PATH + "/" + latest : "",
    repo: PKG_REPO_URL, checkedAt: Date.now(), error,
  });
}

async function handleUpdateChangelog(res) {
  const rows = [];
  let error = null, readme = "";
  try {
    const list = await fetchJson("https://api.github.com/repos/loyalchiiina/dsh-schedule-calendar/releases?per_page=3", 8000);
    if (Array.isArray(list)) for (const r of list) rows.push({ tag: r.tag_name, name: r.name, publishedAt: r.published_at, body: String(r.body || "").slice(0, 600), url: r.html_url });
  } catch (e) { error = e && e.message ? e.message : String(e); }
  if (!rows.length) {
    try {
      const pack = await fetchJson(REGISTRY + REGISTRY_PATH, 8000);
      readme = String((pack && pack.readme) || "").slice(0, 1200);
    } catch (e) { if (!error) error = e && e.message ? e.message : String(e); }
  }
  return send(res, 200, { ok: true, releases: rows, readme, error });
}

async function handleUpdateApply(req, res) {
  const ct = req.headers["content-type"] || "";
  if (!ct.includes("application/json")) return sendErr(res, 415, "application/json required");
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendErr(res, 400, "invalid json"); }
  const det = detectInstallType();
  const plan = [
    "1) 备份 profile package.json 与 cordis.patch.yml 到 ~/.dsh/backups/",
    "2) 手动编辑 <profile>/package.json 的 dependencies['dsh-schedule-calendar'] 为目标版本（desktop 由 Electron 独占，dsh plugin 命令会被拒）",
    "3) 在 <profile> 目录执行 pnpm install",
    "4) 彻底退出并重启 DSH 客户端（宿主是 Node 进程，无热重载）",
  ];
  if (det.installType === "local") {
    return send(res, 200, { ok: false, refused: true, reason: "local-dev", installType: det.installType,
      message: "当前为本地开发版（link 安装），请用 git pull 或重新发布，禁止 npm 覆盖安装（会丢本地改动）。", plan });
  }
  if (!body || body.confirm !== true) {
    return send(res, 200, { ok: true, dryRun: true, installType: det.installType, target: body && body.targetVersion,
      message: "需用户明确 confirm:true 才执行；默认只返回计划，不自动安装。", plan });
  }
  return send(res, 501, { ok: false, message: "apply 未实现：本方案推荐只做检查+提示，安装交由人工执行（风险过高）。" });
}

async function handleGeocode(url, res) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return sendErr(res, 400, "q required");
  try {
    // 首选 Nominatim（OSM）：支持中国区/县/街道级，中文名匹配好
    const nu =
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=zh&countrycodes=cn&addressdetails=1&q=" +
      encodeURIComponent(q);
    const nj = await fetchJson(nu);
    const dedupe = (arr) => {
      const out = [];
      for (const p of arr) if (p && out[out.length - 1] !== p) out.push(p);
      return out;
    };
    const nmResults = (Array.isArray(nj) ? nj : [])
      .map((r) => {
        const a = r.address || {};
        const parts = dedupe([a.state, a.city || a.county, a.city_district || a.district || a.town || a.suburb].filter(Boolean));
        const nm = r.name || parts[parts.length - 1] || r.display_name || q;
        const fullName = parts.length ? parts.join("·") + "·" + nm : r.display_name || nm;
        return {
          name: nm,
          fullName,
          latitude: Number(r.lat),
          longitude: Number(r.lon),
          country: "中国",
          type: r.addresstype || r.type || "",
        };
      })
      .filter((x) => isFinite(x.latitude) && isFinite(x.longitude));
    if (nmResults.length) return send(res, 200, { ok: true, source: "nominatim", results: nmResults });

    // 回退 Open-Meteo geocoding（城市级）
    const api =
      "https://geocoding-api.open-meteo.com/v1/search?name=" +
      encodeURIComponent(q) +
      "&count=10&language=zh&format=json";
    const j = await fetchJson(api);
    const results = (j.results || []).map((r) => {
      const parts = [r.admin1, r.admin2, r.admin3].filter(Boolean);
      const pathLabel = parts.join("·");
      return {
        name: r.name,
        fullName: pathLabel ? pathLabel + "·" + r.name : r.name,
        latitude: r.latitude,
        longitude: r.longitude,
        country: r.country || "",
        type: r.feature_code || "",
      };
    });
    return send(res, 200, { ok: true, source: "open-meteo", results });
  } catch (e) {
    return send(res, 200, { ok: false, available: false, error: String(e.message || e) });
  }
}

async function handleWeather(url, res) {
  const lat = url.searchParams.get("lat");
  const lon = url.searchParams.get("lon");
  if (!lat || !lon) return sendErr(res, 400, "lat/lon required");
  try {
    const api =
      "https://api.open-meteo.com/v1/forecast?latitude=" +
      encodeURIComponent(lat) +
      "&longitude=" +
      encodeURIComponent(lon) +
      "&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
      "&timezone=auto&forecast_days=4";
    const j = await fetchJson(api);
    return send(res, 200, {
      ok: true,
      timezone: j.timezone,
      current: j.current,
      daily: j.daily,
    });
  } catch (e) {
    return send(res, 200, { ok: false, available: false, error: String(e.message || e) });
  }
}

/** timor.tech 节假日：{ "MM-DD": { holiday:boolean, name, date } } → { "YYYY-MM-DD": { name, holiday } } */
async function handleHolidays(url, res) {
  const year = String(url.searchParams.get("year") || new Date().getFullYear());
  if (!/^\d{4}$/.test(year)) return sendErr(res, 400, "bad year");
  const cacheFile = path.join(DATA_DIR, "holidays-" + year + ".json");
  try {
    const j = await fetchJson("https://timor.tech/api/holiday/year/" + year);
    const map = {};
    const raw = (j && j.holiday) || {};
    for (const k of Object.keys(raw)) {
      const item = raw[k] || {};
      const dateKey = item.date || year + "-" + k;
      map[dateKey] = { name: item.name || "节假日", holiday: item.holiday !== false };
    }
    const out = { year, fetchedAt: new Date().toISOString(), map };
    try {
      writeJsonAtomic(cacheFile, out);
    } catch {
      /* ignore cache write failure */
    }
    return send(res, 200, { ok: true, ...out });
  } catch (e) {
    const cached = readJson(cacheFile, null);
    if (cached && cached.map) return send(res, 200, { ok: true, cached: true, ...cached });
    return send(res, 200, { ok: false, available: false, error: String(e.message || e) });
  }
}

/* ---------- 农历（solarlunar 3.x；按需加载，失败降级） ---------- */
const requireCJS = createRequire(import.meta.url);
let _solarlunar = undefined;
function getSolarlunar() {
  if (_solarlunar !== undefined) return _solarlunar;
  try {
    const m = requireCJS("solarlunar");
    _solarlunar = m && m.default ? m.default : m;
  } catch {
    _solarlunar = null;
  }
  return _solarlunar;
}
const LUNAR_FEST = { "1-1": "春节", "1-15": "元宵节", "2-2": "龙抬头", "5-5": "端午节", "7-7": "七夕", "7-15": "中元节", "8-15": "中秋节", "9-9": "重阳节", "12-8": "腊八节", "12-23": "小年" };
const SOLAR_FEST = { "1-1": "元旦", "2-14": "情人节", "3-8": "妇女节", "3-12": "植树节", "4-1": "愚人节", "5-1": "劳动节", "5-4": "青年节", "6-1": "儿童节", "7-1": "建党节", "8-1": "建军节", "9-10": "教师节", "10-1": "国庆节", "12-24": "平安夜", "12-25": "圣诞节" };
const _lunarCache = new Map();
/** 一整年每天的农历与节日：{ "YYYY-MM-DD": { lMonth,lDay,isLeap,monthCn,dayCn,term,fest } } */
function handleLunar(url, res) {
  const year = Number(url.searchParams.get("year") || new Date().getFullYear());
  if (!(year >= 1900 && year <= 2100)) return sendErr(res, 400, "bad year");
  const cached = _lunarCache.get(year);
  if (cached) return send(res, 200, { ok: true, year, days: cached });
  const sl = getSolarlunar();
  if (!sl) return send(res, 200, { ok: false, available: false, error: "solarlunar not installed" });
  try {
    const days = {};
    for (let m = 1; m <= 12; m++) {
      const dim = new Date(year, m, 0).getDate();
      for (let d = 1; d <= dim; d++) {
        const r = sl.solar2lunar(year, m, d);
        if (!r || r === -1) continue;
        const key = year + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
        let fest = "";
        if (!r.isLeap && LUNAR_FEST[r.lMonth + "-" + r.lDay]) fest = LUNAR_FEST[r.lMonth + "-" + r.lDay];
        if (SOLAR_FEST[m + "-" + d]) fest = (fest ? fest + "·" : "") + SOLAR_FEST[m + "-" + d];
        days[key] = { lMonth: r.lMonth, lDay: r.lDay, isLeap: r.isLeap, monthCn: r.monthCn, dayCn: r.dayCn, term: r.isTerm ? r.term : "", fest };
      }
    }
    _lunarCache.set(year, days);
    return send(res, 200, { ok: true, year, days });
  } catch (e) {
    return send(res, 200, { ok: false, available: false, error: String(e.message || e) });
  }
}

/* ---------- 行政区划（阿里 DataV，省→市→区，均含中心点经纬度） ---------- */
const _divCache = new Map();
async function fetchDivisions(adcode) {
  const key = String(adcode);
  if (_divCache.has(key)) return _divCache.get(key);
  const u = "https://geo.datav.aliyun.com/areas_v3/bound/" + key + "_full.json";
  const j = await fetchJson(u, 15000);
  const list = (j.features || [])
    .map((f) => {
      const p = f.properties || {};
      const c = p.center || p.centroid || [];
      return { adcode: String(p.adcode || ""), name: p.name, lng: c[0], lat: c[1], childrenNum: p.childrenNum || 0 };
    })
    .filter((x) => x.name && isFinite(x.lng) && isFinite(x.lat));
  _divCache.set(key, list);
  return list;
}
async function handleDivisions(url, res) {
  const adcode = (url.searchParams.get("adcode") || "100000").replace(/\D/g, "") || "100000";
  try {
    const list = await fetchDivisions(adcode);
    return send(res, 200, { ok: true, adcode, list });
  } catch (e) {
    return send(res, 200, { ok: false, available: false, error: String(e.message || e), list: [] });
  }
}
/* 由区/县名反查所属省·市（用于补全老数据缺失的「市」） */
const _resolveCache = new Map();
const _normName = (s) => String(s || "").replace(/(省|市|自治区|特别行政区|自治州|地区|盟|区|县|旗)$/g, "");
async function handleResolve(url, res) {
  const name = (url.searchParams.get("name") || "").trim();
  const province = (url.searchParams.get("province") || "").trim();
  if (!name) return sendErr(res, 400, "name required");
  const ck = name + "|" + province;
  if (_resolveCache.has(ck)) return send(res, 200, _resolveCache.get(ck));
  try {
    const provs = await fetchDivisions("100000");
    let targets = provs;
    if (province) {
      const pn = _normName(province);
      const f = provs.filter((p) => _normName(p.name) === pn || p.name.indexOf(province) >= 0 || province.indexOf(_normName(p.name)) >= 0);
      if (f.length) targets = f;
      else return send(res, 200, { ok: false, error: "province not matched" });
    }
    for (const p of targets) {
      let cities = [];
      try { cities = await fetchDivisions(p.adcode); } catch { continue; }
      for (const ct of cities) {
        if (_normName(ct.name) === _normName(name)) {
          /* 市本身就没有「区」，原来这里把省写进 city、把市写进 district，导致城市名显示成「山东省·济南市·济南市」 */
          const out = { ok: true, province: p.name, city: ct.name, district: "", latitude: ct.lat, longitude: ct.lng, level: "city" };
          _resolveCache.set(ck, out);
          return send(res, 200, out);
        }
        let dists = [];
        try { dists = await fetchDivisions(ct.adcode); } catch { continue; }
        const d = dists.find((x) => _normName(x.name) === _normName(name));
        if (d) {
          const out = { ok: true, province: p.name, city: ct.name, district: d.name, latitude: d.lat, longitude: d.lng, level: "district" };
          _resolveCache.set(ck, out);
          return send(res, 200, out);
        }
      }
    }
    const miss = { ok: false, error: "not found" };
    _resolveCache.set(ck, miss);
    return send(res, 200, miss);
  } catch (e) {
    return send(res, 200, { ok: false, available: false, error: String(e.message || e) });
  }
}

/* ---------- 星座运势 / 黄历（离线本地生成，稳定按日） ---------- */
const SIGN_IDS = ["aries", "taurus", "gemini", "cancer", "leo", "virgo", "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces"];
function _hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
const _F_ALL = ["整体运势平稳，适合主动出击。", "贵人运不错，遇事有人帮。", "小有波折，但都能化解。", "状态在线，做事效率高。", "宜稳不宜急，静待时机。", "灵感在线，适合做决定。"];
const _F_LOVE = ["单身易遇心动对象，主动一点。", "与伴侣相处甜蜜，适合约会。", "沟通顺畅，适合表白心意。", "别太较真，多些包容。", "旧友重逢，可能擦出火花。", "多倾听对方，感情更稳。"];
const _F_WORK = ["工作顺遂，易获认可。", "有新的机会出现，把握住。", "注意细节，避免返工。", "团队协作顺利，进展快。", "适合推进搁置的计划。", "别硬扛，善用他人之力。"];
const _F_MONEY = ["财运不错，适合稳健理财。", "有小偏财，见好就收。", "控制冲动消费。", "投资宜谨慎观望。", "正财稳定，量入为出。", "有意外之财的可能。"];
const _F_HEALTH = ["精神饱满，注意补水。", "别熬夜，早点休息。", "适合运动，舒展筋骨。", "肠胃需注意，饮食清淡。", "颈椎肩颈多放松。", "情绪平稳，身心舒畅。"];
const _COLORS = ["红色", "蓝色", "金色", "绿色", "紫色", "白色", "橙色"];
function localFortune(sign, date) {
  const h = _hashStr(sign + "|" + date);
  const pick = (arr, salt) => arr[(_hashStr(sign + date + salt) + h) % arr.length];
  return { all: pick(_F_ALL, "a"), love: pick(_F_LOVE, "l"), work: pick(_F_WORK, "w"), money: pick(_F_MONEY, "m"), health: pick(_F_HEALTH, "h"), luckyColor: _COLORS[h % _COLORS.length], luckyNumber: (h % 9) + 1 };
}
function _todayLocal() { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
const SIGN_META = [
  { id: "aries", cn: "白羊座", emoji: "♈", el: "fire" }, { id: "taurus", cn: "金牛座", emoji: "♉", el: "earth" }, { id: "gemini", cn: "双子座", emoji: "♊", el: "air" }, { id: "cancer", cn: "巨蟹座", emoji: "♋", el: "water" },
  { id: "leo", cn: "狮子座", emoji: "♌", el: "fire" }, { id: "virgo", cn: "处女座", emoji: "♍", el: "earth" }, { id: "libra", cn: "天秤座", emoji: "♎", el: "air" }, { id: "scorpio", cn: "天蝎座", emoji: "♏", el: "water" },
  { id: "sagittarius", cn: "射手座", emoji: "♐", el: "fire" }, { id: "capricorn", cn: "摩羯座", emoji: "♑", el: "earth" }, { id: "aquarius", cn: "水瓶座", emoji: "♒", el: "air" }, { id: "pisces", cn: "双鱼座", emoji: "♓", el: "water" }
];
function compatFor(sign) {
  const me = SIGN_META.find((s) => s.id === sign);
  if (!me) return [];
  return SIGN_META.filter((s) => s.id !== sign).map((s) => {
    let score, desc;
    if (me.el === s.el) { score = 90; desc = "同频默契，越处越合拍"; }
    else if ((me.el === "fire" && s.el === "air") || (me.el === "air" && s.el === "fire") || (me.el === "earth" && s.el === "water") || (me.el === "water" && s.el === "earth")) { score = 85; desc = "相互吸引，火花多，容易来电"; }
    else if ((me.el === "fire" && s.el === "water") || (me.el === "water" && s.el === "fire") || (me.el === "earth" && s.el === "air") || (me.el === "air" && s.el === "earth")) { score = 55; desc = "易有摩擦，多沟通、多包容"; }
    else { score = 68; desc = "需要磨合，各让一步"; }
    return { id: s.id, cn: s.cn, emoji: s.emoji, score: score, desc: desc };
  }).sort((a, b) => b.score - a.score);
}
const _horCache = new Map();
async function handleHoroscope(url, res) {
  const sign = String(url.searchParams.get("sign") || "").toLowerCase();
  if (SIGN_IDS.indexOf(sign) < 0) return sendErr(res, 400, "bad sign");
  const date = _todayLocal();
  const ck = sign + "|" + date;
  if (_horCache.has(ck)) return send(res, 200, _horCache.get(ck));
  const out = Object.assign({ ok: true, sign: sign, date: date, source: "local" }, localFortune(sign, date));
  out.compat = compatFor(sign);
  out.best = out.compat.slice(0, 3);
  out.worst = out.compat.slice(-2);
  _horCache.set(ck, out);
  return send(res, 200, out);
}
async function handleLunar2Solar(url, res) {
  try {
    const y = Number(url.searchParams.get("y")), m = Number(url.searchParams.get("m")), d = Number(url.searchParams.get("d"));
    if (!y || !m || !d) return sendErr(res, 400, "bad date");
    const sol0 = requireCJS("solarlunar");
    const sol = (sol0 && sol0.lunar2solar) ? sol0 : ((sol0 && sol0.default) || sol0);
    if (!sol || !sol.lunar2solar) return send(res, 200, { ok: false, available: false });
    const r = sol.lunar2solar(y, m, d);
    if (r && r.cYear) return send(res, 200, { ok: true, solar: { y: r.cYear, m: r.cMonth, d: r.cDay } });
    return send(res, 200, { ok: false, error: "bad lunar" });
  } catch (e) { return send(res, 200, { ok: false, available: false, error: String(e.message || e) }); }
}
const _YI = ["祭祀", "出行", "会友", "嫁娶", "开市", "交易", "纳财", "动土", "安床", "祈福", "求嗣", "入学", "沐浴", "扫舍", "栽种", "纳采", "订盟", "移徙"];
const _JI = ["动土", "破土", "安葬", "开仓", "出货财", "词讼", "远行", "开市", "入宅", "掘井", "伐木", "行丧", "针灸", "嫁娶", "作灶"];
const _alCache = new Map();
async function handleAlmanac(url, res) {
  const date = String(url.searchParams.get("date") || _todayLocal());
  if (_alCache.has(date)) return send(res, 200, _alCache.get(date));
  const h = _hashStr("almanac|" + date);
  const pickN = (arr, salt, n) => {
    const out = [];
    let seed = _hashStr(date + salt) + h;
    const used = {};
    for (let k = 0; k < n; k++) {
      let idx = (seed + k * 7) % arr.length;
      let guard = 0;
      while (used[idx] && guard < arr.length) { idx = (idx + 1) % arr.length; guard++; }
      used[idx] = true; out.push(arr[idx]);
    }
    return out;
  };
  const out = { ok: true, date: date, yi: pickN(_YI, "y", 3), ji: pickN(_JI, "j", 2), source: "local" };
  _alCache.set(date, out);
  return send(res, 200, out);
}

const IMG_RE = /[.](jpe?g|png|webp|gif|bmp|avif)$/i;

function pickFolderViaPowerShell() {
  return new Promise((resolve) => {
    const script = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "$OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "$top = New-Object System.Windows.Forms.Form",
      "$top.TopMost = $true",
      "$top.ShowInTaskbar = $false",
      "$top.WindowState = 'Minimized'",
      "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dlg.Description = '选择壁纸文件夹'",
      "$dlg.ShowNewFolderButton = $true",
      "if ($dlg.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }",
      "$top.Dispose()",
    ].join("\r\n");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { timeout: 180000, windowsHide: true, maxBuffer: 1048576 }, (err, stdout) => {
      const out = String(stdout || "").trim();
      if (err) {
        if (!out) return resolve({ ok: true, path: "", canceled: true });
        return resolve({ ok: false, available: false, error: String((err && err.message) || err) });
      }
      resolve({ ok: true, path: out, canceled: !out });
    });
  });
}

async function handlePickFolder(req, res) {
  if (process.platform !== "win32") return send(res, 200, { ok: false, available: false, error: "only windows supported" });
  try {
    try { await readBody(req); } catch (e) { /* consume body */ }
    const r = await pickFolderViaPowerShell();
    return send(res, 200, r);
  } catch (e) {
    return send(res, 200, { ok: false, available: false, error: String((e && e.message) || e) });
  }
}

function handleWallpaperList(url, res) {
  try {
    const dir = String(url.searchParams.get("dir") || "").trim();
    if (!dir) return send(res, 200, { ok: true, files: [] });
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return send(res, 200, { ok: false, files: [], error: "not a directory" });
    const MAX = 5000;
    const files = [];
    const stack = [{ p: dir, rel: "", depth: 0 }];
    while (stack.length && files.length < MAX) {
      const cur = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(cur.p, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of entries) {
        if (files.length >= MAX) break;
        const rel = cur.rel ? (cur.rel + "/" + e.name) : e.name;
        if (e.isFile()) {
          if (IMG_RE.test(e.name)) files.push(rel);
        } else if (e.isDirectory() && cur.depth < 8) {
          stack.push({ p: path.join(cur.p, e.name), rel: rel, depth: cur.depth + 1 });
        }
      }
    }
    files.sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true })); // 0.8.7：自然序（1.jpg < 2.jpg < 10.jpg），顺序轮播才符合直觉
    return send(res, 200, { ok: true, dir: dir, files: files, count: files.length });
  } catch (e) {
    return send(res, 200, { ok: false, files: [], error: String((e && e.message) || e) });
  }
}

/* 0.8.7：壁纸二进制缓存（key = 绝对路径 + mtime + size）。
 * 轮播每 30s 换一张 4K 壁纸，每张都 readFileSync 几十 MB 会让「新图就位」变慢，
 * 也就是空白窗口变长；缓存后切图基本瞬时，浏览器端也有 1 天缓存可用。 */
const WALL_CACHE = new Map();
const WALL_CACHE_MAX = 8;
function handleWallpaperFile(url, res) {
  try {
    const dir = String(url.searchParams.get("dir") || "").trim();
    const name = String(url.searchParams.get("name") || "").trim();
    if (!dir || !name) return sendErr(res, 400, "dir/name required");
    const base = path.resolve(dir);
    const full = path.resolve(base, name);
    if (full !== base && !full.startsWith(base + path.sep)) return sendErr(res, 403, "forbidden");
    if (!IMG_RE.test(full)) return sendErr(res, 415, "not an image");
    const st = fs.statSync(full);
    if (!st.isFile()) return sendErr(res, 404, "not found");
    const low = full.toLowerCase();
    const type = low.endsWith(".png") ? "image/png" : (low.endsWith(".jpg") || low.endsWith(".jpeg")) ? "image/jpeg" : low.endsWith(".webp") ? "image/webp" : low.endsWith(".gif") ? "image/gif" : low.endsWith(".bmp") ? "image/bmp" : low.endsWith(".avif") ? "image/avif" : "application/octet-stream";
    const buf = (function () {
      const key = full + "|" + st.mtimeMs + "|" + st.size;
      const hit = WALL_CACHE.get(key);
      if (hit) return hit;
      const b = fs.readFileSync(full);
      if (WALL_CACHE.size >= WALL_CACHE_MAX) WALL_CACHE.clear();
      WALL_CACHE.set(key, b);
      return b;
    })();
    // 0.8.7：壁纸是磁盘上的固定文件，放宽到 1 天，刷新页面时直接从本地缓存出图，不再先白一下
    res.writeHead(200, { "content-type": type, "cache-control": "private, max-age=86400", "content-length": buf.length, "x-content-type-options": "nosniff" });
    res.end(buf);
    return;
  } catch (e) {
    return sendErr(res, 404, String((e && e.message) || e));
  }
}

/* ── 到点提醒扫描（久坐/喝水/摸鱼/听歌/自定义） ─────────────────────
 * 每 60s 读 store.json 的 settings.reminders：命中「时间段 + 间隔」就
 *   ① 发 Windows 系统通知（胶囊：弹完自动消失，DSH 不在前台也能看到）
 *   ② 记进 REMIND_PENDING，客户端轮询到就把侧边栏自动弹出来
 * 去重靠 remind-state.json 里每条的 lastFiredAt（重启不重弹）。
 */
function readRemindState() {
  try {
    const o = readJson(REMIND_FILE, null);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
function writeRemindState(o) {
  try {
    writeJsonAtomic(REMIND_FILE, o);
  } catch {
    /* ignore */
  }
}
function parseHHMM(t) {
  const a = String(t || "00:00").split(":").map(Number);
  return (Number(a[0]) || 0) * 60 + (Number(a[1]) || 0);
}
/* ── 上下班判定（与客户端 isWorkday / isBigWeek 同口径，给宿主扫描用） ── */
function ymdOf(dt) {
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
}
function parseKeyDate(s) {
  const a = String(s || "").split("-").map(Number);
  return new Date(a[0] || 1970, (a[1] || 1) - 1, a[2] || 1);
}
function weekMondayOf(dt) {
  const wd = (dt.getDay() + 6) % 7; // 周一 = 0
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - wd);
}
function isBigWeekOf(mondayKey, sc) {
  const anchor = weekMondayOf(parseKeyDate(sc.anchorDate || ymdOf(new Date()))).getTime();
  const cur = weekMondayOf(parseKeyDate(mondayKey)).getTime();
  const diffWeeks = Math.round((cur - anchor) / (7 * 86400000));
  const parityEven = ((diffWeeks % 2) + 2) % 2 === 0;
  return parityEven ? !!sc.anchorIsBig : !sc.anchorIsBig;
}
function isWorkdayOf(person, dt) {
  const wd = dt.getDay();
  const sc = (person && person.schedule) || {};
  const type = sc.type || "double";
  if (type === "double") return wd >= 1 && wd <= 5;
  if (type === "single") return wd !== 0;
  if (type === "custom") return (sc.customWorkdays || [1, 2, 3, 4, 5]).indexOf(wd) >= 0;
  if (type === "bigsmall") {
    if (wd === 0) return false;
    if (wd >= 1 && wd <= 5) return true;
    return !isBigWeekOf(ymdOf(weekMondayOf(dt)), sc);
  }
  return wd >= 1 && wd <= 5;
}

function scanReminders(opts) {
  const silent = !!(opts && opts.silent);
  let store;
  try {
    store = loadStore();
  } catch {
    return;
  }
  const settings = (store && store.settings) || {};
  const reminders = Array.isArray(settings.reminders) ? settings.reminders : [];
  if (!reminders.length) return;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const st = readRemindState();
  let dirty = false;
  for (const rm of reminders) {
    if (!rm || !rm.enabled || !rm.id) continue;
    if (nowMin < parseHHMM(rm.start || "00:00") || nowMin > parseHHMM(rm.end || "23:59")) continue;
    const ivMs = Math.max(5, Number(rm.intervalMin) || 60) * 60000;
    const last = Number(st[rm.id] && st[rm.id].lastFiredAt) || 0;
    if (last && now.getTime() - last < ivMs) continue;
    st[rm.id] = { lastFiredAt: now.getTime() };
    dirty = true;
    if (silent) continue; // 启动基线：只从此刻开始计时，不在开机时补弹一串
    REMIND_SEQ += 1;
    REMIND_PENDING.push({ seq: REMIND_SEQ, id: rm.id, name: rm.name || "提醒", msg: rm.msg || "", at: now.toISOString() });
    while (REMIND_PENDING.length > 30) REMIND_PENDING.shift();
    if (settings.reminderToast !== false) {
      try {
        showToast({ title: "⏰ " + (rm.name || "提醒"), body: rm.msg || "", sound: settings.reminderSound !== false, seconds: Math.min(60, Math.max(3, Number(settings.reminderSeconds) || 6)) });
      } catch {
        /* ignore */
      }
    }
  }
  /* 上下班提醒：客户端只在自己面板里判「整分相等」，面板没开就永远错过。
     宿主这里独立扫一遍，10 分钟窗口内只弹一次，并走系统通知 + 客户端弹侧边栏。 */
  if (settings.workReminder !== false) {
    const tk = ymdOf(now);
    const persons = Array.isArray(store.persons) ? store.persons : [];
    for (const p of persons) {
      if (!p || !p.schedule || !isWorkdayOf(p, now)) continue;
      const sc = p.schedule;
      const [sh, sm] = String(sc.workStart || "09:00").split(":").map(Number);
      const [eh, em] = String(sc.workEnd || "18:00").split(":").map(Number);
      const pairs = [
        ["work-start-" + (p.id || "") + "-" + tk, sh * 60 + sm, "该上班啦（" + (p.name || "") + " " + sc.workStart + "）"],
        ["work-end-" + (p.id || "") + "-" + tk, eh * 60 + em, "该下班啦（" + (p.name || "") + " " + sc.workEnd + "）"],
      ];
      for (const [key, target, msg] of pairs) {
        if (nowMin < target || nowMin > target + 10) continue;
        const rec = st[key];
        if (rec && rec.day === tk) continue;
        st[key] = { day: tk, lastFiredAt: now.getTime() };
        dirty = true;
        if (silent) continue;
        REMIND_SEQ += 1;
        REMIND_PENDING.push({ seq: REMIND_SEQ, id: key, name: "上下班", msg: msg, at: now.toISOString() });
        while (REMIND_PENDING.length > 30) REMIND_PENDING.shift();
        if (settings.reminderToast !== false) {
          try { showToast({ title: "⏰ 上下班", body: msg, sound: settings.reminderSound !== false, seconds: Math.min(60, Math.max(3, Number(settings.reminderSeconds) || 6)) }); } catch { /* ignore */ }
        }
      }
    }
  }
  if (dirty) writeRemindState(st);
}

async function handler(req, res) {
  try {
    const host = req.headers.host || "127.0.0.1";
    const url = new URL(req.url, "http://" + host);
    let p = url.pathname;
    if (p.startsWith(ROUTE_PREFIX)) p = p.slice(ROUTE_PREFIX.length) || "/";

    if (req.method === "GET" && (p === "/ping" || p === "/")) {
      return send(res, 200, { ok: true, name, version: VERSION });
    }

    if (!sameOrigin(req)) return sendErr(res, 403, "cross-origin blocked");

    if (MAIL && (p === "/mail" || p.indexOf("/mail/") === 0 || p === "/open-url" || p === "/mail/attach-open")) return await MAIL.handle(req, res, p, url);

    if (p === "/data") {
      if (req.method === "GET") return send(res, 200, { ok: true, data: loadStore() });
      if (req.method === "POST") {
        const ct = req.headers["content-type"] || "";
        if (!ct.includes("application/json")) return sendErr(res, 415, "application/json required");
        let raw;
        try {
          raw = await readBody(req);
        } catch (e) {
          return sendErr(res, 413, e.message || "body error");
        }
        let obj;
        try {
          obj = JSON.parse(raw);
        } catch {
          return sendErr(res, 400, "invalid json");
        }
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return sendErr(res, 400, "bad payload");
        writeJsonAtomic(STORE_FILE, obj);
        return send(res, 200, { ok: true, savedAt: new Date().toISOString() });
      }
      return sendErr(res, 405, "method not allowed");
    }

    if (p === "/geocode" && req.method === "GET") return await handleGeocode(url, res);
    if (p === "/weather" && req.method === "GET") return await handleWeather(url, res);
    if (p === "/holidays" && req.method === "GET") return await handleHolidays(url, res);
    if (p === "/lunar" && req.method === "GET") return handleLunar(url, res);
    if (p === "/divisions" && req.method === "GET") return await handleDivisions(url, res);
    if (p === "/resolve" && req.method === "GET") return await handleResolve(url, res);
    if (p === "/horoscope" && req.method === "GET") return await handleHoroscope(url, res);
    if (p === "/lunar2solar" && req.method === "GET") return await handleLunar2Solar(url, res);
    if (p === "/almanac" && req.method === "GET") return await handleAlmanac(url, res);

    if (p === "/update/check" && req.method === "GET") return await handleUpdateCheck(res);
    if (p === "/update/changelog" && req.method === "GET") return await handleUpdateChangelog(res);
    if (p === "/update/apply" && req.method === "POST") return await handleUpdateApply(req, res);
    if (p === "/wallpapers" && req.method === "GET") return handleWallpaperList(url, res);
    if (p === "/wallpaper" && req.method === "GET") return handleWallpaperFile(url, res);
    if (p === "/pick-folder" && req.method === "POST") return await handlePickFolder(req, res);

    // 到点提醒：客户端轮询增量（since=上次拿到的 seq），popup 表示用户是否要自动弹侧栏
    if (p === "/remind/pending" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") || 0) || 0;
      let popup = true;
      try {
        const s = loadStore();
        popup = !(s && s.settings && s.settings.reminderPopup === false);
      } catch {
        /* ignore */
      }
      return send(res, 200, { ok: true, seq: REMIND_SEQ, popup, items: REMIND_PENDING.filter((x) => x.seq > since) });
    }

    // 手动预览提醒：立刻弹一次胶囊并推一条 pending（客户端 15s 内把侧边栏弹出来）。
    // 刻意不写 remind-state.json 的 lastFiredAt —— 预览不能吃掉这条提醒的正式周期。
    if (p === "/remind/test" && req.method === "POST") {
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || "{}") || {};
      } catch {
        body = {};
      }
      let s = null;
      try {
        s = loadStore();
      } catch {
        /* ignore */
      }
      const list = s && s.settings && Array.isArray(s.settings.reminders) ? s.settings.reminders : [];
      const rm = list.find((x) => String(x.id) === String(body.id)) || null;
      const name = String((rm && rm.name) || body.name || "提醒");
      const msg = String((rm && rm.msg) || body.msg || "这是一条预览提醒，不会影响正式提醒的计时。");
      const title = "⏰ " + name;
      REMIND_SEQ += 1;
      REMIND_PENDING.push({ seq: REMIND_SEQ, id: (rm && rm.id) || "preview", name, msg, at: new Date().toISOString(), preview: true });
      while (REMIND_PENDING.length > 30) REMIND_PENDING.shift();
      const wantToast = !(s && s.settings && s.settings.reminderToast === false);
      if (wantToast) {
        try {
          showToast({ title, body: msg, sound: !(s && s.settings && s.settings.reminderSound === false), seconds: Math.min(60, Math.max(3, Number(s && s.settings && s.settings.reminderSeconds) || 6)) });
        } catch {
          /* ignore */
        }
      }
      console.log("[dsh-schedule-calendar] remind preview: " + name + " (toast=" + wantToast + ")");
      return send(res, 200, { ok: true, seq: REMIND_SEQ, title, msg, toasts: wantToast });
    }

    return sendErr(res, 404, "not found");
  } catch (e) {
    try {
      sendErr(res, 500, e && e.message ? e.message : String(e));
    } catch {
      /* ignore */
    }
  }
}

export function apply(ctx) {
  const webServer = ctx && ctx.webServer;
  if (!webServer) return;
  ctx.effect(() => {
    const dispose = webServer.register({
      kind: "prefix",
      path: ROUTE_PREFIX,
      handler,
    });
    try {
      MAIL = createMailModule(ctx);
      MAIL.start();
    } catch (e) {
      console.error("[dsh-schedule-calendar] mail module init failed", e);
    }
    // 到点提醒：先静默建基线（不补弹），之后每 60s 扫一次
    try {
      scanReminders({ silent: true });
    } catch {
      /* ignore */
    }
    const remindTimer = setInterval(() => {
      try {
        scanReminders();
      } catch {
        /* ignore */
      }
    }, 60000);
    if (remindTimer.unref) remindTimer.unref();
    return () => {
      try { clearInterval(remindTimer); } catch (e0) { /* ignore */ }
      try { if (MAIL) MAIL.stop(); } catch (e2) { /* ignore */ }
      try { if (typeof dispose === "function") dispose(); } catch (e3) { /* ignore */ }
    };
  });
}
