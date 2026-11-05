/**
 * dsh-schedule-calendar — client bundle（手写，无构建步骤）v0.2.0
 * 通过 betterSidebar 注册「日程助手」标签页；并在左侧栏脚部注入「日程助手」启动按钮。
 * 全部数据经宿主端 /schedule-calendar/* 路由读写（根相对路径 fetch）。
 * @module dsh-schedule-calendar/client
 */
window.__ModuleLoader__.load({
  id: "dsh-schedule-calendar",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback } = React;

    const NAME = "dsh-schedule-calendar";
    const VERSION = "0.3.7";
const REPO_URL = "https://github.com/loyalchiiina/dsh-schedule-calendar";
    const ROUTE = "/schedule-calendar";

    /* ============================ 工具 ============================ */
    const pad = (n) => String(n).padStart(2, "0");
    const key3 = (y, m, d) => y + "-" + pad(m) + "-" + pad(d);
    const dateKey = (dt) => key3(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
    const parseKey = (s) => { const a = String(s).split("-").map(Number); return new Date(a[0], (a[1] || 1) - 1, a[2] || 1); };
    const todayKey = () => dateKey(new Date());
    const addDays = (dt, n) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + n);
    const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const weekMonday = (dt) => { const d = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); return addDays(d, -((d.getDay() + 6) % 7)); };
    const uid = () => "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const mmdd = (s) => { const d = parseKey(s); return (d.getMonth() + 1) + "/" + d.getDate(); };

    function weatherIcon(code) {
      if (code === 0) return "☀️";
      if (code === 1 || code === 2) return "🌤️";
      if (code === 3) return "☁️";
      if (code === 45 || code === 48) return "🌫️";
      if ([51, 53, 55, 56, 57].indexOf(code) >= 0) return "🌦️";
      if ([61, 63, 65, 66, 67, 80, 81, 82].indexOf(code) >= 0) return "🌧️";
      if ([71, 73, 75, 77, 85, 86].indexOf(code) >= 0) return "❄️";
      if (code === 95 || code === 96 || code === 99) return "⛈️";
      return "🌡️";
    }

    function apiUrl(p, q) { return ROUTE + p + (q ? "?" + q : ""); }
    async function getJson(url) { const r = await fetch(url, { headers: { accept: "application/json" } }); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }
    async function postJson(url, obj) { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) }); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }

    /* ============================ 班制 ============================ */
    function isBigWeek(mondayKeyStr, schedule) {
      const anchor = weekMonday(parseKey(schedule.anchorDate || todayKey()));
      const cur = parseKey(mondayKeyStr);
      const diffWeeks = Math.round((cur - anchor) / (7 * 86400000));
      const parityEven = ((diffWeeks % 2) + 2) % 2 === 0;
      return parityEven ? !!schedule.anchorIsBig : !schedule.anchorIsBig;
    }
    function isWorkday(person, dateKeyStr) {
      const dt = parseKey(dateKeyStr);
      const wd = dt.getDay();
      const sc = (person && person.schedule) || {};
      const type = sc.type || "double";
      if (type === "double") return wd >= 1 && wd <= 5;
      if (type === "single") return wd !== 0;
      if (type === "custom") return (sc.customWorkdays || [1, 2, 3, 4, 5]).indexOf(wd) >= 0;
      if (type === "bigsmall") {
        if (wd === 0) return false;
        if (wd >= 1 && wd <= 5) return true;
        return !isBigWeek(dateKey(weekMonday(dt)), sc);
      }
      return wd >= 1 && wd <= 5;
    }

    /* ============================ 农历/事件 ============================ */
    function lunarToSolarInYear(year, lMonth, lDay, lunarDays) {
      if (!lunarDays) return null;
      for (const k in lunarDays) {
        const v = lunarDays[k];
        if (v && !v.isLeap && v.lMonth === lMonth && v.lDay === lDay) return k;
      }
      return null;
    }
    function repeatOf(ev) { return ev && ev.repeat ? ev.repeat : (ev && ev.lunar ? "lunar-yearly" : "none"); }
    function occurOn(ev, dateKeyStr, lunarDays) {
      const r = repeatOf(ev);
      if (r === "none") return ev.date === dateKeyStr;
      if (!ev.date) return false;
      const a = parseKey(ev.date), b = parseKey(dateKeyStr);
      if (r === "daily") return b >= a;
      if (r === "weekly") return b >= a && a.getDay() === b.getDay();
      if (r === "monthly") return b >= a && a.getDate() === b.getDate();
      if (r === "yearly") return b >= a && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
      if (r === "lunar-yearly" && ev.lunar) { const y = Number(dateKeyStr.slice(0, 4)); return lunarToSolarInYear(y, ev.lunar.month, ev.lunar.day, lunarDays) === dateKeyStr; }
      return false;
    }
    function occurrencesForDate(dateKeyStr, events, lunarDays) {
      const out = [];
      for (const ev of events) if (occurOn(ev, dateKeyStr, lunarDays)) out.push(ev);
      return out;
    }
    function nextOccurrence(ev, fromKey, lunarDays) {
      let d = parseKey(fromKey);
      for (let i = 0; i < 400; i++) { const k = dateKey(d); if (occurOn(ev, k, lunarDays)) return k; d = addDays(d, 1); }
      return null;
    }
    function buildOccMap(events, lunarDays, year) {
      const map = {};
      const push = (k, ev) => { (map[k] = map[k] || []).push(ev); };
      const yLen = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365;
      let d = parseKey(year + "-01-01");
      for (let i = 0; i < yLen; i++) {
        const k = dateKey(d);
        for (const ev of events) {
          const r = repeatOf(ev);
          if (r === "none") { if (ev.date === k) push(k, ev); }
          else if (occurOn(ev, k, lunarDays)) push(k, ev);
        }
        d = addDays(d, 1);
      }
      return map;
    }
    const EV_LABEL = { none: "普通日程", daily: "每日", weekly: "每周", monthly: "每月", yearly: "每年", "lunar-yearly": "农历每年" };
    const LM_CN = ["", "正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月"];
    const LD_CN = ["", "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];
    function lunarCn(m, d) { return (LM_CN[m] || (m + "月")) + (LD_CN[d] || (d + "日")); }
    function solarMd(dateStr) { if (!dateStr) return ""; return Number(dateStr.slice(5, 7)) + "月" + Number(dateStr.slice(8, 10)) + "日"; }
    const CAL_COLORS = { weekend: "#fff3d6", rest: "#e3f5ec", holiday: "#ffe0e1", makeup: "#e5edff" };
    const BUFFS = ["鸿运当头", "日进斗金", "暴富", "诸事顺遂", "心想事成", "财源广进", "贵人相助", "步步高升", "平安喜乐", "锦鲤附体", "否极泰来", "福星高照", "时来运转", "喜从天降", "万事如意"];
    const HEALTH_TIPS = ["记得多喝水 💧", "久坐记得起身活动一下 🧘", "按时吃饭，别饿着 🍚", "早点休息，别熬夜 🌙", "用眼一小时，远眺 30 秒 👀", "保持好心情，笑一笑 😄", "活动一下颈椎和肩膀 🤸"];
    function solarSign(m, d) {
      const x = Number(m) * 100 + Number(d);
      if (x >= 1222 || x <= 119) return { id: "capricorn", cn: "摩羯座", emoji: "♑" };
      if (x <= 218) return { id: "aquarius", cn: "水瓶座", emoji: "♒" };
      if (x <= 320) return { id: "pisces", cn: "双鱼座", emoji: "♓" };
      if (x <= 419) return { id: "aries", cn: "白羊座", emoji: "♈" };
      if (x <= 520) return { id: "taurus", cn: "金牛座", emoji: "♉" };
      if (x <= 621) return { id: "gemini", cn: "双子座", emoji: "♊" };
      if (x <= 722) return { id: "cancer", cn: "巨蟹座", emoji: "♋" };
      if (x <= 822) return { id: "leo", cn: "狮子座", emoji: "♌" };
      if (x <= 922) return { id: "virgo", cn: "处女座", emoji: "♍" };
      if (x <= 1023) return { id: "libra", cn: "天秤座", emoji: "♎" };
      if (x <= 1122) return { id: "scorpio", cn: "天蝎座", emoji: "♏" };
      return { id: "sagittarius", cn: "射手座", emoji: "♐" };
    }
    const SIGNS_MAP = { capricorn: { cn: "摩羯座", emoji: "♑" }, aquarius: { cn: "水瓶座", emoji: "♒" }, pisces: { cn: "双鱼座", emoji: "♓" }, aries: { cn: "白羊座", emoji: "♈" }, taurus: { cn: "金牛座", emoji: "♉" }, gemini: { cn: "双子座", emoji: "♊" }, cancer: { cn: "巨蟹座", emoji: "♋" }, leo: { cn: "狮子座", emoji: "♌" }, virgo: { cn: "处女座", emoji: "♍" }, libra: { cn: "天秤座", emoji: "♎" }, scorpio: { cn: "天蝎座", emoji: "♏" }, sagittarius: { cn: "射手座", emoji: "♐" } };
    function contrastText(hex) { try { const h = String(hex || "").replace("#", ""); if (h.length < 6) return "inherit"; const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16); const y = 0.299 * r + 0.587 * g + 0.114 * b; return y > 155 ? "#1f2430" : "#ffffff"; } catch (e) { return "inherit"; } }

    /* ============================ 数据 ============================ */
    function normalize(s) {
      s = s || {};
      s.version = s.version || 1;
      s.settings = Object.assign({ activePersonId: "p1", activeCityId: null, reminderSound: true, workReminder: true, weekStart: 1 }, s.settings || {});
      s.settings.colors = Object.assign({ weekend: CAL_COLORS.weekend, rest: CAL_COLORS.rest, holiday: CAL_COLORS.holiday, makeup: CAL_COLORS.makeup }, s.settings.colors || {});
      s.settings.buff = Object.assign({ date: "", text: "", streak: 0 }, s.settings.buff || {});
      s.settings.showAlmanac = s.settings.showAlmanac !== false;
      s.settings.showHoroscope = s.settings.showHoroscope !== false;
      s.weatherCities = Array.isArray(s.weatherCities) ? s.weatherCities : [];
      if (!Array.isArray(s.persons) || !s.persons.length) {
        s.persons = [{ id: "p1", name: "我", schedule: { type: "double", workStart: "09:00", workEnd: "18:00", anchorDate: dateKey(weekMonday(new Date())), anchorIsBig: true, customWorkdays: [1, 2, 3, 4, 5] } }];
      }
      s.events = Array.isArray(s.events) ? s.events : [];
      /* 老数据兼容：凡带 lunar 的生日/纪念，一律按「农历每年」重复（含此前未标记 repeat 的） */
      s.events.forEach((ev) => { if (ev && ev.lunar && (!ev.repeat || ev.repeat === "none")) ev.repeat = "lunar-yearly"; });
      s.todos = Array.isArray(s.todos) ? s.todos : [];
      s.dailyReports = s.dailyReports && typeof s.dailyReports === "object" ? s.dailyReports : {};
      s.weeklyReports = s.weeklyReports && typeof s.weeklyReports === "object" ? s.weeklyReports : {};
      s.persons.forEach((p) => {
        p.birthday = Object.assign({ type: "solar", year: 0, month: 0, day: 0 }, p.birthday || {});
        p.schedule = p.schedule || {};
        const sc = p.schedule;
        sc.type = sc.type || "double";
        sc.workStart = sc.workStart || "09:00";
        sc.workEnd = sc.workEnd || "18:00";
        sc.anchorDate = sc.anchorDate || dateKey(weekMonday(new Date()));
        sc.anchorIsBig = sc.anchorIsBig !== false;
        sc.customWorkdays = sc.customWorkdays || [1, 2, 3, 4, 5];
      });
      if (!s.settings.activePersonId || !s.persons.some((p) => p.id === s.settings.activePersonId)) s.settings.activePersonId = s.persons[0].id;
      if (!s.settings.activeCityId && s.weatherCities[0]) s.settings.activeCityId = s.weatherCities[0].id;
      return s;
    }

    function useStore() {
      const [store, setStore] = useState(null);
      const [status, setStatus] = useState("loading");
      const [err, setErr] = useState("");
      const dirty = useRef(false);
      const timer = useRef(null);
      const load = useCallback(async () => {
        setStatus("loading");
        try {
          const j = await getJson(apiUrl("/data"));
          const data0 = normalize((j && j.data) || {});
          setStore(data0);
          setStatus("ready");
          setErr("");
          /* 一次性补全老数据缺失的「市」：无 city 的城市用 /resolve 反查所属市 */
          (async () => {
            try {
              const list = data0.weatherCities || [];
              if (!list.some((c) => !c.city)) return;
              const fixed = list.map((c) => ({ ...c }));
              let changed = false;
              for (const c of fixed) {
                if (c.city) continue;
                const prov = c.province || (c.fullName && c.fullName.indexOf("·") > 0 ? c.fullName.split("·")[0] : "");
                if (!prov) continue;
                try {
                  const r = await getJson(apiUrl("/resolve", "name=" + encodeURIComponent(c.district || c.name) + "&province=" + encodeURIComponent(prov)));
                  if (r && r.ok && r.city && r.city !== c.city) {
                    c.province = r.province || c.province;
                    c.city = r.city;
                    c.district = r.district || c.district;
                    if (isFinite(r.latitude)) { c.latitude = r.latitude; c.longitude = r.longitude; }
                    c.fullName = [c.province, c.city, c.district].filter(Boolean).join("·");
                    changed = true;
                  }
                } catch (e) { /* ignore */ }
              }
              if (changed) {
                const next = { ...data0, weatherCities: fixed };
                dirty.current = true;
                setStore(next);
                postJson(apiUrl("/data"), next).catch(() => {});
              }
            } catch (e) { /* ignore */ }
          })();
        } catch (e) {
          setErr(String((e && e.message) || e));
          setStatus("error");
        }
      }, []);
      useEffect(() => { load(); }, [load]);
      useEffect(() => {
        if (!store || !dirty.current) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          postJson(apiUrl("/data"), store).catch((e) => setErr(String((e && e.message) || e)));
        }, 450);
        return () => { if (timer.current) clearTimeout(timer.current); };
      }, [store]);
      const update = useCallback((fn) => { dirty.current = true; setStore((prev) => fn(prev)); }, []);
      return { store, status, err, update, reload: load, setStore };
    }

    function useLunar(year) {
      const [days, setDays] = useState(null);
      const [err, setErr] = useState("");
      useEffect(() => {
        let alive = true;
        setDays(null);
        getJson(apiUrl("/lunar", "year=" + year))
          .then((j) => { if (!alive) return; if (j && j.ok) setDays(j.days || {}); else setErr((j && j.error) || "农历不可用"); })
          .catch((e) => { if (alive) setErr(String((e && e.message) || e)); });
        return () => { alive = false; };
      }, [year]);
      return { days, err };
    }
    function useHolidays(year) {
      const [map, setMap] = useState({});
      useEffect(() => {
        let alive = true;
        getJson(apiUrl("/holidays", "year=" + year))
          .then((j) => { if (alive && j && j.ok && j.map) setMap(j.map); })
          .catch(() => {});
        return () => { alive = false; };
      }, [year]);
      return map;
    }

    function useAlmanac(date) {
      const [data, setData] = useState(null);
      useEffect(() => {
        let alive = true;
        getJson(apiUrl("/almanac", "date=" + date)).then((j) => { if (alive && j && j.ok) setData(j); }).catch(() => {});
        return () => { alive = false; };
      }, [date]);
      return data;
    }
    function useHoroscope(sign) {
      const [data, setData] = useState(null);
      useEffect(() => {
        if (!sign) return;
        let alive = true;
        getJson(apiUrl("/horoscope", "sign=" + sign)).then((j) => { if (alive && j && j.ok) setData(j); }).catch(() => {});
        return () => { alive = false; };
      }, [sign]);
      return data;
    }

    /* ============================ 声音 ============================ */
    function beep() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ac = new AC();
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = "sine"; o.frequency.value = 880;
        g.gain.value = 0.0001;
        o.connect(g); g.connect(ac.destination);
        o.start();
        g.gain.exponentialRampToValueAtTime(0.15, ac.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.35);
        o.stop(ac.currentTime + 0.4);
      } catch (e) { /* ignore */ }
    }

    /* ============================ 图标 ============================ */
    function iconEl(paths, size) {
      return h("svg", { width: size || 16, height: size || 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, paths);
    }
    function tabIcon(size) {
      return iconEl([
        h("rect", { key: "r", x: 3, y: 4, width: 18, height: 17, rx: 2.5 }),
        h("line", { key: "l1", x1: 3, y1: 9, x2: 21, y2: 9 }),
        h("line", { key: "l2", x1: 8, y1: 2, x2: 8, y2: 6 }),
        h("line", { key: "l3", x1: 16, y1: 2, x2: 16, y2: 6 }),
        h("circle", { key: "c", cx: 12, cy: 15, r: 2.4, fill: "currentColor", stroke: "none" }),
      ], size);
    }
    function starEl(filled, size) {
      return h("svg", { width: size || 12, height: size || 12, viewBox: "0 0 24 24", fill: filled ? "currentColor" : "none", stroke: "currentColor", strokeWidth: 1.6, "aria-hidden": true }, h("path", { d: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" }));
    }

    /* ============================ 样式 ============================ */
    const CSS = `
.dsc-root{--bg:var(--dsc-bg,#f7f8fa);--card:#ffffff;--line:#e7e9ef;--txt:#1f2430;--sub:#8a90a0;--accent:#4f7cff;--accent2:#eaf1ff;--red:#e5484d;--green:#2fa36b;--warn:#f5a623;font-size:13px;color:var(--txt);display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg);border-radius:10px;overflow:hidden}
@media (prefers-color-scheme:dark){.dsc-root{--bg:#1b1e26;--card:#242833;--line:#333a49;--txt:#e6e9f0;--sub:#9aa2b4;--accent:#5b86ff;--accent2:#26314d;--red:#ff6b6f;--green:#3fbf82}}
.dsc-root *{box-sizing:border-box}
.dsc-launch{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsc-line,#e7e9ef);background:transparent;color:inherit;cursor:pointer;font-size:13px;line-height:1;vertical-align:middle}
.dsc-launch svg{display:block;flex:0 0 auto}
.dsc-launch span{display:inline-flex;align-items:center;line-height:1;white-space:nowrap}
.dsc-launch:hover{background:rgba(127,127,127,.12)}
.dsc-head{padding:10px 12px 8px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:linear-gradient(180deg,rgba(79,124,255,.06),transparent)}
.dsc-hdate{font-size:15px;font-weight:700;letter-spacing:.3px}
.dsc-hsub{font-size:12px;color:var(--sub)}
.dsc-pill{margin-left:auto;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:var(--accent2);color:var(--accent);font-weight:600;font-size:12px}
.dsc-pill.rest{background:rgba(47,163,107,.14);color:var(--green)}
.dsc-pill small{font-weight:500;opacity:.8}
.dsc-buffbar{display:flex;align-items:center;gap:8px;padding:6px 12px;background:linear-gradient(90deg,rgba(245,166,35,.14),rgba(229,72,77,.08));border-bottom:1px solid var(--line);font-size:12px}
.dsc-buff-ico{font-size:14px}
.dsc-buff-txt{color:var(--txt);font-weight:600}
.dsc-horo .dsc-horo-top{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.dsc-horo-emoji{font-size:26px;line-height:1}
.dsc-horo-name{font-weight:700;font-size:14px}
.dsc-horo-line{font-size:12.5px;line-height:1.85;color:var(--txt)}
.dsc-citytop{display:flex;align-items:center;gap:4px}
.dsc-fav{cursor:pointer;color:var(--warn);font-size:14px;line-height:1}
.dsc-compat{margin-top:4px}
.dsc-compat-row{display:flex;justify-content:space-between;gap:10px;font-size:12px;line-height:1.9;border-bottom:1px dashed var(--line);padding:1px 0}
.dsc-compat-row:last-child{border-bottom:none}
.dsc-nav{display:flex;gap:4px;padding:8px 10px 4px;flex-wrap:wrap}
.dsc-nav button{border:1px solid transparent;background:transparent;color:var(--sub);padding:5px 11px;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:600}
.dsc-nav button:hover{background:rgba(127,127,127,.1)}
.dsc-nav button.on{background:var(--accent2);color:var(--accent);border-color:rgba(79,124,255,.25)}
.dsc-body{flex:1;min-height:0;overflow:auto;padding:10px 12px 16px}
.dsc-sec{margin-bottom:12px}
.dsc-sec-h{display:flex;align-items:center;gap:8px;margin:2px 0 8px;font-weight:700;font-size:12.5px;color:var(--sub);text-transform:none;letter-spacing:.3px}
.dsc-sec-h .sp{margin-left:auto;display:flex;gap:6px}
.dsc-card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px}
.dsc-btn{border:1px solid var(--line);background:var(--card);color:var(--txt);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12.5px;font-weight:600;display:inline-flex;align-items:center;gap:5px}
.dsc-btn:hover{border-color:var(--accent);color:var(--accent)}
.dsc-btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}
.dsc-btn.pri:hover{filter:brightness(1.05);color:#fff}
.dsc-btn.mini{padding:2px 8px;font-size:11.5px;border-radius:7px}
.dsc-btn.ghost{background:transparent;border-color:transparent;color:var(--sub);padding:3px 6px}
.dsc-btn.ghost:hover{color:var(--red)}
.dsc-input,.dsc-select,.dsc-textarea{border:1px solid var(--line);background:var(--card);color:var(--txt);border-radius:8px;padding:6px 8px;font-size:12.5px;outline:none;font-family:inherit}
.dsc-input:focus,.dsc-select:focus,.dsc-textarea:focus{border-color:var(--accent)}
.dsc-textarea{width:100%;min-height:90px;resize:vertical;line-height:1.5}
.dsc-input{min-width:0}
.dsc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsc-muted{color:var(--sub)}
.dsc-empty{color:var(--sub);font-size:12.5px;padding:14px 4px;text-align:center}
.dsc-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}
.dsc-table th,.dsc-table td{padding:7px 6px;text-align:center;border-bottom:1px solid var(--line)}
.dsc-table th{color:var(--sub);font-weight:600;font-size:11.5px;white-space:nowrap}
.dsc-table td.city,.dsc-table th.city{text-align:left;font-weight:700;white-space:nowrap}
.dsc-table tr:last-child td{border-bottom:none}
.dsc-wcell{line-height:1.35}
.dsc-wi{font-size:17px;display:block}
.dsc-wt{font-weight:600}
.dsc-wp{color:var(--sub);font-size:11px}
.dsc-cal-wrap{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}
.dsc-cal-left{flex:1 1 300px;min-width:270px}
.dsc-cal-right{flex:1 1 210px;min-width:200px}
.dsc-cal-h{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.dsc-cal-title{font-weight:700;font-size:14px}
.dsc-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.dsc-wd{text-align:center;color:var(--sub);font-size:11px;padding:2px 0}
.dsc-cell{position:relative;border:1px solid transparent;border-radius:8px;min-height:46px;padding:3px 4px;cursor:pointer;background:transparent;display:flex;flex-direction:column;align-items:flex-start}
.dsc-cell:hover{background:rgba(127,127,127,.08)}
.dsc-cell.out{opacity:.32}
.dsc-cell.weekend{background:rgba(245,166,35,.16)}
.dsc-cell.rest{background:rgba(47,163,107,.16)}
.dsc-cell.holiday{background:rgba(229,72,77,.18)}
.dsc-cell.makeup{background:rgba(79,124,255,.12)}
.dsc-cell.weekend .dsc-dnum,.dsc-cell.rest .dsc-dnum{color:var(--green)}
.dsc-cell.holiday .dsc-dnum{color:var(--red)}
.dsc-cell.sel{background:var(--accent2);border-color:var(--accent)}
.dsc-cell.today .dsc-dnum{background:var(--accent);color:#fff;border-radius:6px}
.dsc-dnum{font-size:12.5px;font-weight:700;line-height:18px;min-width:18px;text-align:center}
.dsc-lunar{font-size:10px;color:var(--sub);line-height:1.2;white-space:nowrap;overflow:hidden;max-width:100%}
.dsc-lunar.fest{color:var(--red);font-weight:600}
.dsc-lunar.term{color:var(--accent)}
.dsc-item.dim{opacity:.42;filter:grayscale(.4)}
.dsc-item.dim .t{color:var(--sub)}
.dsc-item.soon{border-left:4px solid var(--accent);background:rgba(79,124,255,.14);box-shadow:inset 0 0 0 1px rgba(79,124,255,.30)}
.dsc-item.soon .t{color:var(--accent);font-weight:700}
.dsc-dots{display:flex;gap:2px;margin-top:auto;padding-top:1px}
.dsc-dot{width:4px;height:4px;border-radius:50%;background:var(--accent)}
.dsc-dot.star{background:var(--warn)}
.dsc-dayt{font-weight:700;font-size:13.5px}
.dsc-item{display:flex;gap:8px;align-items:flex-start;padding:7px 8px;border:1px solid var(--line);border-radius:9px;margin-bottom:6px;background:var(--card)}
.dsc-item .t{font-weight:600}
.dsc-item .m{color:var(--sub);font-size:11.5px;margin-top:1px}
.dsc-item.star{border-color:rgba(245,166,35,.5);background:rgba(245,166,35,.06)}
.dsc-time{font-variant-numeric:tabular-nums;font-weight:700;color:var(--accent);min-width:42px;font-size:12px}
.dsc-badge{font-size:10px;padding:1px 6px;border-radius:999px;background:var(--accent2);color:var(--accent);font-weight:600}
.dsc-badge.warn{background:rgba(245,166,35,.16);color:#b8860b}
.dsc-ctx{position:fixed;z-index:9999;background:var(--card);border:1px solid var(--line);border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px;min-width:120px}
.dsc-ctx button{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--txt);padding:7px 10px;border-radius:6px;cursor:pointer;font-size:12.5px}
.dsc-ctx button:hover{background:var(--accent2);color:var(--accent)}
.dsc-alert{position:sticky;top:0;z-index:5;margin:0 12px 6px;padding:8px 12px;border-radius:9px;background:rgba(245,166,35,.16);border:1px solid rgba(245,166,35,.5);color:#8a5a00;font-weight:600;display:flex;gap:8px;align-items:center}
.dsc-todo{display:flex;gap:8px;align-items:center;padding:7px 8px;border-bottom:1px solid var(--line)}
.dsc-todo:last-child{border-bottom:none}
.dsc-todo.done .tx{color:var(--sub);text-decoration:line-through}
.dsc-check{width:16px;height:16px;border-radius:5px;border:1.6px solid var(--line);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto}
.dsc-check.on{background:var(--accent);border-color:var(--accent);color:#fff}
.dsc-tabs{display:inline-flex;background:rgba(127,127,127,.1);border-radius:9px;padding:2px;margin-bottom:8px}
.dsc-tabs button{border:none;background:transparent;color:var(--sub);padding:4px 12px;border-radius:7px;cursor:pointer;font-weight:600;font-size:12px}
.dsc-tabs button.on{background:var(--card);color:var(--accent);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.dsc-pre{white-space:pre-wrap;line-height:1.6;font-size:12.5px;background:var(--card);border:1px solid var(--line);border-radius:9px;padding:10px;max-height:320px;overflow:auto}
.dsc-seg{display:inline-flex;gap:4px}
.dsc-wk{display:inline-flex;gap:2px}
.dsc-wk label{display:inline-flex;align-items:center;gap:3px;font-size:12px;padding:2px 6px;border:1px solid var(--line);border-radius:6px;cursor:pointer}
.dsc-wk input{margin:0}
.dsc-tagline{font-size:11.5px;color:var(--sub);margin-top:4px}
`;

    function ensureStyles() {
      if (document.getElementById("dsh-schedule-calendar-style")) return;
      const st = document.createElement("style");
      st.id = "dsh-schedule-calendar-style";
      st.textContent = CSS;
      document.head.appendChild(st);
    }

    /* ============================ 小组件 ============================ */
    function Btn(props) {
      const cls = "dsc-btn" + (props.kind ? " " + props.kind : "");
      return h("button", { className: cls, onClick: props.onClick, title: props.title, type: "button", disabled: props.disabled }, props.children);
    }
    function Field(props) {
      return h("label", { className: "dsc-row", style: { gap: 6 } },
        h("span", { className: "dsc-muted", style: { minWidth: props.w || 56, fontSize: 12 } }, props.label),
        props.children);
    }

    /* ---------- 今日 ---------- */
    function WeatherTable(props) {
      const { cities, store, update, refreshKey } = props;
      const [wm, setWm] = useState({});
      const [err, setErr] = useState("");
      useEffect(() => {
        let alive = true;
        (async () => {
          const next = {};
          for (const c of cities) {
            const url = apiUrl("/weather", "lat=" + encodeURIComponent(c.latitude) + "&lon=" + encodeURIComponent(c.longitude));
            try {
              let j = await getJson(url);
              if (!j || !j.ok) { await new Promise((r) => setTimeout(r, 700)); j = await getJson(url); }
              next[c.id] = j && j.ok ? j : { ok: false, error: (j && j.error) || "无数据" };
            } catch (e) { next[c.id] = { ok: false, error: String((e && e.message) || e) }; }
          }
          if (alive) setWm(next);
        })();
        return () => { alive = false; };
      }, [JSON.stringify(cities.map((c) => [c.id, c.latitude, c.longitude])), refreshKey]);

      const base = new Date();
      const days = [0, 1, 2, 3].map((i) => {
        const d = addDays(base, i);
        const label = ["今天", "明天", "后天", "大后天"][i];
        return { i, label, md: (d.getMonth() + 1) + "/" + d.getDate(), wd: WD[d.getDay()] };
      });

      if (!cities.length) {
        return h("div", { className: "dsc-card" }, h("div", { className: "dsc-empty" }, "还没有城市，去「设置」里添加（可精确到区）。"));
      }
      return h("table", { className: "dsc-table" },
        h("thead", null, h("tr", null,
          h("th", { className: "city" }, "城市"),
          days.map((d) => h("th", { key: d.i }, h("div", null, d.label), h("div", { style: { fontWeight: 400, fontSize: 10.5, opacity: 0.8 } }, d.md + " " + d.wd))))),
        h("tbody", null, cities.map((c) => {
          const w = wm[c.id];
          return h("tr", { key: c.id },
            h("td", { className: "city" }, h("div", null, cityTitle(c)), h("div", { className: "dsc-muted", style: { fontSize: 10.5, fontWeight: 400 } }, c.province || c.district || "")),
            days.map((d) => {
              let cell;
              if (!w) cell = h("span", { className: "dsc-muted" }, "…");
              else if (!w.ok) cell = h("span", { className: "dsc-muted", style: { fontSize: 11 } }, "—");
              else {
                const dl = w.daily || {};
                const code = (dl.weather_code || [])[d.i];
                const hi = (dl.temperature_2m_max || [])[d.i];
                const lo = (dl.temperature_2m_min || [])[d.i];
                const pp = (dl.precipitation_probability_max || [])[d.i];
                cell = h("div", { className: "dsc-wcell" },
                  h("span", { className: "dsc-wi" }, weatherIcon(code)),
                  h("span", { className: "dsc-wt" }, (hi == null ? "-" : Math.round(hi)) + "°/" + (lo == null ? "-" : Math.round(lo)) + "°"),
                  pp != null && pp > 0 ? h("span", { className: "dsc-wp" }, " 💧" + pp + "%") : null);
              }
              return h("td", { key: d.i }, cell);
            }));
        })));
    }

    function TodayView(props) {
      const { store, update, now, lunarToday, holidays } = props;
      const [wx, setWx] = useState(0);
      const tk = dateKey(now);
      const person = store.persons.find((p) => p.id === store.settings.activePersonId) || store.persons[0];
      const signId = (person && person.signId) || (person && person.birthday && person.birthday.month ? solarSign(person.birthday.month, person.birthday.day).id : "");
      const signObj = signId ? SIGNS_MAP[signId] : null;
      const hz = useHoroscope(signId);
      const occ = occurrencesForDate(tk, store.events, lunarToday);
      const todos = store.todos.filter((t) => !t.done).slice(0, 6);
      const hol = holidays[tk];
      const l = lunarToday && lunarToday[tk];
      return h("div", null,
        h("div", { className: "dsc-sec" },
          h("div", { className: "dsc-sec-h" }, "城市天气", h("span", { className: "sp" }, h(Btn, { kind: "mini ghost", onClick: () => setWx((v) => v + 1) }, "🔄 刷新"), h(Btn, { kind: "mini ghost", onClick: props.goSettings }, "管理城市"))),
          h(WeatherTable, { cities: store.weatherCities, store, update, refreshKey: wx })),
        h("div", { className: "dsc-sec" },
          h("div", { className: "dsc-sec-h" }, "今日日程",
            h("span", { className: "sp" }, hol ? h("span", { className: "dsc-badge warn" }, hol.name) : null)),
          occ.length ? occ.map((ev) => h(EventRow, { key: ev.id, ev, lunar: l })) : h("div", { className: "dsc-card dsc-empty" }, "今天没有日程")),
        h("div", { className: "dsc-sec" },
          h("div", { className: "dsc-sec-h" }, "待办（未完成）"),
          todos.length ? h("div", { className: "dsc-card", style: { padding: 0 } }, todos.map((t) => h(TodoRow, { key: t.id, todo: t, store, update }))) : h("div", { className: "dsc-card dsc-empty" }, "没有待办")),
        (store.settings.showHoroscope !== false && signObj) ? h("div", { className: "dsc-sec" },
          h("div", { className: "dsc-sec-h" }, "今日星座运势"),
          h("div", { className: "dsc-card dsc-horo" },
            h("div", { className: "dsc-horo-top" },
              h("span", { className: "dsc-horo-emoji" }, signObj.emoji),
              h("span", { className: "dsc-horo-name" }, signObj.cn),
              h("span", { className: "dsc-muted", style: { marginLeft: "auto", fontSize: 11 } }, hz ? hz.date : "")),
            hz ? h("div", null,
              h("div", { className: "dsc-horo-line" }, "综合：" + hz.all),
              h("div", { className: "dsc-horo-line" }, "💗 恋爱：" + hz.love),
              h("div", { className: "dsc-horo-line" }, "💼 事业：" + hz.work),
              h("div", { className: "dsc-horo-line" }, "💰 财运：" + hz.money),
              h("div", { className: "dsc-muted", style: { fontSize: 11.5, marginTop: 4 } }, "幸运色 " + hz.luckyColor + " · 幸运数字 " + hz.luckyNumber),
              h("div", { className: "dsc-sec-h", style: { marginTop: 10 } }, "星座配对（最适合 / 相处）"),
              h("div", { className: "dsc-horo-line" }, "最配：" + ((hz.best || []).map((c) => c.emoji + c.cn).join("、") || "—")),
              h("div", { className: "dsc-compat" }, (hz.compat || []).map((c) => h("div", { key: c.id, className: "dsc-compat-row" }, h("span", null, c.emoji + " " + c.cn), h("span", { className: "dsc-muted" }, c.score + "分 · " + c.desc))))) : h("div", { className: "dsc-muted" }, "运势加载中…"))) : null);
    }

    function EventRow(props) {
      const { ev, lunar, onDelete, status } = props;
      const isLunar = ev.repeat === "lunar-yearly" && ev.lunar;
      return h("div", { className: "dsc-item" + (ev.star ? " star" : "") + (status ? " " + status : "") },
        ev.time ? h("div", { className: "dsc-time" }, ev.time) : h("div", { className: "dsc-time" }, ev.star ? starEl(true, 14) : "·"),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { className: "t" }, (ev.star ? "★ " : "") + ev.title),
          h("div", { className: "m" },
            [isLunar ? "农历" + lunarCn(ev.lunar.month, ev.lunar.day) : (ev.date ? "阳历" + solarMd(ev.date) : ""), ev.repeat && ev.repeat !== "none" && ev.repeat !== "lunar-yearly" ? (EV_LABEL[ev.repeat] || "") : "", ev.note || "", ev.remindMinutes ? "提前" + ev.remindMinutes + "分" : "", ev.createdAt ? "创建于" + ev.createdAt.slice(5, 16).replace("T", " ") : ""].filter(Boolean).join(" · ")),
          ev.star && lunar && !isLunar && lunar.fest ? h("span", { className: "dsc-badge warn" }, lunar.fest) : null),
        onDelete ? h(Btn, { kind: "mini ghost", onClick: () => onDelete(ev.id), title: "删除" }, "×") : null);
    }

    function TodoRow(props) {
      const { todo, store, update } = props;
      const toggle = () => update((s) => ({ ...s, todos: s.todos.map((t) => (t.id === todo.id ? { ...t, done: !t.done, doneAt: !t.done ? new Date().toISOString() : null } : t)) }));
      const due = todo.dueDate || "";
      const overdue = due && !todo.done && due < todayKey();
      return h("div", { className: "dsc-todo" + (todo.done ? " done" : "") },
        h("span", { className: "dsc-check" + (todo.done ? " on" : ""), onClick: toggle }, todo.done ? "✓" : ""),
        h("span", { className: "tx", style: { flex: 1 } }, todo.text,
          due ? h("span", { style: { marginLeft: 8, fontSize: 11, color: overdue ? "var(--red)" : "var(--sub)", fontWeight: overdue ? 600 : 400 } }, (overdue ? "⚠ 逾期 " : "截止 ") + due) : null,
          todo.done && todo.doneAt ? h("span", { style: { marginLeft: 8, fontSize: 10.5, color: "var(--sub)" } }, "完成于 " + todo.doneAt.slice(5, 16).replace("T", " ")) : null),
        h(Btn, { kind: "mini ghost", onClick: () => update((s) => ({ ...s, todos: s.todos.filter((t) => t.id !== todo.id) })) }, "×"));
    }

    /* ---------- 日历 ---------- */
    function CalendarView(props) {
      const { store, update, now, goAdd } = props;
      const [vy, setVy] = useState(now.getFullYear());
      const [vm, setVm] = useState(now.getMonth() + 1); // 1-12
      const [sel, setSel] = useState(todayKey());
      const [menu, setMenu] = useState(null);
      const { days: lunarDays } = useLunar(vy);
      const holidays = useHolidays(vy);
      const occMap = useMemo(() => buildOccMap(store.events, lunarDays || {}, vy), [store.events, lunarDays, vy]);
      const person = store.persons.find((p) => p.id === store.settings.activePersonId) || store.persons[0];

      useEffect(() => {
        if (!menu) return;
        const close = () => setMenu(null);
        document.addEventListener("mousedown", close);
        document.addEventListener("scroll", close, true);
        return () => { document.removeEventListener("mousedown", close); document.removeEventListener("scroll", close, true); };
      }, [menu]);

      const first = new Date(vy, vm - 1, 1);
      const start = addDays(first, -((first.getDay() + 6) % 7));
      const cells = [];
      for (let i = 0; i < 42; i++) {
        const dt = addDays(start, i);
        cells.push(dt);
        if (i >= 34 && dt.getMonth() !== vm - 1 && dt.getDay() === 6) { /* keep */ }
      }
      const monthKey = vy + "-" + pad(vm);
      const shiftMonth = (delta) => {
        let y = vy, m = vm + delta;
        if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
        setVy(y); setVm(m);
      };
      const selDt = parseKey(sel);
      const selLunar = lunarDays && lunarDays[sel];
      const selHol = holidays[sel];
      const selOcc = occurrencesForDate(sel, store.events, lunarDays);
      const selWd = WD[selDt.getDay()];

      return h("div", null,
        h("div", { className: "dsc-cal-wrap" },
          h("div", { className: "dsc-cal-left dsc-card" },
            h("div", { className: "dsc-cal-h" },
              h(Btn, { kind: "mini ghost", onClick: () => shiftMonth(-1) }, "‹"),
              h("span", { className: "dsc-cal-title" }, vy + " 年 " + vm + " 月"),
              h(Btn, { kind: "mini ghost", onClick: () => shiftMonth(1) }, "›"),
              h("span", { style: { marginLeft: "auto" } }, h(Btn, { kind: "mini", onClick: () => { setVy(now.getFullYear()); setVm(now.getMonth() + 1); setSel(todayKey()); } }, "今天"))),
            h("div", { className: "dsc-cal-grid" },
              ["一", "二", "三", "四", "五", "六", "日"].map((w) => h("div", { key: w, className: "dsc-wd" }, w)),
              cells.map((dt, i) => {
                const k = dateKey(dt);
                const inMonth = dt.getMonth() === vm - 1;
                const l = lunarDays && lunarDays[k];
                const hol = holidays[k];
                const wd = dt.getDay();
                const isWeekend = wd === 0 || wd === 6;
                const worked = person ? isWorkday(person, k) : true;
                const holOff = hol && hol.holiday === true;
                const holMakeup = hol && hol.holiday === false;
                let tone = "";
                if (holOff) tone = "holiday";
                else if (holMakeup) tone = "makeup";
                else if (isWeekend) tone = "weekend";
                else if (!worked) tone = "rest";
                const palette = Object.assign({}, CAL_COLORS, (store.settings && store.settings.colors) || {});
                const toneBg = tone ? (palette[tone] || "") : "";
                const occ = occMap[k] || [];
                let lunarTxt = "";
                if (l) lunarTxt = l.fest ? l.fest : (l.lDay === 1 ? l.monthCn : l.dayCn);
                const isToday = k === todayKey();
                const isSel = k === sel;
                let lunarCls = "dsc-lunar";
                if (l && l.fest) lunarCls += " fest";
                else if (l && l.term) lunarCls += " term";
                return h("div", {
                  key: i,
                  className: "dsc-cell" + (inMonth ? "" : " out") + (tone ? " " + tone : "") + (isToday ? " today" : "") + (isSel ? " sel" : ""),
                  style: toneBg ? { backgroundColor: toneBg, color: contrastText(toneBg) } : undefined,
                  onClick: () => setSel(k),
                  onDoubleClick: () => { setSel(k); goAdd(k); },
                  onContextMenu: (e) => { e.preventDefault(); setSel(k); setMenu({ x: e.clientX, y: e.clientY, date: k }); },
                  title: hol ? hol.name : (l ? l.monthCn + l.dayCn : "")
                },
                  h("div", { className: "dsc-dnum" }, dt.getDate()),
                  h("div", { className: lunarCls }, lunarTxt || (hol ? hol.name : "")),
                  h("div", { className: "dsc-dots" }, occ.slice(0, 4).map((ev, j) => h("span", { key: j, className: "dsc-dot" + (ev.star ? " star" : "") }))));
              }))),
          h("div", { className: "dsc-cal-right" },
            h("div", { className: "dsc-card" },
              h("div", { className: "dsc-dayt" }, (selDt.getMonth() + 1) + "月" + selDt.getDate() + "日 " + selWd),
              h("div", { className: "dsc-muted", style: { fontSize: 11.5, marginBottom: 8 } },
                [selLunar ? "农历" + selLunar.monthCn + selLunar.dayCn : "", selLunar && selLunar.term ? selLunar.term : "", selHol ? selHol.name : ""].filter(Boolean).join(" · ") || "农历加载中…"),
              selOcc.length ? selOcc.map((ev) => h(EventRow, { key: ev.id, ev, lunar: selLunar, onDelete: (id) => update((s) => ({ ...s, events: s.events.filter((x) => x.id !== id) })) })) : h("div", { className: "dsc-empty", style: { padding: "8px 0" } }, "当天暂无日程"),
              h("div", { style: { marginTop: 8 } },
                h(Btn, { kind: "pri mini", onClick: () => goAdd(sel) }, "＋ 添加日程"),
                " ",
                h(Btn, { kind: "mini", onClick: () => goAdd(sel, "lunar-yearly") }, "＋ 生日/纪念"))))),
        menu ? h("div", { className: "dsc-ctx", style: { left: menu.x + "px", top: menu.y + "px" } },
          h("button", { onMouseDown: (e) => { e.preventDefault(); e.stopPropagation(); setMenu(null); goAdd(menu.date); } }, "＋ 添加日程"),
          h("button", { onMouseDown: (e) => { e.preventDefault(); e.stopPropagation(); setMenu(null); goAdd(menu.date, "lunar-yearly"); } }, "★ 添加生日/纪念（农历）")) : null);
    }

    /* ---------- 日程 ---------- */
    function EventsView(props) {
      const { store, update, goAdd } = props;
      const today = todayKey();
      const y0 = new Date().getFullYear();
      const l1 = useLunar(y0), l2 = useLunar(y0 + 1);
      const lunarAll = Object.assign({}, l1.days || {}, l2.days || {});
      const cyc = (ev) => {
        const r = repeatOf(ev);
        if (r === "none") return ev.date || "";
        const b = parseKey(today);
        if (r === "yearly") { const a = parseKey(ev.date); return dateKey(new Date(b.getFullYear(), a.getMonth(), a.getDate())); }
        if (r === "lunar-yearly" && ev.lunar) return lunarToSolarInYear(b.getFullYear(), ev.lunar.month, ev.lunar.day, lunarAll) || "";
        if (r === "monthly") { const a = parseKey(ev.date); const dim = new Date(b.getFullYear(), b.getMonth() + 1, 0).getDate(); return dateKey(new Date(b.getFullYear(), b.getMonth(), Math.min(a.getDate(), dim))); }
        if (r === "weekly") { const a = parseKey(ev.date); const delta = (a.getDay() - b.getDay() + 7) % 7; return dateKey(addDays(b, delta)); }
        if (r === "daily") return today;
        return ev.date || "";
      };
      const rows = store.events.map((ev) => {
        const cd = cyc(ev);
        const dim = cd && cd < today;
        const nxt = dim ? (nextOccurrence(ev, today, lunarAll) || cd) : cd;
        const days = nxt ? Math.round((parseKey(nxt) - parseKey(today)) / 86400000) : 999;
        const soon = !dim && !!cd;
        return { ev: ev, sort: nxt || ev.date || "9999", status: dim ? "dim" : (soon ? "soon" : "") };
      }).sort((a, b) => String(a.sort).localeCompare(String(b.sort)));
      return h("div", null,
        h("div", { className: "dsc-sec-h" }, "全部日程", h("span", { className: "sp" }, h(Btn, { kind: "pri mini", onClick: () => goAdd(today) }, "＋ 新建"))),
        rows.length ? rows.map((r) => h(EventRow, { key: r.ev.id, ev: r.ev, status: r.status, onDelete: (id) => update((s) => ({ ...s, events: s.events.filter((x) => x.id !== id) })) })) : h("div", { className: "dsc-card dsc-empty" }, "还没有日程"));
    }

    /* ---------- 待办 ---------- */
    function TodosView(props) {
      const { store, update } = props;
      const [txt, setTxt] = useState("");
      const [due, setDue] = useState("");
      const add = () => { const t = txt.trim(); if (!t) return; update((s) => ({ ...s, todos: [{ id: uid(), text: t, done: false, dueDate: due || "", createdAt: new Date().toISOString(), doneAt: null }].concat(s.todos) })); setTxt(""); setDue(""); };
      const active = store.todos.filter((t) => !t.done).slice().sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")));
      const done = store.todos.filter((t) => t.done);
      return h("div", null,
        h("div", { className: "dsc-row", style: { marginBottom: 10, flexWrap: "wrap" } },
          h("input", { className: "dsc-input", style: { flex: 1, minWidth: 140 }, placeholder: "添加待办…", value: txt, onChange: (e) => setTxt(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") add(); } }),
          h("input", { className: "dsc-input", type: "date", title: "截止日期（可选）", value: due, onChange: (e) => setDue(e.target.value), style: { width: 140 } }),
          h(Btn, { kind: "pri", onClick: add }, "添加")),
        h("div", { className: "dsc-sec-h" }, "未完成 (" + active.length + ")"),
        h("div", { className: "dsc-card", style: { padding: 0 } }, active.length ? active.map((t) => h(TodoRow, { key: t.id, todo: t, store, update })) : h("div", { className: "dsc-empty" }, "太棒了，全部完成")),
        done.length ? h("div", { style: { marginTop: 12 } },
          h("div", { className: "dsc-sec-h" }, "已完成 (" + done.length + ")", h("span", { className: "sp" }, h(Btn, { kind: "mini ghost", onClick: () => update((s) => ({ ...s, todos: s.todos.filter((t) => !t.done) })) }, "清空已完成"))),
          h("div", { className: "dsc-card", style: { padding: 0 } }, done.map((t) => h(TodoRow, { key: t.id, todo: t, store, update })))) : null);
    }

    /* ---------- 报告 ---------- */
    function autoDailyText(store, dateStr, lunarDays) {
      const lines = [];
      lines.push("【日报】" + dateStr);
      lines.push("");
      lines.push("一、当日日程");
      const evs = (store.events || []).filter((ev) => occurrencesForDate(dateStr, [ev], lunarDays || {}).length > 0);
      if (evs.length) evs.forEach((ev) => lines.push("· " + (ev.time ? ev.time + " " : "") + ev.title + (ev.star ? " ★" : "")));
      else lines.push("（无）");
      lines.push("");
      const undone = (store.todos || []).filter((t) => !t.done);
      lines.push("二、未完成任务 (" + undone.length + ")");
      if (undone.length) undone.forEach((t) => lines.push("· " + t.text + (t.dueDate ? "（截止 " + t.dueDate + (t.dueDate < dateStr ? "，已逾期" : "") + "）" : "")));
      else lines.push("（无）");
      lines.push("");
      const doneToday = (store.todos || []).filter((t) => t.done && t.doneAt && t.doneAt.slice(0, 10) === dateStr);
      lines.push("三、本日完成 (" + doneToday.length + ")");
      if (doneToday.length) doneToday.forEach((t) => lines.push("· " + t.text));
      else lines.push("（无）");
      return lines.join("\n");
    }

    function ReportsView(props) {
      const { store, update, now } = props;
      const [tab, setTab] = useState("daily");
      return h("div", null,
        h("div", { className: "dsc-tabs" },
          h("button", { className: tab === "daily" ? "on" : "", onClick: () => setTab("daily") }, "日报"),
          h("button", { className: tab === "weekly" ? "on" : "", onClick: () => setTab("weekly") }, "周报")),
        tab === "daily" ? h(DailyReport, { store, update, now }) : h(WeeklyReport, { store, update, now }));
    }

    function DailyReport(props) {
      const { store, update, now } = props;
      const [date, setDate] = useState(dateKey(now));
      const [txt, setTxt] = useState((store.dailyReports && store.dailyReports[date]) || "");
      const [bStart, setBStart] = useState(dateKey(weekMonday(now)));
      const [bEnd, setBEnd] = useState(dateKey(now));
      const { days: lunarDays } = useLunar(Number((date || "").slice(0, 4)) || now.getFullYear());
      const { days: batchLunar } = useLunar(Number((bStart || "").slice(0, 4)) || now.getFullYear());
      useEffect(() => { setTxt((store.dailyReports && store.dailyReports[date]) || ""); }, [date]);
      const save = () => update((s) => ({ ...s, dailyReports: { ...(s.dailyReports || {}), [date]: txt } }));
      const gen = () => setTxt(autoDailyText(store, date, lunarDays));
      const batch = () => {
        let a = parseKey(bStart), b = parseKey(bEnd);
        if (a - b > 0) { const tmp = a; a = b; b = tmp; }
        const next = { ...(store.dailyReports || {}) };
        let n = 0;
        for (let t = a; t <= b && n < 400; t = addDays(t, 1)) { const k = dateKey(t); next[k] = autoDailyText(store, k, batchLunar); n++; }
        update((s) => ({ ...s, dailyReports: next }));
      };
      const recent = Object.keys(store.dailyReports || {}).sort().reverse().slice(0, 8);
      return h("div", null,
        h("div", { className: "dsc-row", style: { marginBottom: 6, flexWrap: "wrap" } },
          h("span", { className: "dsc-muted" }, "日期"),
          h("input", { className: "dsc-input", type: "date", value: date, onChange: (e) => setDate(e.target.value) }),
          h(Btn, { kind: "mini", onClick: gen }, "一键生成（自动统计）"),
          h(Btn, { kind: "pri", onClick: save }, "保存日报")),
        h("textarea", { className: "dsc-textarea", placeholder: "今天做了什么、进展、问题、明日计划…", value: txt, onChange: (e) => setTxt(e.target.value) }),
        h("div", { className: "dsc-card", style: { marginTop: 10 } },
          h("div", { className: "dsc-sec-h" }, "批量一键生成日报"),
          h("div", { className: "dsc-row", style: { gap: 6, flexWrap: "wrap" } },
            h("input", { className: "dsc-input", type: "date", value: bStart, onChange: (e) => setBStart(e.target.value) }),
            h("span", { className: "dsc-muted" }, "至"),
            h("input", { className: "dsc-input", type: "date", value: bEnd, onChange: (e) => setBEnd(e.target.value) }),
            h(Btn, { kind: "pri mini", onClick: batch }, "批量生成并保存"))),
        recent.length ? h("div", { style: { marginTop: 12 } }, h("div", { className: "dsc-sec-h" }, "最近日报"),
          recent.map((d) => h("div", { key: d, className: "dsc-item", style: { cursor: "pointer" }, onClick: () => setDate(d) },
            h("div", { className: "dsc-time" }, mmdd(d)),
            h("div", { style: { flex: 1, minWidth: 0 } }, h("div", { className: "m", style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, (store.dailyReports[d] || "").slice(0, 40) || "（空）"))))) : null);
    }

    function WeeklyReport(props) {
      const { store, update, now } = props;
      const [off, setOff] = useState(0);
      const monday = addDays(weekMonday(now), off * 7);
      const sunday = addDays(monday, 6);
      const mk = dateKey(monday), sk = dateKey(sunday);
      const key = mk + "~" + sk;
      const reports = [];
      for (let i = 0; i < 7; i++) { const k = dateKey(addDays(monday, i)); if (store.dailyReports && store.dailyReports[k]) reports.push({ k, t: store.dailyReports[k] }); }
      const doneTodos = (store.todos || []).filter((t) => t.done && t.doneAt && t.doneAt.slice(0, 10) >= mk && t.doneAt.slice(0, 10) <= sk);
      const undoneTodos = (store.todos || []).filter((t) => !t.done);
      const auto = useMemo(() => {
        const lines = [];
        lines.push("【本周周报】" + mk + " ~ " + sk);
        lines.push("");
        lines.push("一、每日进展（由日报汇总）");
        if (reports.length) reports.forEach((r) => { lines.push("· " + r.k.slice(5) + "：" + (r.t || "").replace(/\n+/g, "；")); });
        else lines.push("（本周暂无日报，可先在日报页一键生成）");
        lines.push("");
        lines.push("二、本周完成 (" + doneTodos.length + ")");
        if (doneTodos.length) doneTodos.forEach((t) => lines.push("· " + t.text));
        else lines.push("（无）");
        lines.push("");
        lines.push("三、尚未完成 (" + undoneTodos.length + ")");
        if (undoneTodos.length) undoneTodos.forEach((t) => lines.push("· " + t.text + (t.dueDate ? "（截止 " + t.dueDate + "）" : "")));
        else lines.push("（无）");
        return lines.join("\n");
      }, [mk, sk, JSON.stringify(reports), JSON.stringify(doneTodos), JSON.stringify(undoneTodos)]);
      const stored = store.weeklyReports && store.weeklyReports[key];
      const [draft, setDraft] = useState(stored != null ? stored : auto);
      useEffect(() => { setDraft(stored != null ? stored : auto); }, [key, stored, auto]);
      const copy = () => { try { navigator.clipboard.writeText(draft); } catch (e) {} };
      const save = () => update((s) => ({ ...s, weeklyReports: { ...(s.weeklyReports || {}), [key]: draft } }));
      const regen = () => { setDraft(auto); update((s) => { const w = { ...(s.weeklyReports || {}) }; delete w[key]; return { ...s, weeklyReports: w }; }); };
      return h("div", null,
        h("div", { className: "dsc-row", style: { marginBottom: 8, flexWrap: "wrap" } },
          h(Btn, { kind: "mini ghost", onClick: () => setOff(off - 1) }, "‹ 上周"),
          h("span", { className: "dsc-cal-title" }, mk + " ~ " + sk),
          h(Btn, { kind: "mini ghost", onClick: () => setOff(off + 1) }, "下周 ›"),
          h("span", { style: { marginLeft: "auto" } }, h(Btn, { kind: "mini", onClick: copy }, "复制"), " ", h(Btn, { kind: "mini", onClick: save }, "保存修改"), " ", h(Btn, { kind: "mini ghost", onClick: regen }, "由日报重新生成"))),
        h("textarea", { className: "dsc-textarea", style: { minHeight: 220 }, value: draft, onChange: (e) => setDraft(e.target.value) }));
    }
    function PeopleView(props) {
      const { store, update, now } = props;
      const setPerson = (id, fn) => update((s) => ({ ...s, persons: s.persons.map((p) => (p.id === id ? fn(p) : p)) }));
      const addPerson = () => update((s) => ({ ...s, persons: s.persons.concat([{ id: uid(), name: "成员" + (s.persons.length + 1), schedule: { type: "double", workStart: "09:00", workEnd: "18:00", anchorDate: dateKey(weekMonday(new Date())), anchorIsBig: true, customWorkdays: [1, 2, 3, 4, 5] } }]) }));
      const refreshSign = (p) => {
        const b = p.birthday || {};
        if (!b.month || !b.day) return;
        if (b.type !== "lunar") { const z = solarSign(b.month, b.day); setPerson(p.id, (x) => ({ ...x, signId: z.id, signName: z.cn })); return; }
        getJson(apiUrl("/lunar2solar", "y=" + (b.year || new Date().getFullYear()) + "&m=" + b.month + "&d=" + b.day)).then((j) => { if (j && j.ok) { const z = solarSign(j.solar.m, j.solar.d); setPerson(p.id, (x) => ({ ...x, signId: z.id, signName: z.cn })); } }).catch(() => {});
      };
      const thisMonday = dateKey(weekMonday(now));
      return h("div", null,
        store.persons.map((p) => {
          const sc = p.schedule;
          const curBig = isBigWeek(thisMonday, sc);
          return h("div", { key: p.id, className: "dsc-card", style: { marginBottom: 10 } },
            h("div", { className: "dsc-row" },
              h("input", { className: "dsc-input", style: { flex: 1, fontWeight: 700 }, value: p.name, onChange: (e) => setPerson(p.id, (x) => ({ ...x, name: e.target.value })) }),
              store.persons.length > 1 ? h(Btn, { kind: "mini ghost", onClick: () => update((s) => ({ ...s, persons: s.persons.filter((x) => x.id !== p.id) })) }, "删除") : null),
            h("div", { style: { height: 8 } }),
            h("div", { className: "dsc-row" },
              h(Field, { label: "班制" },
                h("select", { className: "dsc-select", value: sc.type, onChange: (e) => setPerson(p.id, (x) => ({ ...x, schedule: { ...x.schedule, type: e.target.value } })) },
                  h("option", { value: "double" }, "双休"),
                  h("option", { value: "bigsmall" }, "大小周"),
                  h("option", { value: "single" }, "单休"),
                  h("option", { value: "custom" }, "自定义"))),
              h(Field, { label: "上班" }, h("input", { className: "dsc-input", type: "time", value: sc.workStart, onChange: (e) => setPerson(p.id, (x) => ({ ...x, schedule: { ...x.schedule, workStart: e.target.value } })) })),
              h(Field, { label: "下班" }, h("input", { className: "dsc-input", type: "time", value: sc.workEnd, onChange: (e) => setPerson(p.id, (x) => ({ ...x, schedule: { ...x.schedule, workEnd: e.target.value } })) }))),
            h("div", { className: "dsc-row", style: { marginTop: 6, flexWrap: "wrap" } },
              h(Field, { label: "生日" }, h("select", { className: "dsc-select", value: (p.birthday && p.birthday.type) || "solar", onChange: (e) => setPerson(p.id, (x) => ({ ...x, birthday: { ...(x.birthday || {}), type: e.target.value } })) },
                h("option", { value: "solar" }, "阳历"),
                h("option", { value: "lunar" }, "农历"))),
              h(Field, { label: "年" }, h("input", { className: "dsc-input", type: "number", style: { width: 76 }, placeholder: "1990", value: (p.birthday && p.birthday.year) || "", onChange: (e) => setPerson(p.id, (x) => ({ ...x, birthday: { ...(x.birthday || {}), year: Number(e.target.value) || 0 } })) })),
              h(Field, { label: "月" }, h("input", { className: "dsc-input", type: "number", style: { width: 58 }, value: (p.birthday && p.birthday.month) || "", onChange: (e) => setPerson(p.id, (x) => ({ ...x, birthday: { ...(x.birthday || {}), month: Number(e.target.value) || 0 } })) })),
              h(Field, { label: "日" }, h("input", { className: "dsc-input", type: "number", style: { width: 58 }, value: (p.birthday && p.birthday.day) || "", onChange: (e) => setPerson(p.id, (x) => ({ ...x, birthday: { ...(x.birthday || {}), day: Number(e.target.value) || 0 } })) })),
              h(Btn, { kind: "mini pri", onClick: () => refreshSign(p) }, "识别星座"),
              h("span", { className: "dsc-tagline", style: { alignSelf: "center" } }, p.signName ? ("星座：" + p.signName) : "未识别")),
            sc.type === "bigsmall" ? h("div", { style: { marginTop: 8 } },
              h("div", { className: "dsc-tagline" }, "本周（" + thisMonday.slice(5) + " 起）是：" + (curBig ? "大周（周六休息，双休）" : "小周（周六上班，周日休）")),
              h("div", { className: "dsc-row", style: { marginTop: 4 } },
                h(Btn, { kind: "mini" + (curBig ? "" : " pri"), onClick: () => setPerson(p.id, (x) => ({ ...x, schedule: { ...x.schedule, anchorDate: thisMonday, anchorIsBig: true } })) }, "本周设为大周"),
                h(Btn, { kind: "mini" + (curBig ? " pri" : ""), onClick: () => setPerson(p.id, (x) => ({ ...x, schedule: { ...x.schedule, anchorDate: thisMonday, anchorIsBig: false } })) }, "本周设为小周")),
              h("div", { className: "dsc-tagline" }, "设置后按单双周自动交替排列。")) : null,
            sc.type === "custom" ? h("div", { style: { marginTop: 8 } },
              h("div", { className: "dsc-muted", style: { fontSize: 11.5 } }, "勾选上班的星期："),
              h("div", { className: "dsc-wk", style: { marginTop: 4, flexWrap: "wrap" } },
                [1, 2, 3, 4, 5, 6, 0].map((wd) => h("label", { key: wd },
                  h("input", { type: "checkbox", checked: (sc.customWorkdays || []).indexOf(wd) >= 0, onChange: (e) => setPerson(p.id, (x) => { const arr = (x.schedule.customWorkdays || []).slice(); const i = arr.indexOf(wd); if (e.target.checked) { if (i < 0) arr.push(wd); } else if (i >= 0) arr.splice(i, 1); return { ...x, schedule: { ...x.schedule, customWorkdays: arr } }; }) }),
                  WD[wd].replace("周", ""))))): null);
        }),
        h(Btn, { kind: "mini", onClick: addPerson }, "＋ 添加成员"));
    }

    /* ---------- 设置 ---------- */
    function cityTitle(c) {
      const d = (c && (c.district || c.name)) || "";
      if (c && c.city && c.city !== d) return c.city + "·" + d;
      return d;
    }

    function RegionPicker(props) {
      const onAdd = props.onAdd;
      const [provs, setProvs] = useState([]);
      const [cities, setCities] = useState([]);
      const [dists, setDists] = useState([]);
      const [sp, setSp] = useState("");
      const [sc, setSc] = useState("");
      const [sd, setSd] = useState("");
      const [loading, setLoading] = useState(false);
      const P = Array.isArray(provs) ? provs : [];
      const C = Array.isArray(cities) ? cities : [];
      const D = Array.isArray(dists) ? dists : [];
      const load = (adcode, setter) => {
        setLoading(true);
        getJson(apiUrl("/divisions", "adcode=" + encodeURIComponent(adcode)))
          .then((j) => setter(j && j.ok ? j.list || [] : []))
          .catch(() => setter([]))
          .finally(() => setLoading(false));
      };
      useEffect(() => {
        let alive = true;
        getJson(apiUrl("/divisions", "adcode=100000"))
          .then((j) => { if (alive && j && j.ok) setProvs(j.list || []); })
          .catch(() => {});
        return () => { alive = false; };
      }, []);
      const onProv = (e) => { const v = e.target.value; setSp(v); setSc(""); setSd(""); setCities([]); setDists([]); if (v) load(v, setCities); };
      const onCity = (e) => { const v = e.target.value; setSc(v); setSd(""); setDists([]); if (v) load(v, setDists); };
      let cur = null;
      if (D.length && sd) cur = D.find((x) => String(x.adcode) === sd) || null;
      else if (!D.length && C.length && sc) cur = C.find((x) => String(x.adcode) === sc) || null;
      else if (!C.length && sp) cur = P.find((x) => String(x.adcode) === sp) || null;
      const pv = P.find((x) => String(x.adcode) === sp) || null;
      const cv = C.find((x) => String(x.adcode) === sc) || null;
      const add = () => {
        if (!cur) return;
        const leafIsDistrict = D.length > 0 && !!sd;
        const province = pv ? pv.name : "";
        const cityName = leafIsDistrict ? (cv ? cv.name : "") : province;
        onAdd({ name: cur.name, province: province, city: cityName, district: cur.name, latitude: cur.lat, longitude: cur.lng });
        setSd("");
      };
      return h("div", { className: "dsc-sec" },
        h("div", { className: "dsc-sec-h" }, "按省 / 市 / 区添加"),
        h("div", { className: "dsc-row", style: { gap: 6, flexWrap: "wrap" } },
          h("select", { className: "dsc-select", value: sp, onChange: onProv },
            h("option", { value: "" }, "省份"),
            P.map((x) => h("option", { key: x.adcode, value: x.adcode }, x.name))),
          h("select", { className: "dsc-select", value: sc, onChange: onCity, disabled: !C.length },
            h("option", { value: "" }, C.length ? "城市" : "—"),
            C.map((x) => h("option", { key: x.adcode, value: x.adcode }, x.name))),
          h("select", { className: "dsc-select", value: sd, onChange: (e) => setSd(e.target.value), disabled: !D.length },
            h("option", { value: "" }, D.length ? "区 / 县" : "—"),
            D.map((x) => h("option", { key: x.adcode, value: x.adcode }, x.name)))),
        h("div", { className: "dsc-row", style: { marginTop: 6 } },
          h("span", { className: "dsc-muted", style: { flex: 1, fontSize: 11.5 } },
            cur ? "将添加：" + [pv ? pv.name : "", cv && cv.name !== (pv ? pv.name : "") ? cv.name : "", cur.name].filter(Boolean).join("·") + "（" + cur.lat.toFixed(3) + "," + cur.lng.toFixed(3) + "）" : (loading ? "加载中…" : "请选择省 / 市 / 区")),
          h(Btn, { kind: "mini pri", onClick: add, disabled: !cur }, "＋ 添加")));
    }

    function SettingsView(props) {
      const { store, update, now } = props;
      const [q, setQ] = useState("");
      const [results, setResults] = useState([]);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      const search = async () => {
        const s = q.trim(); if (!s) return;
        setBusy(true); setMsg("");
        try { const j = await getJson(apiUrl("/geocode", "q=" + encodeURIComponent(s))); setResults((j && j.results) || []); if (!j || !j.ok) setMsg("查询失败：" + ((j && j.error) || "")); else if (!(j.results || []).length) setMsg("没找到，换个写法试试（如「北京 朝阳」）"); }
        catch (e) { setMsg(String((e && e.message) || e)); }
        setBusy(false);
      };
      const addCity = (r) => update((s) => {
        if ((s.weatherCities || []).some((c) => Math.abs(c.latitude - r.latitude) < 0.02 && Math.abs(c.longitude - r.longitude) < 0.02)) return s;
        const parts = r.fullName ? r.fullName.split("·") : [r.name];
        const district = parts.length > 1 ? parts[parts.length - 1] : "";
        const province = parts.length >= 3 ? parts[0] : "";
        const cityName = parts.length >= 3 ? parts[1] : (parts.length === 2 ? parts[0] : "");
        const city = { id: uid(), name: r.name, province: province, city: cityName, district: district, fullName: r.fullName, latitude: r.latitude, longitude: r.longitude };
        const nc = (s.weatherCities || []).concat([city]);
        return { ...s, weatherCities: nc, settings: { ...s.settings, activeCityId: s.settings.activeCityId || city.id } };
      });
      const addRegion = (rec) => update((s) => {
        if ((s.weatherCities || []).some((c) => Math.abs(c.latitude - rec.latitude) < 0.02 && Math.abs(c.longitude - rec.longitude) < 0.02)) return s;
        const city = { id: uid(), name: rec.name, province: rec.province || "", city: rec.city || "", district: rec.district || rec.name, fullName: [rec.province, rec.city, rec.district].filter(Boolean).join("·"), latitude: rec.latitude, longitude: rec.longitude };
        const nc = (s.weatherCities || []).concat([city]);
        return { ...s, weatherCities: nc, settings: { ...s.settings, activeCityId: s.settings.activeCityId || city.id } };
      });
      return h("div", null,
        h("div", { className: "dsc-sec-h" }, "人员休息日 / 班制"),
        h(PeopleView, { store, update, now: now || new Date() }),
        h(RegionPicker, { onAdd: addRegion }),
        h("div", { className: "dsc-sec" },
          h("div", { className: "dsc-sec-h" }, "搜索城市 / 区"),
          h("div", { className: "dsc-row", style: { marginBottom: 8 } },
            h("input", { className: "dsc-input", style: { flex: 1 }, placeholder: "搜索城市/区，如 北京 朝阳、浦东新区", value: q, onChange: (e) => setQ(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") search(); } }),
            h(Btn, { kind: "pri", onClick: search, disabled: busy }, busy ? "查询中" : "搜索")),
          msg ? h("div", { className: "dsc-tagline" }, msg) : null,
          results.length ? h("div", { className: "dsc-card", style: { padding: 0, marginBottom: 8 } }, results.map((r, i) => h("div", { key: i, className: "dsc-todo", style: { cursor: "pointer" }, onClick: () => { addCity(r); setResults([]); setQ(""); } },
            h("span", { style: { flex: 1 } }, r.fullName || r.name),
            h(Btn, { kind: "mini pri" }, "＋ 添加")))) : null,
          (store.weatherCities || []).length ? h("div", { className: "dsc-card", style: { padding: 0 } }, (store.weatherCities || []).map((c) => h("div", { key: c.id, className: "dsc-todo" },
            h("span", { style: { flex: 1 } }, cityTitle(c)),
            h("span", { className: "dsc-muted", style: { fontSize: 11 } }, c.latitude.toFixed(2) + "," + c.longitude.toFixed(2)),
            h(Btn, { kind: "mini ghost", onClick: () => update((s) => ({ ...s, weatherCities: s.weatherCities.filter((x) => x.id !== c.id) })) }, "删除")))) : h("div", { className: "dsc-empty" }, "还没有城市")),
        h("div", { className: "dsc-sec dsc-card" },
          h("div", { className: "dsc-sec-h" }, "提醒"),
          h("label", { className: "dsc-row", style: { marginBottom: 6 } }, h("input", { type: "checkbox", checked: !!store.settings.reminderSound, onChange: (e) => update((s) => ({ ...s, settings: { ...s.settings, reminderSound: e.target.checked } })) }), "提示音"),
          h("label", { className: "dsc-row" }, h("input", { type: "checkbox", checked: !!store.settings.workReminder, onChange: (e) => update((s) => ({ ...s, settings: { ...s.settings, workReminder: e.target.checked } })) }), "上下班提醒"),
          h("label", { className: "dsc-row", style: { marginTop: 4 } }, h("input", { type: "checkbox", checked: store.settings.showAlmanac !== false, onChange: (e) => update((s) => ({ ...s, settings: { ...s.settings, showAlmanac: e.target.checked } })) }), "今日头部显示黄历（宜/忌）"),
          h("label", { className: "dsc-row", style: { marginTop: 4 } }, h("input", { type: "checkbox", checked: store.settings.showHoroscope !== false, onChange: (e) => update((s) => ({ ...s, settings: { ...s.settings, showHoroscope: e.target.checked } })) }), "今日底部显示星座运势")),
        h("div", { className: "dsc-sec dsc-card" },
          h("div", { className: "dsc-sec-h" }, "日历配色（点色块改颜色）"),
          [["weekend", "周末"], ["rest", "休息日"], ["holiday", "法定假期"], ["makeup", "补班上班"]].map((pair) =>
            h("label", { key: pair[0], className: "dsc-row", style: { marginBottom: 4 } },
              h("span", { style: { flex: 1 } }, pair[1]),
              h("input", { type: "color", value: (store.settings.colors || CAL_COLORS)[pair[0]] || CAL_COLORS[pair[0]], onChange: (e) => update((s) => ({ ...s, settings: { ...s.settings, colors: Object.assign({}, CAL_COLORS, s.settings.colors || {}, { [pair[0]]: e.target.value }) } })), style: { width: 44, height: 24, padding: 0, border: "none", background: "transparent" } }),
              h(Btn, { kind: "mini ghost", onClick: () => update((s) => ({ ...s, settings: { ...s.settings, colors: Object.assign({}, CAL_COLORS, s.settings.colors || {}, { [pair[0]]: CAL_COLORS[pair[0]] }) } })) }, "默认")))),
        h("div", { className: "dsc-sec dsc-card" },
          h("div", { className: "dsc-sec-h" }, "数据"),
          h("div", { className: "dsc-row" },
            h(Btn, { kind: "mini", onClick: () => props.reload() }, "重新加载"),
            h("span", { className: "dsc-muted", style: { fontSize: 11.5 } }, "数据存插件包 data/store.json，自动保存"))),
        h("div", { className: "dsc-sec dsc-card" },
          h("div", { className: "dsc-sec-h" }, "关于"),
          h("div", { className: "dsc-row" },
            h("span", { style: { flex: 1, fontSize: 12 } }, "日程助手 · 开源插件，喜欢请点个 Star ⭐"),
            h(Btn, { kind: "mini pri", onClick: () => { try { window.open(REPO_URL, "_blank"); } catch (e) { /* ignore */ } } }, "GitHub Star"))),
        h("div", { className: "dsc-tagline", style: { textAlign: "center", marginTop: 12 } }, "日程助手 v" + VERSION));
    }

    /* ---------- 添加日程弹窗（内联面板） ---------- */
    function AddPanel(props) {
      const { store, update, init, onClose } = props;
      const [title, setTitle] = useState("");
      const [date, setDate] = useState(init.date || todayKey());
      const [time, setTime] = useState("");
      const [note, setNote] = useState("");
      const [remind, setRemind] = useState(10);
      const [star, setStar] = useState(init.mode === "lunar-yearly");
      const [mode, setMode] = useState(init.mode || "none");
      const [lMonth, setLMonth] = useState(1);
      const [lDay, setLDay] = useState(1);
      const save = () => {
        const t = title.trim(); if (!t) return;
        const ev = { id: uid(), date: date, time: time, title: t, note: note, remindMinutes: Number(remind) || 0, star: !!star, createdAt: new Date().toISOString() };
        if (mode === "lunar-yearly") { ev.repeat = "lunar-yearly"; ev.lunar = { month: Number(lMonth), day: Number(lDay) }; ev.star = true; }
        else ev.repeat = mode || "none";
        update((s) => ({ ...s, events: s.events.concat([ev]) }));
        onClose();
      };
      const mSel = (val, set, n) => h("select", { className: "dsc-select", value: val, onChange: (e) => set(Number(e.target.value)) },
        Array.from({ length: n }).map((_, i) => h("option", { key: i + 1, value: i + 1 }, (mode === "lunar-yearly" && set === setLMonth ? i + 1 : i + 1))));
      return h("div", { className: "dsc-card", style: { marginBottom: 10, borderColor: "var(--accent)" } },
        h("div", { className: "dsc-sec-h" }, mode === "lunar-yearly" ? "添加生日/纪念（农历）" : "添加日程", h("span", { className: "sp" }, h(Btn, { kind: "mini ghost", onClick: onClose }, "取消"))),
        h("div", { className: "dsc-row", style: { marginBottom: 6 } },
          h("input", { className: "dsc-input", style: { flex: 1 }, placeholder: "标题", value: title, autoFocus: true, onChange: (e) => setTitle(e.target.value) })),
        mode === "lunar-yearly" ? h("div", { className: "dsc-row", style: { marginBottom: 6 } },
          h(Field, { label: "农历" }, h("select", { className: "dsc-select", value: lMonth, onChange: (e) => setLMonth(Number(e.target.value)) }, Array.from({ length: 12 }).map((_, i) => h("option", { key: i + 1, value: i + 1 }, (i + 1) + " 月")))),
          h("select", { className: "dsc-select", value: lDay, onChange: (e) => setLDay(Number(e.target.value)) }, Array.from({ length: 30 }).map((_, i) => h("option", { key: i + 1, value: i + 1 }, (i + 1) + " 日"))))
          : h("div", { className: "dsc-row", style: { marginBottom: 6 } },
            h(Field, { label: "日期" }, h("input", { className: "dsc-input", type: "date", value: date, onChange: (e) => setDate(e.target.value) })),
            h(Field, { label: "时间" }, h("input", { className: "dsc-input", type: "time", value: time, onChange: (e) => setTime(e.target.value) }))),
        h("div", { className: "dsc-row", style: { marginBottom: 6 } },
          h(Field, { label: "类型" }, h("select", { className: "dsc-select", value: mode, onChange: (e) => setMode(e.target.value) },
            h("option", { value: "none" }, "不重复"),
            h("option", { value: "daily" }, "每日"),
            h("option", { value: "weekly" }, "每周"),
            h("option", { value: "monthly" }, "每月"),
            h("option", { value: "yearly" }, "每年"),
            h("option", { value: "lunar-yearly" }, "农历每年（生日/纪念）"))),
          h(Field, { label: "提前" }, h("select", { className: "dsc-select", value: remind, onChange: (e) => setRemind(e.target.value) },
            [0, 5, 10, 15, 30, 60].map((m) => h("option", { key: m, value: m }, m === 0 ? "不提醒" : m + " 分钟"))))),
        h("div", { className: "dsc-row", style: { marginBottom: 6 } },
          h("label", { className: "dsc-row" }, h("input", { type: "checkbox", checked: star, onChange: (e) => setStar(e.target.checked) }), "星标提醒")),
        h("input", { className: "dsc-input", style: { width: "100%", marginBottom: 8 }, placeholder: "备注（可选）", value: note, onChange: (e) => setNote(e.target.value) }),
        h("div", { className: "dsc-row" }, h(Btn, { kind: "pri", onClick: save }, "保存"), h(Btn, { kind: "mini", onClick: onClose }, "取消")));
    }

    /* ============================ 主 Tab ============================ */
    function ScheduleTab(props) {
      const { ctx } = props;
      const { store, status, err, update, reload } = useStore();
      const [nav, setNav] = useState("today");
      const [now, setNow] = useState(new Date());
      const [adding, setAdding] = useState(null);
      const [alert, setAlert] = useState("");
      const fired = useRef({});
      const alertTimer = useRef(null);

      useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

      const yearNow = now.getFullYear();
      const lunarNow = useLunar(yearNow);
      const almanacToday = useAlmanac(dateKey(now));
      const holidaysNow = useHolidays(yearNow);
      const lunarTodayDays = lunarNow.days || {};

      const person = store ? (store.persons.find((p) => p.id === store.settings.activePersonId) || store.persons[0]) : null;

      const showAlert = useCallback((msg) => {
        setAlert(msg);
        if (alertTimer.current) clearTimeout(alertTimer.current);
        alertTimer.current = setTimeout(() => setAlert(""), 9000);
      }, []);

      const doCheckin = useCallback(() => {
        if (!store) return;
        const tk = dateKey(now);
        const b = store.settings.buff || {};
        if (b.date === tk) { showAlert("今天已签到～ 今日Buff：「" + (b.text || "") + "」 连续 " + (b.streak || 1) + " 天"); return; }
        const yest = dateKey(addDays(parseKey(tk), -1));
        const streak = b.date === yest ? (b.streak || 1) + 1 : 1;
        const text = BUFFS[Math.floor(Math.random() * BUFFS.length)];
        const tip = HEALTH_TIPS[Math.floor(Math.random() * HEALTH_TIPS.length)];
        update((s) => ({ ...s, settings: { ...s.settings, buff: { date: tk, text: text, streak: streak } } }));
        showAlert("🎉 签到成功！获得好运Buff：「" + text + "」 · 连续签到 " + streak + " 天。" + tip);
        try { beep(); } catch (e) { /* ignore */ }
      }, [store, now, update, showAlert]);

      /* 提醒扫描 */
      useEffect(() => {
        if (!store || !person) return;
        const tk = dateKey(now);
        const due = [];
        if (store.settings.workReminder && isWorkday(person, tk)) {
          const sc = person.schedule;
          const [sh, sm] = sc.workStart.split(":").map(Number);
          const [eh, em] = sc.workEnd.split(":").map(Number);
          if (now.getHours() === sh && now.getMinutes() === sm) due.push({ key: "ws-" + tk, msg: "该上班啦（" + person.name + " " + sc.workStart + "）" });
          if (now.getHours() === eh && now.getMinutes() === em) due.push({ key: "we-" + tk, msg: "该下班啦（" + person.name + " " + sc.workEnd + "）" });
        }
        const occ = occurrencesForDate(tk, store.events, lunarTodayDays);
        for (const ev of occ) {
          if (ev.time) {
            const [hh, mm] = ev.time.split(":").map(Number);
            const evMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0).getTime();
            const remindMs = evMs - (ev.remindMinutes || 0) * 60000;
            if (now.getTime() >= remindMs && now.getTime() < evMs + 60000) due.push({ key: "ev-" + tk + "-" + ev.id, msg: "日程提醒：" + ev.title + " " + ev.time });
          } else if (ev.star) {
            due.push({ key: "star-" + tk + "-" + ev.id, msg: "今日纪念：★ " + ev.title });
          }
        }
        for (const d of due) {
          if (!fired.current[d.key]) {
            fired.current[d.key] = true;
            showAlert(d.msg);
            if (store.settings.reminderSound) beep();
          }
        }
      }, [now, store, person, lunarTodayDays, showAlert]);

      const goAdd = (date, mode) => { setAdding({ date: date || todayKey(), mode: mode || "none" }); setNav("calendar"); };

      if (status === "loading") return h("div", { className: "dsc-root" }, h("div", { className: "dsc-body dsc-empty" }, "日程助手加载中…"));
      if (status === "error" || !store) return h("div", { className: "dsc-root" }, h("div", { className: "dsc-body" }, h("div", { className: "dsc-empty" }, "加载失败：" + (err || "未知错误")), h("div", { style: { textAlign: "center" } }, h(Btn, { onClick: reload }, "重试"))));

      const tk = dateKey(now);
      const lToday = lunarNow.days && lunarNow.days[tk];
      const holToday = holidaysNow[tk];
      const ws = workStatus(person, now);
      const navItems = [["today", "今日"], ["calendar", "日历"], ["events", "日程"], ["todos", "待办"], ["reports", "报告"], ["settings", "设置"]];

      return h("div", { className: "dsc-root" },
        h("div", { className: "dsc-head" },
          h("div", null,
            h("div", { className: "dsc-hdate" }, now.getMonth() + 1 + "月" + now.getDate() + "日 " + WD[now.getDay()] + (function () { const p = [lToday ? "农历" + lToday.monthCn + lToday.dayCn : "", lToday && lToday.term ? lToday.term : "", holToday ? holToday.name : ""].filter(Boolean); if (store.settings.showAlmanac !== false && almanacToday) { p.push("宜：" + (almanacToday.yi || []).join("/") + " 忌：" + (almanacToday.ji || []).join("/")); } return p.length ? " · " + p.join(" · ") : ""; })())),
          h("div", { className: "dsc-pill" + (ws.rest ? " rest" : "") },
            ws.rest ? "今日休息" : h("span", null, ws.label + " ", h("small", null, fmtDur(ws.ms)))),
          h("button", { className: "dsc-btn mini", style: { marginLeft: 6 }, onClick: () => { setNav("settings"); }, title: "设置" }, "⚙"),
          h("span", { style: { fontSize: 10, color: "var(--sub)", marginLeft: 4, whiteSpace: "nowrap" } }, "v" + VERSION)),
        store ? h("div", { className: "dsc-buffbar" },
          h("span", { className: "dsc-buff-ico" }, "🎁"),
          h("span", { className: "dsc-buff-txt" }, (store.settings.buff && store.settings.buff.date === dateKey(now)) ? ("今日Buff：「" + (store.settings.buff.text || "") + "」 · 连续签到 " + (store.settings.buff.streak || 0) + " 天") : "今日还没签到，点右侧签到得好运Buff"),
          h("span", { style: { flex: 1 } }),
          h(Btn, { kind: "mini pri", onClick: doCheckin }, (store.settings.buff && store.settings.buff.date === dateKey(now)) ? "已签到" : "签到")) : null,
        alert ? h("div", { className: "dsc-alert" }, "🔔 " + alert) : null,
        h("div", { className: "dsc-nav" }, navItems.map(([k, label]) => h("button", { key: k, className: nav === k ? "on" : "", onClick: () => setNav(k) }, label))),
        h("div", { className: "dsc-body" },
          adding ? h(AddPanel, { store, update, init: adding, onClose: () => setAdding(null) }) : null,
          nav === "today" ? h(TodayView, { store, update, now, lunarToday: lunarNow.days, holidays: holidaysNow, goSettings: () => setNav("settings") }) : null,
          nav === "calendar" ? h(CalendarView, { store, update, now, goAdd }) : null,
          nav === "events" ? h(EventsView, { store, update, goAdd }) : null,
          nav === "todos" ? h(TodosView, { store, update }) : null,
          nav === "reports" ? h(ReportsView, { store, update, now }) : null,
          nav === "settings" ? h(SettingsView, { store, update, reload, now }) : null));
    }

    function workStatus(person, now) {
      const tk = dateKey(now);
      const sc = person.schedule;
      if (!isWorkday(person, tk)) return { rest: true, text: "今日休息" };
      const [sh, sm] = sc.workStart.split(":").map(Number);
      const [eh, em] = sc.workEnd.split(":").map(Number);
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm, 0);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), eh, em, 0);
      if (now < start) return { phase: "before", ms: start - now, label: "距上班", rest: false };
      if (now < end) return { phase: "during", ms: end - now, label: "距下班", rest: false };
      return { phase: "after", ms: 0, label: "已下班", rest: false };
    }
    function fmtDur(ms) {
      if (ms < 0) ms = 0;
      const s = Math.floor(ms / 1000);
      const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
      return (hh > 0 ? hh + ":" : "") + pad(mm) + ":" + pad(ss);
    }

    /* ============================ apply ============================ */
    function openSchedulePanel(ctx) {
      try { if (ctx.layout && ctx.layout.openRightbar) ctx.layout.openRightbar(true, false); } catch (e) { /* ignore */ }
      try { if (ctx.betterSidebar && ctx.betterSidebar.openTab) ctx.betterSidebar.openTab({ type: NAME, title: "日程助手", reveal: true }); } catch (e) { /* ignore */ }
    }

    function LaunchButton(props) {
      const ic = tabIcon(16);
      try { ic.props.style = { display: "block" }; } catch (e) { /* ignore */ }
      return h("div", {
        role: "button",
        tabIndex: 0,
        title: "打开日程助手",
        onClick: () => openSchedulePanel(props.ctx),
        onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") openSchedulePanel(props.ctx); },
        style: { display: "flex", alignItems: "center", justifyContent: "flex-start", gap: "7px", width: "100%", height: "30px", margin: 0, padding: "0 0 0 5px", border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "13px", fontFamily: "inherit", lineHeight: "1", textAlign: "left", boxSizing: "border-box" },
      },
        h("span", { style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "16px", height: "16px", flex: "0 0 auto", lineHeight: "1" } }, ic),
        h("span", { style: { display: "inline-flex", alignItems: "center", height: "16px", lineHeight: "1", fontSize: "13px", whiteSpace: "nowrap" } }, "日程助手"));
    }

    function apply(ctx) {
      try { ensureStyles(); } catch (e) { /* ignore */ }
      const bs = ctx && ctx.betterSidebar;
      if (!bs || !bs.registerTab) return;
      const reg = () => bs.registerTab({ id: NAME, title: "日程助手", icon: (s) => tabIcon(s), component: (p) => h(ScheduleTab, Object.assign({ ctx: ctx }, p)) });
      try { if (ctx.effect) ctx.effect(reg); else reg(); } catch (e) { try { reg(); } catch (e2) { /* ignore */ } }
      try {
        if (ctx.slots && ctx.slots.inject && ctx.slots.register) {
          ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: NAME, order: 50, label: () => "日程助手" }, () => h(LaunchButton, { ctx })));
        }
      } catch (e) { /* slot 不可用则仅保留右侧标签页 */ }
    }

    exports.name = NAME;
    exports.inject = ["betterSidebar", "slots", "layout"];
    exports.apply = apply;
    return module.exports;
  },
});
