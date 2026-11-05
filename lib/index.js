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

export const name = "dsh-schedule-calendar";
export const inject = ["webServer"];

const VERSION = "0.3.7";
const ROUTE_PREFIX = "/schedule-calendar";

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
          const out = { ok: true, province: p.name, city: p.name, district: ct.name, latitude: ct.lat, longitude: ct.lng, level: "city" };
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
  ctx.effect(() =>
    webServer.register({
      kind: "prefix",
      path: ROUTE_PREFIX,
      handler,
    }),
  );
}
