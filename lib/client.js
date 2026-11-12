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
    const VERSION = "1.0.0";
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
    const DEFAULT_REMINDERS = [
      { id: "r-sit", type: "sit", emoji: "🧘", name: "久坐提醒", enabled: true, intervalMin: 45, start: "09:00", end: "18:00", msg: "久坐 45 分钟啦，起身活动一下、伸个懒腰吧～" },
      { id: "r-drink", type: "drink", emoji: "💧", name: "喝水提醒", enabled: true, intervalMin: 90, start: "08:00", end: "20:00", msg: "该喝水啦，小口慢饮，别等口渴才喝～" },
      { id: "r-eye", type: "fun", emoji: "🐟", name: "摸鱼/护眼", enabled: true, intervalMin: 60, start: "09:30", end: "18:00", msg: "摸鱼时间到～看看远处放松眼睛，别一直盯屏幕" },
      { id: "r-music", type: "music", emoji: "🎵", name: "听音乐提醒", enabled: true, intervalMin: 90, start: "10:00", end: "18:00", msg: "放首歌听吧，调节心情，效率更高～" }
    ];
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
    // 0.8.1：有背景轮播时，日历格子底色不能是纯色（会盖住壁纸），统一转成半透明 rgba；没开背景仍用原色
    function fadeHex(hex, alpha) {
      try {
        let h = String(hex || "").trim().replace("#", "");
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (h.length !== 6) return hex;
        const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        if ([r, g, b].some((v) => isNaN(v))) return hex;
        return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
      } catch (e) { return hex; }
    }
    function contrastText(hex) { try { const h = String(hex || "").replace("#", ""); if (h.length < 6) return "inherit"; const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16); const y = 0.299 * r + 0.587 * g + 0.114 * b; return y > 155 ? "#1f2430" : "#ffffff"; } catch (e) { return "inherit"; } }
    // 0.9.0：文字颜色可设置 —— 壁纸深浅不定时黑字会看不清，允许整套 --txt/--sub 手动覆盖
    // auto 交给 CSS（浅色主题深字 / 深色主题浅字）；dark=强制深字（壁纸偏浅时用）；light=强制浅字（壁纸偏深时用）；custom=取色
    function textVars(tone, color) {
      try {
        if (tone === "dark") return { "--txt": "#141a26", "--sub": "#3d4a60" };
        if (tone === "light") return { "--txt": "#f8faff", "--sub": "#dbe4f7" };
        if (tone === "custom") {
          const c = String(color || "").trim();
          if (!/^#[0-9a-fA-F]{6}$/.test(c)) return null;
          const rgb = fadeHex(c, 0.72);
          return { "--txt": c, "--sub": rgb === c ? c : rgb };
        }
      } catch (e) { return null; }
      return null;
    }

    /* ============================ 数据 ============================ */
    function normalize(s) {
      s = s || {};
      s.version = s.version || 1;
      s.settings = Object.assign({ activePersonId: "p1", activeCityId: null, reminderSound: true, workReminder: true, weekStart: 1 }, s.settings || {});
      s.settings.colors = Object.assign({ weekend: CAL_COLORS.weekend, rest: CAL_COLORS.rest, holiday: CAL_COLORS.holiday, makeup: CAL_COLORS.makeup }, s.settings.colors || {});
      s.settings.buff = Object.assign({ date: "", text: "", streak: 0 }, s.settings.buff || {});
      s.settings.showAlmanac = s.settings.showAlmanac !== false;
      if (!Array.isArray(s.settings.reminders) || !s.settings.reminders.length) s.settings.reminders = JSON.parse(JSON.stringify(DEFAULT_REMINDERS));
      s.settings.drink = Object.assign({ weightKg: 60, totalMl: 2100, cups: 9, cupMl: 233, start: "08:00", end: "20:00" }, s.settings.drink || {});
      s.settings.diy = Object.assign({ enabled: false, dir: "", intervalSec: 30, veil: 0.18, order: "seq" }, s.settings.diy || {});
      /* 0.9.0：文字颜色可设置（壁纸深浅不定时黑字看不清，可换浅色字或自定义色） */
      s.settings.textTone = (s.settings.textTone === "dark" || s.settings.textTone === "light" || s.settings.textTone === "custom") ? s.settings.textTone : "auto";
      s.settings.textColor = /^#[0-9a-fA-F]{6}$/.test(String(s.settings.textColor || "")) ? String(s.settings.textColor) : "";
      /* 0.9.1：胶囊停留秒数可设置（下限 3 秒；<3 视为系统 toast 的默认时长） */
      s.settings.reminderSeconds = Math.min(60, Math.max(3, Number(s.settings.reminderSeconds) || 6));
      s.settings.capsX = Number.isFinite(Number(s.settings.capsX)) ? Math.min(100, Math.max(0, Math.round(Number(s.settings.capsX)))) : 92;
      s.settings.capsY = Number.isFinite(Number(s.settings.capsY)) ? Math.min(100, Math.max(0, Math.round(Number(s.settings.capsY)))) : 92;
      s.settings.update = Object.assign({ autoCheck: false, lastCheck: 0, lastLatest: "" }, s.settings.update || {});
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
      const storeRef = useRef(null);
      const load = useCallback(async () => {
        /* 20s 自动重载：本地还有未落盘的改动时，绝不能用服务器旧数据覆盖本地（实测会丢刚加的城市） */
        if (dirty.current) return;
        setStatus("loading");
        try {
          const j = await getJson(apiUrl("/data"));
          const data0 = normalize((j && j.data) || {});
          storeRef.current = data0;
          dirty.current = false;
          setStore(data0);
          setStatus("ready");
          setErr("");
          /* 一次性补全老数据缺失的「市」：无 city 的城市用 /resolve 反查所属市 */
          (async () => {
            try {
              const list = data0.weatherCities || [];
              /* 也修「市」被写成区名的情况（city 与 district 相同），统一补成真实地级市 */
              if (!list.some((c) => !c.city || c.city === c.name || c.city === c.district)) return;
              const fixed = list.map((c) => ({ ...c }));
              let changed = false;
              for (const c of fixed) {
                if (c.city && c.city !== c.name && c.city !== c.district) continue;
                const prov = c.province || (c.fullName && c.fullName.indexOf("·") > 0 ? c.fullName.split("·")[0] : "");
                if (!prov) continue;
                try {
                  const r = await getJson(apiUrl("/resolve", "name=" + encodeURIComponent(c.district || c.name) + "&province=" + encodeURIComponent(prov)));
                  if (r && r.ok && r.city && r.city !== c.city) {
                    c.province = r.province || c.province;
                    c.city = r.city;
                    c.district = r.district || c.district;
                    if (isFinite(r.latitude)) { c.latitude = r.latitude; c.longitude = r.longitude; }
                    c.fullName = cityNameOf(c);
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
          timer.current = null;
          postJson(apiUrl("/data"), store)
            .then(() => { storeRef.current = store; dirty.current = false; })
            .catch((e) => setErr(String((e && e.message) || e)));
        }, 450);
        return () => { if (timer.current) clearTimeout(timer.current); };
      }, [store]);
      /* 面板卸载/切页时，把还在节流窗口里的改动立刻落盘（以前直接 clearTimeout 就等于丢掉这次修改） */
      useEffect(() => () => {
        if (!timer.current) return;
        clearTimeout(timer.current);
        timer.current = null;
        const snap = storeRef.current;
        if (snap && dirty.current) { try { postJson(apiUrl("/data"), snap).catch(() => {}); } catch (e) { /* ignore */ } }
      }, []);
      const update = useCallback((fn) => { dirty.current = true; setStore((prev) => fn(prev)); }, []);
      storeRef.current = store;
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
    const FREE_HOLIDAYS = { "春节": 1, "清明节": 1, "劳动节": 1, "国庆节": 1, "国庆": 1 };

    function buildHolidayRanges(map) {
      const dates = Object.keys(map || {}).filter((k) => map[k] && map[k].holiday === true).sort();
      const ranges = [];
      let cur = null;
      for (const k of dates) {
        const nm = (map[k] && map[k].name) || "假期";
        if (cur && dateKey(addDays(parseKey(cur.end), 1)) === k) { cur.end = k; }
        else { cur = { start: k, end: k, name: nm, free: !!FREE_HOLIDAYS[nm] }; ranges.push(cur); }
      }
      return ranges;
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
.dsc-root{--bg:var(--dsc-bg,#eef2fb);--card:#ffffff;--line:#e3e8f2;--txt:#1b2233;--sub:#2b3547;--accent:#4f7cff;--accent2:#e9f0ff;--red:#e5484d;--green:#22a06b;--warn:#e8901a;font-size:13px;color:var(--txt);display:flex;flex-direction:column;height:100%;min-height:0;background:linear-gradient(180deg,rgba(79,124,255,.06),rgba(255,255,255,0) 120px),var(--bg);border-radius:12px;overflow:hidden}
@media (prefers-color-scheme:dark){.dsc-root{--bg:#161a22;--card:#20242e;--line:#2f3644;--txt:#e8ebf2;--sub:#98a1b3;--accent:#5b86ff;--accent2:#243050;--red:#ff6b6f;--green:#3fbf82;--warn:#f0a83a}}
 body[data-ds-dark-theme] .dsc-root{--bg:#161a22;--card:#20242e;--line:#2f3644;--txt:#e8ebf2;--sub:#98a1b3;--accent:#5b86ff;--accent2:#243050;--red:#ff6b6f;--green:#3fbf82;--warn:#f0a83a;background:linear-gradient(180deg,rgba(91,134,255,.08),rgba(0,0,0,0) 120px),var(--bg)}
.dsc-root *{box-sizing:border-box}
.dsc-launch{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsc-line,#e7e9ef);background:transparent;color:inherit;cursor:pointer;font-size:13px;line-height:1;vertical-align:middle}
.dsc-launch svg{display:block;flex:0 0 auto}
.dsc-launch span{display:inline-flex;align-items:center;line-height:1;white-space:nowrap}
.dsc-launch:hover{background:rgba(127,127,127,.12)}
.dsc-head{padding:9px 12px 7px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;flex-wrap:nowrap;background:linear-gradient(180deg,rgba(79,124,255,.07),transparent)}
.dsc-hdate{font-size:15.5px;font-weight:700;letter-spacing:.3px;flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsc-hsub{font-size:12px;color:var(--sub)}
.dsc-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:var(--accent2);color:var(--accent);font-weight:600;font-size:12px;flex:0 0 auto;white-space:nowrap;font-variant-numeric:tabular-nums}
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
.dsc-sec-h{display:flex;align-items:center;gap:8px;margin:2px 0 5px;font-weight:700;font-size:12px;color:var(--sub);text-transform:none;letter-spacing:.3px}
.dsc-sec-h .sp{margin-left:auto;display:flex;gap:6px}
.dsc-card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px}
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
.dsc-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsc-settings{display:flex;flex-direction:column;gap:6px}
.dsc-settings .dsc-sec-h{margin:0 0 1px}
.dsc-settings .dsc-card{padding:7px}
.dsc-settings .dsc-row{gap:5px}
.dsc-settings .dsc-input{height:28px}
.dsc-settings .dsc-muted{line-height:1.45}
.dsc-subtabs{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:2px}
.dsc-subtab{border:1px solid var(--line);background:rgba(255,255,255,.55);color:var(--txt);border-radius:999px;padding:3px 10px;font-size:12px;line-height:1.5;cursor:pointer}
.dsc-subtab:hover{background:rgba(37,99,235,.08)}
.dsc-subtab.on{background:rgba(37,99,235,.12);border-color:rgba(37,99,235,.45);color:#2563eb;font-weight:700}
.dsc-settings .sg{display:flex;flex-direction:column;gap:6px}
.dsc-settings[data-cur="work"] .sg:not([data-g="work"]),.dsc-settings[data-cur="city"] .sg:not([data-g="city"]),.dsc-settings[data-cur="remind"] .sg:not([data-g="remind"]),.dsc-settings[data-cur="look"] .sg:not([data-g="look"]),.dsc-settings[data-cur="data"] .sg:not([data-g="data"]),.dsc-settings[data-cur="about"] .sg:not([data-g="about"]){display:none!important}
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
.dsc-cal-wrap{display:flex;flex-direction:column;gap:12px;align-items:stretch}
/* 0.6.3 日历页：上下分栏、一屏放满、不出现滚动条 */
.dsc-cal-wd{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin-bottom:5px}
.dsc-cal-wd .dsc-wd{font-size:11.5px;color:var(--sub);text-align:center;padding:0}
.dsc-cal-fit{height:100%;min-height:0;display:flex;flex-direction:column}
.dsc-body.dsc-fit{overflow:hidden;display:flex;flex-direction:column;padding-bottom:10px}
.dsc-body.dsc-fit > .dsc-cal-fit{flex:1;min-height:0}
.dsc-fit .dsc-cal-wrap{flex:1;min-height:0;gap:8px}
.dsc-fit .dsc-cal-left{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.dsc-fit .dsc-cal-grid{flex:1;min-height:0;grid-auto-rows:minmax(0,1fr);gap:4px}
.dsc-fit .dsc-cell{min-height:0;padding:3px 5px;overflow:hidden}
.dsc-fit .dsc-cell .dsc-dnum{font-size:13px;line-height:1.2}
.dsc-fit .dsc-cell .dsc-lunar{font-size:10.5px;line-height:1.15}
.dsc-fit .dsc-cal-right{flex:0 0 auto;max-height:44%;display:flex;min-height:0;width:100%}
.dsc-fit .dsc-cal-right > .dsc-card{flex:1;min-height:0;overflow:auto}
/* 0.6.3 覆盖层：添加日程 / 联系人选人，盖在当前页之上，不跳转、不占布局 */
.dsc-overlay{position:absolute;inset:0;z-index:60;display:flex;padding:12px;overflow:auto;background:rgba(10,14,22,.40);backdrop-filter:blur(14px) saturate(1.08)}
.dsc-overlay > *{width:100%;max-width:560px;margin:auto;box-shadow:0 18px 50px rgba(8,12,20,.28)}
.dsc-mail-ov{position:absolute;inset:0;z-index:70;display:flex;padding:10px;overflow:auto;background:rgba(10,14,22,.40);backdrop-filter:blur(14px) saturate(1.08)}
.dsc-mail-ov > *{width:100%;max-width:100%;margin:auto;max-height:100%;overflow:hidden;box-shadow:0 18px 50px rgba(8,12,20,.28)}
/* 0.8.3 叠加阅读：背景强磨砂（上面两条 blur 14px）+ 浮层卡片自身改近不透明，
   否则 in 有壁纸时卡片是 .55 半透明、背后列表文字会透过卡片跟正文叠在一起。 */
.dsc-overlay > .dsc-card,.dsc-mail-ov > .dsc-card,.dsc-contacts-ov > .dsc-card{background:rgba(255,255,255,.96)!important;backdrop-filter:none!important}
body[data-ds-dark-theme] .dsc-overlay > .dsc-card,body[data-ds-dark-theme] .dsc-mail-ov > .dsc-card,body[data-ds-dark-theme] .dsc-contacts-ov > .dsc-card{background:rgba(18,22,30,.96)!important}
/* 用户显式关掉磨砂（no-frost）时，浮层背景也不糊，只留压暗 */
.dsc-root.has-bg.no-frost .dsc-overlay,.dsc-root.has-bg.no-frost .dsc-mail-ov{backdrop-filter:none}
.dsc-mail-ov-card{display:flex;flex-direction:column;max-height:100%;overflow:hidden}
.dsc-mail-ovhead{display:flex;align-items:flex-start;gap:8px;padding-bottom:6px}
.dsc-mail-ovsub{flex:1;min-width:0;font-weight:700;font-size:13px;line-height:1.45;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dsc-mail-ovbtns{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:0 0 6px;margin-bottom:6px;border-bottom:1px dashed var(--line)}
.dsc-mail-link{color:#2563eb;text-decoration:underline;text-underline-offset:2px;cursor:pointer;word-break:break-all}
.dsc-mail-link:hover{color:#1d4ed8}
.dsc-mail-ops{display:flex;align-items:center;gap:1px;flex:0 0 auto;opacity:.45;transition:opacity .12s}
.dsc-item:hover .dsc-mail-ops{opacity:1}
.dsc-mail-ops > span{padding:0 3px;font-size:12.5px;line-height:1.4;user-select:none}
.dsc-contact-row{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:8px;cursor:pointer}
.dsc-contact-row:hover{background:rgba(79,124,255,.10)}
.dsc-cal-left{width:100%}
.dsc-cal-right{width:100%}
.dsc-cal-h{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.dsc-cal-title{font-weight:700;font-size:14px}
.dsc-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
.dsc-wd{text-align:center;color:var(--sub);font-size:12px;font-weight:600;padding:3px 0}
.dsc-cell{position:relative;border:1px solid transparent;border-radius:10px;min-height:74px;padding:5px 6px;cursor:pointer;background:transparent;display:flex;flex-direction:column;align-items:flex-start;gap:1px}
.dsc-cell:hover{background:rgba(127,127,127,.08)}
.dsc-cell.out{opacity:.32}
.dsc-cell.weekend{background:rgba(245,166,35,.13)}
.dsc-cell.rest{background:rgba(34,160,107,.14)}
.dsc-cell.holiday{background:rgba(229,72,77,.15)}
.dsc-cell.makeup{background:rgba(79,124,255,.11)}
.dsc-cell.weekend .dsc-dnum,.dsc-cell.rest .dsc-dnum{color:var(--green)}
.dsc-cell.holiday .dsc-dnum{color:var(--red)}
.dsc-cell.sel{background:var(--accent2);border-color:var(--accent)}
.dsc-cell.today .dsc-dnum{background:var(--accent);color:#fff;border-radius:6px}
.dsc-dnum{font-size:15px;font-weight:700;line-height:20px;min-width:20px;text-align:left}
.dsc-lunar{font-size:11px;color:var(--sub);line-height:1.25;white-space:nowrap;overflow:hidden;max-width:100%}
.dsc-lunar.fest{color:var(--red);font-weight:600}
.dsc-lunar.term{color:var(--accent)}
.dsc-flag{position:absolute;top:3px;right:3px;font-size:10px;font-weight:700;line-height:1;padding:2px 5px;border-radius:6px;z-index:2}
.dsc-flag.off{background:rgba(34,160,107,.20);color:var(--green)}
.dsc-flag.on{background:rgba(79,124,255,.18);color:var(--accent)}
.dsc-holsum{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 6px;font-size:11.5px;color:var(--sub)}
.dsc-holsum-item{background:rgba(229,72,77,.10);border-radius:6px;padding:2px 6px}
.dsc-holsum-item.free{background:rgba(34,160,107,.14);color:var(--green)}
.dsc-hol-free{position:absolute;right:26px;top:3px;font-size:9.5px;font-weight:700;line-height:1;padding:2px 4px;border-radius:5px;background:rgba(34,160,107,.22);color:var(--green);z-index:2}
.dsc-bglayer{position:absolute;inset:0;background-size:cover;background-position:center;background-repeat:no-repeat;transition:opacity .9s ease;pointer-events:none}
.dsc-bgscrim{position:absolute;inset:0;pointer-events:none;z-index:3}
.dsc-root.has-bg .dsc-dnum,.dsc-root.has-bg .dsc-lunar,.dsc-root.has-bg .dsc-muted,.dsc-root.has-bg .dsc-dayt,.dsc-root.has-bg .dsc-cal-title,.dsc-root.has-bg .dsc-wd,.dsc-root.has-bg .dsc-holsum,.dsc-root.has-bg .dsc-tab,.dsc-root.has-bg .dsc-hdate,.dsc-root.has-bg .dsc-title{text-shadow:0 1px 2px rgba(255,255,255,.6)}
body[data-ds-dark-theme] .dsc-root.has-bg .dsc-dnum,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-lunar,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-muted,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-dayt,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-cal-title,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-wd,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-holsum,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-tab,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-hdate,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-title{text-shadow:0 1px 2px rgba(0,0,0,.85),0 0 6px rgba(0,0,0,.6)}
.dsc-holiday-tag{position:absolute;left:3px;bottom:3px;font-size:9.5px;font-weight:700;line-height:1;padding:2px 4px;border-radius:5px;background:rgba(229,72,77,.20);color:var(--red);z-index:2}
.dsc-root{position:relative}
.dsc-bg{position:absolute;inset:0;z-index:0;background-size:cover;background-position:center;background-repeat:no-repeat;transition:background-image .5s ease}
.dsc-bg::after{content:"";position:absolute;inset:0;background:var(--bg);opacity:var(--dsc-bg-veil,.72)}
.dsc-head,.dsc-buffbar,.dsc-alert,.dsc-nav,.dsc-body{position:relative;z-index:4}
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
/* 0.7.1：已读 / 未读背景必须一眼可分（未读浅蓝 + 蓝边框，已读近白） */
.dsc-item.dsc-read{background:rgba(255,255,255,.55)}
.dsc-item.dsc-read:hover{background:rgba(255,255,255,.78)}
.dsc-item.dsc-unread{background:rgba(37,99,235,.10);border-color:rgba(37,99,235,.30)}
.dsc-item.dsc-unread:hover{background:rgba(37,99,235,.16)}
.dsc-desk{position:relative;width:100%;border:1px dashed var(--line);border-radius:12px;background:rgba(127,127,127,.03)}
.dsc-desk-icon{position:absolute;box-sizing:border-box;width:76px;height:96px;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 4px;border:1px solid transparent;border-radius:12px;cursor:grab;user-select:none;-webkit-user-select:none;text-align:center;transition:background .15s,border-color .15s}
.dsc-desk-icon:hover{border-color:var(--line);background:rgba(127,127,127,.08)}
.dsc-desk-icon:active{cursor:grabbing}
.dsc-desk-icon.star{border-color:rgba(245,166,35,.5);background:rgba(245,166,35,.06)}
.dsc-desk-icon.dim{opacity:.5}
.dsc-desk-ico{font-size:30px;line-height:1}
.dsc-desk-t{font-size:11.5px;font-weight:600;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsc-desk-n{font-size:10px;color:var(--sub);max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsc-ev-del{position:absolute;top:1px;right:2px;border:none;background:transparent;color:var(--sub);cursor:pointer;font-size:13px;line-height:1;padding:2px;opacity:0}
.dsc-ev-del:hover{color:var(--red);opacity:.9}
.dsc-desk-icon:hover .dsc-ev-del{opacity:.7}
.dsc-ev-lock{position:absolute;top:1px;left:2px;border:none;background:transparent;cursor:pointer;font-size:11px;line-height:1;padding:2px;opacity:0}
.dsc-desk-icon:hover .dsc-ev-lock{opacity:.7}
.dsc-desk-icon.locked .dsc-ev-lock{opacity:.95}
.dsc-desk-icon.locked{border-color:rgba(245,166,35,.5)}
.dsc-desk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:10px;padding:10px;border:1px dashed var(--line);border-radius:12px;background:rgba(127,127,127,.03)}
.dsc-desk-cell{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px 6px 10px;border:1px solid transparent;border-radius:12px;cursor:grab;user-select:none;-webkit-user-select:none;text-align:center;min-height:92px;transition:background .15s,border-color .15s}
.dsc-desk-cell:hover{border-color:var(--line);background:rgba(127,127,127,.08)}
.dsc-desk-cell.star{border-color:rgba(245,166,35,.5);background:rgba(245,166,35,.06)}
.dsc-desk-cell.dim{opacity:.5}
.dsc-desk-cell.locked{border-color:rgba(245,166,35,.5)}
.dsc-desk-cell.dragover{border-color:var(--accent);background:rgba(79,124,255,.12)}
.dsc-desk-cell .dsc-ev-lock{position:absolute;top:1px;left:2px;border:none;background:transparent;cursor:pointer;font-size:11px;line-height:1;padding:2px;opacity:0}
.dsc-desk-cell:hover .dsc-ev-lock{opacity:.7}
.dsc-desk-cell.locked .dsc-ev-lock{opacity:.95}
.dsc-desk-cell .dsc-ev-del{position:absolute;top:1px;right:2px;border:none;background:transparent;color:var(--sub);cursor:pointer;font-size:13px;line-height:1;padding:2px;opacity:0}
.dsc-desk-cell:hover .dsc-ev-del{opacity:.7}
.dsc-ctxmenu{position:fixed;z-index:9999;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.32);padding:6px;display:flex;flex-direction:column;gap:2px;min-width:150px}
.dsc-ctxmenu-t{font-size:11px;color:var(--sub);padding:4px 10px 6px;font-weight:600;letter-spacing:.3px}
.dsc-ctxmenu button{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;cursor:pointer;font-size:13px;padding:8px 10px;border-radius:8px;color:var(--txt);text-align:left}
.dsc-ctxmenu button:hover{background:var(--accent2);color:var(--accent)}
.dsc-ctxmenu button.cancel{margin-top:4px;color:var(--sub);border-top:1px solid var(--line);border-radius:0 0 8px 8px;justify-content:center}
.dsc-ctxmenu button.cancel:hover{background:rgba(127,127,127,.12);color:var(--red)}
.dsc-root.has-bg{--card:rgba(255,255,255,.72);--sub:#232c3d}
body[data-ds-dark-theme] .dsc-root.has-bg{--card:rgba(30,34,44,.66)}
.dsc-root.has-bg .dsc-card{backdrop-filter:blur(3px)}
.dsc-root.has-bg .dsc-card,.dsc-root.has-bg .dsc-cal-left{background:rgba(255,255,255,.55)!important;backdrop-filter:blur(4px)}
body[data-ds-dark-theme] .dsc-root.has-bg .dsc-card,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-cal-left{background:rgba(18,22,30,.55)!important;backdrop-filter:blur(4px)}
/* 输入框/下拉/文本域不做毛玻璃：它们数量多、聚焦频繁，每帧都要重算背景模糊（GPU 主要开销来源），
   去掉 blur 后视觉上几乎无差（底下还有半透明底色），但滚动与输入明显跟手。 */
.dsc-root.has-bg .dsc-input,.dsc-root.has-bg .dsc-select,.dsc-root.has-bg .dsc-textarea{background:rgba(255,255,255,.55)!important}
body[data-ds-dark-theme] .dsc-root.has-bg .dsc-input,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-select,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-textarea{background:rgba(18,22,30,.55)!important}
.dsc-root.has-bg .dsc-cell.sel{background:rgba(79,124,255,.18)!important;border-color:rgba(79,124,255,.45)!important}
body[data-ds-dark-theme] .dsc-root.has-bg .dsc-cell.sel{background:rgba(91,134,255,.26)!important;border-color:rgba(91,134,255,.5)!important}
.dsc-root.has-bg .dsc-cell:hover{background:rgba(127,127,127,.10)}
.dsc-root.has-bg .dsc-flag,.dsc-root.has-bg .dsc-holiday-tag,.dsc-root.has-bg .dsc-hol-free{backdrop-filter:blur(2px)}
.dsc-root.has-bg .dsc-buffbar{background:rgba(255,255,255,.45)!important}
body[data-ds-dark-theme] .dsc-root.has-bg .dsc-buffbar{background:rgba(18,22,30,.45)!important}
.dsc-root{--dsc-scrim-rgb:247,249,252}
body[data-ds-dark-theme] .dsc-root{--dsc-scrim-rgb:18,22,30}
.dsc-root.has-bg.no-frost .dsc-card,.dsc-root.has-bg.no-frost .dsc-cal-left,.dsc-root.has-bg.no-frost .dsc-input,.dsc-root.has-bg.no-frost .dsc-select,.dsc-root.has-bg.no-frost .dsc-textarea{backdrop-filter:none!important}
.dsc-root.has-bg.no-frost .dsc-card,.dsc-root.has-bg.no-frost .dsc-cal-left{background:rgba(255,255,255,.22)!important}
body[data-ds-dark-theme] .dsc-root.has-bg.no-frost .dsc-card,body[data-ds-dark-theme] .dsc-root.has-bg.no-frost .dsc-cal-left{background:rgba(14,16,22,.22)!important}
.dsc-time{font-variant-numeric:tabular-nums;font-weight:700;color:var(--accent);min-width:42px;font-size:12px}
.dsc-badge{font-size:10px;padding:1px 6px;border-radius:999px;background:var(--accent2);color:var(--accent);font-weight:600}
.dsc-badge.warn{background:rgba(245,166,35,.16);color:#b8860b}
.dsc-ctx{position:fixed;z-index:9999;background:var(--card);border:1px solid var(--line);border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px;min-width:120px}
.dsc-ctx button{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--txt);padding:7px 10px;border-radius:6px;cursor:pointer;font-size:12.5px}
.dsc-ctx button:hover{background:var(--accent2);color:var(--accent)}
.dsc-alert{position:sticky;top:0;z-index:5;margin:0 12px 6px;padding:8px 12px;border-radius:9px;background:rgba(245,166,35,.16);border:1px solid rgba(245,166,35,.5);color:#8a5a00;font-weight:600;display:flex;gap:8px;align-items:center}
/* 0.9.2 胶囊浮层：挂在 document.body、position:fixed —— 整个 DSH 客户端界面都能看到，与侧边栏是否展开无关 */
.dsc-cap-layer{position:fixed;inset:0;z-index:10500;pointer-events:none}
.dsc-cap-stack{position:absolute;display:flex;flex-direction:column;gap:6px;max-width:min(360px,78vw);pointer-events:none}
.dsc-range{flex:1 1 80px;min-width:70px;height:18px;accent-color:#2563eb}
@keyframes dsc-cap-out{from{opacity:1}to{opacity:0}}
.dsc-cap{pointer-events:auto;display:flex;align-items:flex-start;gap:7px;padding:8px 11px;border-radius:14px;background:rgba(22,28,42,.94);color:#f3f6ff;box-shadow:0 12px 30px rgba(8,12,20,.4);font-size:12px;line-height:1.45;cursor:pointer;animation:dsc-cap-in .2s ease}
.dsc-cap-ico{font-size:13px;line-height:1.35}
.dsc-cap-txt{min-width:0}
.dsc-cap-t{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsc-cap-b{color:#c9d4ea;margin-top:1px;word-break:break-word}
@keyframes dsc-cap-in{from{opacity:0;transform:translateY(-6px) scale(.98)}to{opacity:1;transform:none}}
body[data-ds-dark-theme] .dsc-cap{background:rgba(44,54,74,.96)}
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

/* ── 0.8.4 叠加层可读性（关键：特异性必须压过 .dsc-root.has-bg .dsc-card 的 .55 半透明）──
   背景糊的是「被遮住的那一层界面」，不是壁纸本身；浮层卡片必须近乎不透明，
   否则下层列表/日历的字会透上来跟浮层正文叠印。规则放 CSS 最末尾，平手时靠顺序取胜。 */
.dsc-root.has-bg .dsc-overlay > .dsc-card,.dsc-root.has-bg .dsc-mail-ov > .dsc-card,.dsc-root.has-bg .dsc-contacts-ov > .dsc-card,
.dsc-root.has-bg.no-frost .dsc-overlay > .dsc-card,.dsc-root.has-bg.no-frost .dsc-mail-ov > .dsc-card,.dsc-root.has-bg.no-frost .dsc-contacts-ov > .dsc-card{background:rgba(255,255,255,.97)!important;backdrop-filter:none!important}
body[data-ds-dark-theme] .dsc-root.has-bg .dsc-overlay > .dsc-card,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-mail-ov > .dsc-card,body[data-ds-dark-theme] .dsc-root.has-bg .dsc-contacts-ov > .dsc-card,
body[data-ds-dark-theme] .dsc-root.has-bg.no-frost .dsc-overlay > .dsc-card,body[data-ds-dark-theme] .dsc-root.has-bg.no-frost .dsc-mail-ov > .dsc-card,body[data-ds-dark-theme] .dsc-root.has-bg.no-frost .dsc-contacts-ov > .dsc-card{background:rgba(18,22,30,.97)!important}
`;

    /* ===== 0.9.2 胶囊浮层（全 DSH 界面可见；位置由设置里的两个百分比滑块决定） ===== */
let CAP_LAYER = null;
let CAP_ITEMS = [];
const CAP_TIMERS = {};
let CAP_SETTINGS = { capsX: 92, capsY: 92, reminderSeconds: 6 };
const capPct = (v, dft) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : dft; };
function ensureCapLayer() {
  if (typeof document === "undefined" || !document.body) return null;
  if (CAP_LAYER && document.body.contains(CAP_LAYER)) return CAP_LAYER;
  const el = document.createElement("div");
  el.className = "dsc-cap-layer";
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el);
  CAP_LAYER = el;
  return el;
}
function renderCaps(settings) {
  const layer = ensureCapLayer();
  if (!layer) return;
  const st = settings || CAP_SETTINGS || {};
  const x = capPct(st.capsX, 92);
  const y = capPct(st.capsY, 92);
  let stack = layer.querySelector(".dsc-cap-stack");
  if (!stack) { stack = document.createElement("div"); stack.className = "dsc-cap-stack"; layer.appendChild(stack); }
  stack.style.left = x + "%";
  stack.style.top = y + "%";
  stack.style.transform = "translate(-" + x + "%, -" + y + "%)";
  while (stack.firstChild) stack.removeChild(stack.firstChild);
  CAP_ITEMS.forEach((it) => {
    const cap = document.createElement("div");
    cap.className = "dsc-cap";
    cap.title = "点一下关闭";
    const ico = document.createElement("span");
    ico.className = "dsc-cap-ico";
    ico.textContent = "\u23f0";
    const txt = document.createElement("div");
    txt.className = "dsc-cap-txt";
    const t = document.createElement("div");
    t.className = "dsc-cap-t";
    t.textContent = it.title;
    txt.appendChild(t);
    if (it.body) {
      const b = document.createElement("div");
      b.className = "dsc-cap-b";
      b.textContent = it.body;
      txt.appendChild(b);
    }
    cap.appendChild(ico);
    cap.appendChild(txt);
    cap.addEventListener("click", () => capDrop(it.id, st));
    stack.appendChild(cap);
  });
}
function capDrop(id, settings) {
  CAP_ITEMS = CAP_ITEMS.filter(function (x) { return x.id !== id; });
  if (CAP_TIMERS[id]) { clearTimeout(CAP_TIMERS[id]); delete CAP_TIMERS[id]; }
  renderCaps(settings || CAP_SETTINGS);
}
function pushCaps(item, settings) {
  if (!item) return;
  const st = settings || CAP_SETTINGS || {};
  const id = String(item.id || "cap") + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const sec = Math.min(60, Math.max(3, Number(st.reminderSeconds) || 6));
  CAP_ITEMS = CAP_ITEMS.concat([{ id: id, title: String(item.name || item.title || "\u63d0\u9192"), body: String(item.msg || item.body || "") }]).slice(-5);
  renderCaps(st);
  CAP_TIMERS[id] = setTimeout(function () {
    CAP_ITEMS = CAP_ITEMS.filter(function (x) { return x.id !== id; });
    delete CAP_TIMERS[id];
    renderCaps(st);
  }, sec * 1000);
}

function ensureStyles() {
      // 0.6.4：不再「存在就跳过」——旧版守卫会让改过的 CSS 永远进不来，
      // 表现为 JS 已是新版（新结构）、样式还是旧版（新类名无规则，日历星期标题竖排堆叠）。
      // 现在按 CSS 文本比对：内容变了就替换旧 style。
      const id = "dsh-schedule-calendar-style";
      const prev = document.getElementById(id);
      if (prev && prev.textContent === CSS) return;
      if (prev) prev.remove();
      const st = document.createElement("style");
      st.id = id;
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
    // 0.8.0：天气自动刷新只认 08:30 / 12:00 / 17:30 三个时刻（其余时间静态，手动刷新随时可用），避免界面反复跳动
    const WX_SLOTS = [[8, 30], [12, 0], [17, 30]];
    function lastWxSlotMs(nowMs) {
      const now = new Date(nowMs);
      let best = 0;
      for (let back = 0; back <= 1; back++) {
        for (const pair of WX_SLOTS) {
          const d = new Date(now);
          d.setDate(d.getDate() - back);
          d.setHours(pair[0], pair[1], 0, 0);
          if (d.getTime() <= nowMs) best = Math.max(best, d.getTime());
        }
      }
      return best;
    }
    const WX_CACHE = { key: "", day: "", at: 0, data: null };
    function dayKeyOf(ms) { const d = new Date(ms); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }

    function WeatherTable(props) {
      const { cities, store, update, refreshKey, onLoaded } = props;
      const [wm, setWm] = useState({});
      const [err, setErr] = useState("");
      // 到点提醒：算出下一个 08:30 / 12:00 / 17:30 的毫秒数，到点就 +1 触发一次取数
      const [tick, setTick] = useState(0);
      const prevForce = useRef({ k: refreshKey, t: 0 });
      useEffect(() => {
        let timer = null;
        const nextWxSlot = () => {
          const now = Date.now();
          const d = new Date(now);
          const later = WX_SLOTS.map((pair) => {
            const x = new Date(d);
            x.setHours(pair[0], pair[1], 0, 0);
            if (x.getTime() <= now) x.setDate(x.getDate() + 1);
            return x.getTime();
          });
          return Math.min.apply(null, later);
        };
        const arm = () => {
          const wait = Math.max(1000, nextWxSlot() - Date.now());
          timer = setTimeout(() => { setTick((v) => v + 1); arm(); }, wait);
        };
        arm();
        return () => { if (timer) clearTimeout(timer); };
      }, []);
      useEffect(() => {
        let alive = true;
        const citiesKey = JSON.stringify(cities.map((c) => [c.id, c.latitude, c.longitude]));
        const forced = prevForce.current.k !== refreshKey || prevForce.current.t !== tick;
        prevForce.current = { k: refreshKey, t: tick };
        const nowMs = Date.now();
        const dayKey = dayKeyOf(nowMs);
        const cachedOk = !!WX_CACHE.data && WX_CACHE.key === citiesKey && WX_CACHE.day === dayKey && WX_CACHE.at >= lastWxSlotMs(nowMs);
        if (!forced && cachedOk) {
          setWm(WX_CACHE.data);
          if (onLoaded) onLoaded(WX_CACHE.at);
          return () => { alive = false; };
        }
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
          if (alive) {
            setWm(next);
            WX_CACHE.key = citiesKey;
            WX_CACHE.day = dayKey;
            WX_CACHE.at = Date.now();
            WX_CACHE.data = next;
            if (onLoaded) onLoaded(WX_CACHE.at);
          }
        })();
        return () => { alive = false; };
      }, [JSON.stringify(cities.map((c) => [c.id, c.latitude, c.longitude])), refreshKey, tick]);

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
            h("td", { className: "city" }, h("div", null, cityTitle(c)), h("div", { className: "dsc-muted", style: { fontSize: 10.5, fontWeight: 400 } }, Number.isFinite(c.latitude) ? c.latitude.toFixed(2) + "," + c.longitude.toFixed(2) : "")),
            days.map((d) => {
              let cell;
              if (!w) cell = h("span", { className: "dsc-muted" }, "…");
              else if (!w.ok) cell = h("span", { className: "dsc-muted", style: { fontSize: 11.5 } }, "—");
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
      const [horoOpen, setHoroOpen] = useState(false); // 星座配对默认折叠，避免运势卡太长
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
          h("div", { className: "dsc-card dsc-horo" },
            // 0.6.2 紧凑版：一行概览 + 2×2 短句网格 + 最配一行；12 条配对默认折叠
            h("div", { className: "dsc-row", style: { gap: 6, alignItems: "center" } },
              h("span", { style: { fontSize: 17, lineHeight: 1 } }, signObj.emoji),
              h("span", { style: { fontWeight: 700, fontSize: 12 } }, signObj.cn),
              hz ? h("span", { className: "dsc-muted", style: { fontSize: 11.5 } }, hz.date || "") : null,
              h("span", { className: "dsc-muted", style: { marginLeft: "auto", fontSize: 11.5 } }, hz ? ("幸运 " + (hz.luckyColor || "—") + " · " + (hz.luckyNumber || "—")) : "加载中…")),
            hz ? h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 8px", marginTop: 6 } },
              [["综合", hz.all], ["恋爱", hz.love], ["事业", hz.work], ["财运", hz.money]].map(([k, v]) => h("div", { key: k, title: k + "：" + (v || ""), style: { fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
                h("span", { style: { color: "var(--sub)", marginRight: 4 } }, k), String(v || "—"))))
              : h("div", { className: "dsc-muted", style: { fontSize: 11.5, marginTop: 4 } }, "运势加载中…"),
            hz ? h("div", { className: "dsc-row", style: { marginTop: 6, gap: 5, alignItems: "center" } },
              h("span", { style: { fontSize: 11.5, color: "var(--sub)" } }, "最配"),
              (hz.best || []).slice(0, 3).map((c) => h("span", { key: c.id, style: { fontSize: 11.5, padding: "1px 5px", borderRadius: 6, background: "rgba(255,255,255,.6)", border: "1px solid var(--line)" } }, c.emoji + c.cn.replace("座", ""))),
              h("span", { onClick: () => setHoroOpen(!horoOpen), title: "展开/收起 12 星座配对", style: { marginLeft: "auto", cursor: "pointer", fontSize: 11.5, color: "var(--sub)" } }, horoOpen ? "收起 ▲" : "全配对 ▼"))
              : null,
            (hz && horoOpen) ? h("div", { style: { marginTop: 4, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 8px" } },
              (hz.compat || []).map((c) => h("div", { key: c.id, title: c.cn + " " + c.score + "分 · " + c.desc, style: { fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, c.emoji + " " + c.cn.replace("座", "") + " " + c.score)))
              : null)) : null);
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
        onDelete ? h(Btn, { kind: "mini ghost", onClick: () => { if (ev.locked) return; onDelete(ev.id); }, title: ev.locked ? "已上锁" : "删除" }, "×") : null);
    }

    const CATEGORIES = [
      { key: "birthday", emoji: "🎂", name: "生日" },
      { key: "anniversary", emoji: "🎁", name: "纪念日" },
      { key: "festival", emoji: "🎉", name: "节日" },
      { key: "memorial", emoji: "🕯", name: "祭奠/忌日" },
      { key: "meeting", emoji: "📅", name: "日程/会议" },
      { key: "reminder", emoji: "⏰", name: "提醒" },
      { key: "star", emoji: "⭐", name: "星标/其他" }
    ];
    const CAT_EMOJI = {};
    for (const cc of CATEGORIES) CAT_EMOJI[cc.key] = cc.emoji;

    function eventIcon(ev) {
      if (ev && ev.icon && CAT_EMOJI[ev.icon]) return CAT_EMOJI[ev.icon];
      const t = String((ev && ev.title) || "");
      if (/生日/.test(t)) return "🎂";
      if (/纪念|结婚|周年/.test(t)) return "🎁";
      if (/忌日|祭|清明|中元/.test(t)) return "🕯";
      if (/节/.test(t)) return "🎉";
      if (repeatOf(ev) === "lunar-yearly") return "🎂";
      if (ev && ev.time) return "⏰";
      if (ev && ev.star) return "⭐";
      return "📅";
    }

    function isBday(ev) {
      const ic = eventIcon(ev);
      return ic === "🎂" || ic === "🎁";
    }

    function DeskIcon(props) {
      const { ev, status, index, onReorder, onDelete, onToggleLock, onContext } = props;
      const [over, setOver] = useState(false);
      return h("div", {
        className: "dsc-desk-cell" + (ev.star ? " star" : "") + (status ? " " + status : "") + (ev.locked ? " locked" : "") + (over ? " dragover" : ""),
        draggable: true,
        title: ev.title + (ev.note ? " · " + ev.note : ""),
        onDragStart: (e) => { try { e.dataTransfer.setData("text/plain", String(index)); e.dataTransfer.effectAllowed = "move"; } catch (err) { /* ignore */ } },
        onDragOver: (e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = "move"; } catch (err) { /* ignore */ } if (!over) setOver(true); },
        onDragLeave: () => setOver(false),
        onDrop: (e) => { e.preventDefault(); setOver(false); let from = NaN; try { from = parseInt(e.dataTransfer.getData("text/plain"), 10); } catch (err) { /* ignore */ } if (!isNaN(from) && from !== index && onReorder) onReorder(from, index); },
        onContextMenu: (e) => { if (onContext) onContext(e, ev); }
      },
        h("button", { className: "dsc-ev-lock", onClick: (e) => { e.stopPropagation(); onToggleLock && onToggleLock(ev.id); }, title: ev.locked ? "已上锁 · 点此解锁" : "点此上锁（上锁后需解锁才能删除）" }, ev.locked ? "🔒" : "🔓"),
        h("button", { className: "dsc-ev-del", onClick: (e) => { e.stopPropagation(); onDelete && onDelete(ev); }, title: ev.locked ? "已上锁" : "删除" }, ev.locked ? "🔒" : "×"),
        h("div", { className: "dsc-desk-ico" }, eventIcon(ev)),
        h("div", { className: "dsc-desk-t" }, ev.title),
        ev.note ? h("div", { className: "dsc-desk-n" }, ev.note) : null);
    }

    function TodoRow(props) {
      const { todo, store, update } = props;
      const toggle = () => update((s) => ({ ...s, todos: s.todos.map((t) => (t.id === todo.id ? { ...t, done: !t.done, doneAt: !t.done ? new Date().toISOString() : null } : t)) }));
      const due = todo.dueDate || "";
      const overdue = due && !todo.done && due < todayKey();
      return h("div", { className: "dsc-todo" + (todo.done ? " done" : "") },
        h("span", { className: "dsc-check" + (todo.done ? " on" : ""), onClick: toggle }, todo.done ? "✓" : ""),
        h("span", { className: "tx", style: { flex: 1 } }, todo.text,
          due ? h("span", { style: { marginLeft: 8, fontSize: 11.5, color: overdue ? "var(--red)" : "var(--sub)", fontWeight: overdue ? 600 : 400 } }, (overdue ? "⚠ 逾期 " : "截止 ") + due) : null,
          todo.done && todo.doneAt ? h("span", { style: { marginLeft: 8, fontSize: 10.5, color: "var(--sub)" } }, "完成于 " + todo.doneAt.slice(5, 16).replace("T", " ")) : null),
        h(Btn, { kind: "mini ghost", onClick: () => update((s) => ({ ...s, todos: s.todos.filter((t) => t.id !== todo.id) })) }, "×"));
    }

    /* ---------- 日历 ---------- */
    function CalendarView(props) {
      const { store, update, now, goAdd, hasBg } = props;
      const [vy, setVy] = useState(now.getFullYear());
      const [vm, setVm] = useState(now.getMonth() + 1); // 1-12
      const [sel, setSel] = useState(todayKey());
      const [menu, setMenu] = useState(null);
      const { days: lunarDays } = useLunar(vy);
      const holidays = useHolidays(vy);
      const holRanges = useMemo(() => buildHolidayRanges(holidays), [holidays]);
      const freeDates = {};
      holRanges.forEach((r) => { if (r.free) { let d = parseKey(r.start); const e = parseKey(r.end); let g = 0; while (d.getTime() <= e.getTime() && g < 400) { freeDates[dateKey(d)] = 1; d = addDays(d, 1); g++; } } });
      const monthRanges = holRanges.filter((r) => { const ss = parseKey(r.start), ee = parseKey(r.end); const ms = new Date(vy, vm - 1, 1).getTime(); const me = new Date(vy, vm, 0).getTime(); return ee.getTime() >= ms && ss.getTime() <= me; });
      const FEST_FREE = { "春节": 1, "清明节": 1, "劳动节": 1, "国庆节": 1 };
      const FEST_NORM = { "春节": "春节", "元宵": "元宵节", "元宵节": "元宵节", "端午": "端午节", "端午节": "端午节", "中秋": "中秋节", "中秋节": "中秋节", "清明": "清明节", "清明节": "清明节" };
      const festDays = {};
      for (let ddd = 1; ddd <= new Date(vy, vm, 0).getDate(); ddd++) {
        const kk = vy + "-" + pad(vm) + "-" + pad(ddd);
        const ll = lunarDays && lunarDays[kk];
        let nm = null;
        if (ll && ll.term === "清明") nm = "清明节";
        else if (ll && ll.fest && FEST_NORM[ll.fest]) nm = FEST_NORM[ll.fest];
        else if (vm === 1 && ddd === 1) nm = "元旦";
        else if (vm === 5 && ddd === 1) nm = "劳动节";
        else if (vm === 10 && ddd === 1) nm = "国庆节";
        if (nm) festDays[kk] = { name: nm, free: !!FEST_FREE[nm] };
      }
      Object.keys(festDays).forEach((kk) => { if (festDays[kk].free) freeDates[kk] = 1; });
      const monthItems = monthRanges.slice();
      Object.keys(festDays).sort().forEach((kk) => {
        let covered = false;
        for (const r of monthRanges) { if (kk >= r.start && kk <= r.end) { covered = true; break; } }
        if (!covered) monthItems.push({ start: kk, end: kk, name: festDays[kk].name, free: !!freeDates[kk] });
      });
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

      return h("div", { className: "dsc-cal-fit" },
        h("div", { className: "dsc-cal-wrap" },
          h("div", { className: "dsc-cal-left dsc-card" },
            h("div", { className: "dsc-cal-h" },
              h(Btn, { kind: "mini ghost", onClick: () => shiftMonth(-1) }, "‹"),
              h("span", { className: "dsc-cal-title" }, vy + " 年 " + vm + " 月"),
              h(Btn, { kind: "mini ghost", onClick: () => shiftMonth(1) }, "›"),
              h("span", { style: { marginLeft: "auto" } }, h(Btn, { kind: "mini", onClick: () => { setVy(now.getFullYear()); setVm(now.getMonth() + 1); setSel(todayKey()); } }, "今天"))),
            h("div", { className: "dsc-holsum" },
              monthItems.length ? monthItems.map((r) => h("span", { key: r.start + r.name, className: "dsc-holsum-item" + (r.free ? " free" : "") }, r.name + " " + mmdd(r.start) + (r.start !== r.end ? "–" + mmdd(r.end) : "") + (r.free ? " · 高速免费" : ""))) : null),
            h("div", { className: "dsc-cal-wd" },
              ["一", "二", "三", "四", "五", "六", "日"].map((w) => h("div", { key: w, className: "dsc-wd" }, w))),
            h("div", { className: "dsc-cal-grid" },
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
                const toneRaw = tone ? (palette[tone] || "") : "";
        const toneBg = toneRaw && hasBg ? fadeHex(toneRaw, 0.45) : toneRaw; // 0.8.1：开背景时半透，不遮盖壁纸
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
                  style: toneBg ? { backgroundColor: toneBg, color: contrastText(toneRaw || toneBg) } : undefined,
                  onClick: () => setSel(k),
                  onDoubleClick: () => { setSel(k); goAdd(k); },
                  onContextMenu: (e) => { e.preventDefault(); setSel(k); setMenu({ x: e.clientX, y: e.clientY, date: k }); },
                  title: hol ? hol.name : (l ? l.monthCn + l.dayCn : "")
                },
                  (function () { let f = ""; if (holOff) f = "休"; else if (holMakeup) f = "班"; else if (isWeekend) f = (worked ? "班" : "休"); else if (!worked) f = "休"; return f ? h("span", { className: "dsc-flag " + (f === "休" ? "off" : "on") }, f) : null; })(),
                  freeDates[k] ? h("span", { className: "dsc-hol-free", title: "高速免费" }, "免") : null,
                  (holOff || holMakeup) ? h("span", { className: "dsc-holiday-tag", title: hol ? hol.name : "" }, holMakeup ? "调休" : "假") : null,
                  h("div", { className: "dsc-dnum" }, dt.getDate()),
                  h("div", { className: lunarCls }, lunarTxt || (hol ? hol.name : "")),
                  h("div", { className: "dsc-dots" }, occ.slice(0, 4).map((ev, j) => h("span", { key: j, className: "dsc-dot" + (ev.star ? " star" : "") }))));
              }))),
          h("div", { className: "dsc-cal-right" },
            h("div", { className: "dsc-card" },
              h("div", { className: "dsc-dayt" }, (selDt.getMonth() + 1) + "月" + selDt.getDate() + "日 " + selWd),
              h("div", { className: "dsc-muted", style: { fontSize: 12, marginBottom: 8 } },
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
      const deskRef = useRef(null);
      const [deskW, setDeskW] = useState(320);
      const [confirmDel, setConfirmDel] = useState(null);
      const [notice, setNotice] = useState("");
      const [catMenu, setCatMenu] = useState(null);
      useEffect(() => {
        const el = deskRef.current;
        if (!el) return undefined;
        const measure = () => { if (deskRef.current) setDeskW(deskRef.current.clientWidth || 320); };
        measure();
        let ro = null;
        if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(measure); ro.observe(el); }
        window.addEventListener("resize", measure);
        return () => { if (ro) ro.disconnect(); window.removeEventListener("resize", measure); };
      }, [store && store.events ? store.events.length : 0]);
      useEffect(() => {
        if (!catMenu) return undefined;
        const close = () => setCatMenu(null);
        document.addEventListener("mousedown", close);
        document.addEventListener("scroll", close, true);
        return () => { document.removeEventListener("mousedown", close); document.removeEventListener("scroll", close, true); };
      }, [catMenu]);
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
      }).sort((a, b) => {
        const ao = typeof a.ev.ord === "number", bo = typeof b.ev.ord === "number";
        if (ao && bo) return a.ev.ord - b.ev.ord;
        if (ao) return -1;
        if (bo) return 1;
        return String(a.sort).localeCompare(String(b.sort));
      });
      const IW = 76, IH = 96, GX = 10, GY = 10, PAD = 6;
      const perRow = Math.max(1, Math.floor((deskW - 2 * PAD + GX) / (IW + GX)));
      const nEv = rows.length;
      const rowsN = Math.max(1, Math.ceil(nEv / perRow));
      const autoPos = (i) => { const r = Math.floor(i / perRow), c = i % perRow; return { x: PAD + c * (IW + GX), y: PAD + (rowsN - 1 - r) * (IH + GY) }; };
      const colOf = (px) => Math.max(0, Math.round((px - PAD) / (IW + GX)));
      const rowOf = (py) => Math.max(0, Math.round((py - PAD) / (IH + GY)));
      const effPos = (r, i) => r.ev.pos || autoPos(i);
      const maxRowUsed = rows.reduce((m, r, i) => Math.max(m, rowOf(effPos(r, i).y)), rowsN - 1);
      const deskH = 2 * PAD + (maxRowUsed + 1) * IH + maxRowUsed * GY;
      const bdays = rows.filter((r) => isBday(r.ev));
      const allBdayLocked = bdays.length > 0 && bdays.every((r) => r.ev.locked);
      return h("div", null,
        h("div", { className: "dsc-sec-h" }, "全部日程", h("span", { className: "sp" },
          h(Btn, { kind: "mini", onClick: () => update((s) => ({ ...s, events: s.events.map((e) => (isBday(e) ? { ...e, locked: !allBdayLocked } : e)) })) }, allBdayLocked ? "🔓 解锁生日" : "🔒 一键上锁"),
          h(Btn, { kind: "mini", onClick: () => update((s) => ({ ...s, events: s.events.map((e) => { const c = { ...e }; delete c.pos; delete c.ord; return c; }) })) }, "自动排列"),
          h(Btn, { kind: "pri mini", onClick: () => goAdd(today) }, "＋ 新建"))),
        notice ? h("div", { className: "dsc-tagline" }, notice) : null,
        confirmDel ? h("div", { className: "dsc-card", style: { borderColor: "var(--red)", marginBottom: 8 } },
          h("div", { style: { fontSize: 12, marginBottom: 8 } }, "确定删除「" + (confirmDel.title || "该日程") + "」？此操作不可撤销。"),
          h("div", { className: "dsc-row", style: { gap: 8 } },
            h(Btn, { kind: "mini pri", onClick: () => { const id = confirmDel.id; setConfirmDel(null); update((s) => ({ ...s, events: s.events.filter((x) => x.id !== id) })); } }, "确定删除"),
            h(Btn, { kind: "mini", onClick: () => setConfirmDel(null) }, "取消"))) : null,
        rows.length
          ? h("div", { className: "dsc-desk-grid" },
              rows.map((r, i) => h(DeskIcon, {
                key: r.ev.id,
                ev: r.ev,
                status: r.status,
                index: i,
                onReorder: (from, to) => { update((s) => { const order = rows.map((x) => x.ev.id); const mv = order.splice(from, 1)[0]; order.splice(to, 0, mv); const om = {}; order.forEach((id, idx) => { om[id] = idx; }); return { ...s, events: s.events.map((e) => ({ ...e, ord: (om[e.id] != null ? om[e.id] : e.ord) })) }; }); },
                onToggleLock: (id) => update((s) => ({ ...s, events: s.events.map((e) => (e.id === id ? { ...e, locked: !e.locked } : e)) })),
                onContext: (e, ev) => { e.preventDefault(); const w = (typeof window !== "undefined" ? window.innerWidth : 1200); const hh = (typeof window !== "undefined" ? window.innerHeight : 800); setCatMenu({ x: Math.max(6, Math.min(e.clientX, w - 170)), y: Math.max(6, Math.min(e.clientY, hh - 330)), id: ev.id }); },
                onDelete: (ev) => { if (ev.locked) { setNotice("「" + (ev.title || "") + "」已上锁，请先点左上角🔒解锁再删除"); return; } setNotice(""); setConfirmDel(ev); }
              })))
          : h("div", { className: "dsc-card dsc-empty" }, "还没有日程"),
        catMenu ? h("div", { className: "dsc-ctxmenu", style: { left: catMenu.x + "px", top: catMenu.y + "px" }, onMouseDown: (e) => e.stopPropagation() },
          h("div", { className: "dsc-ctxmenu-t" }, "切换分类图标"),
          CATEGORIES.map((c) => h("button", { key: c.key, onClick: () => { const id = catMenu.id; setCatMenu(null); update((s) => ({ ...s, events: s.events.map((e) => (e.id === id ? { ...e, icon: c.key } : e)) })); } }, h("span", { style: { fontSize: 16, lineHeight: 1 } }, c.emoji), h("span", null, c.name))),
          h("button", { className: "cancel", onClick: () => setCatMenu(null) }, "取消")) : null);
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
        h("div", { className: "dsc-row", style: { marginBottom: 6, flexWrap: "wrap" } },
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
      const { store, update, now, pushCap } = props;
      const [tab, setTab] = useState("daily");
      return h("div", null,
        h("div", { className: "dsc-tabs" },
          h("button", { className: tab === "daily" ? "on" : "", onClick: () => setTab("daily") }, "日报"),
          h("button", { className: tab === "weekly" ? "on" : "", onClick: () => setTab("weekly") }, "周报")),
        tab === "daily" ? h(DailyReport, { store, update, now }) : h(WeeklyReport, { store, update, now }));
    }

    function DailyReport(props) {
      const { store, update, now, pushCap } = props;
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
      const { store, update, now, pushCap } = props;
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
      const { store, update, now, pushCap } = props;
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
          return h("div", { key: p.id, className: "dsc-card", style: { marginBottom: 6 } },
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
              h("div", { className: "dsc-muted", style: { fontSize: 12 } }, "勾选上班的星期："),
              h("div", { className: "dsc-wk", style: { marginTop: 4, flexWrap: "wrap" } },
                [1, 2, 3, 4, 5, 6, 0].map((wd) => h("label", { key: wd },
                  h("input", { type: "checkbox", checked: (sc.customWorkdays || []).indexOf(wd) >= 0, onChange: (e) => setPerson(p.id, (x) => { const arr = (x.schedule.customWorkdays || []).slice(); const i = arr.indexOf(wd); if (e.target.checked) { if (i < 0) arr.push(wd); } else if (i >= 0) arr.splice(i, 1); return { ...x, schedule: { ...x.schedule, customWorkdays: arr } }; }) }),
                  WD[wd].replace("周", ""))))): null);
        }),
        h(Btn, { kind: "mini", onClick: addPerson }, "＋ 添加成员"));
    }

    /* ---------- 设置 ---------- */
    /* 城市名统一格式：省·市·区（相邻重复与相同项自动去掉，例如「济南市」不再出现 山东省·济南市·济南市） */
    function cityNameOf(c) {
      const parts = [];
      const push = (v) => {
        const s0 = String(v == null ? "" : v).trim();
        if (!s0) return;
        if (parts.indexOf(s0) >= 0) return;
        parts.push(s0);
      };
      push(c && c.province);
      push(c && c.city);
      push((c && (c.district || c.name)) || "");
      return parts.join("·");
    }

    function cityTitle(c) {
      return cityNameOf(c);
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
          h("span", { className: "dsc-muted", style: { flex: 1, fontSize: 12 } },
            cur ? "将添加：" + [pv ? pv.name : "", cv && cv.name !== (pv ? pv.name : "") ? cv.name : "", cur.name].filter(Boolean).join("·") + "（" + cur.lat.toFixed(3) + "," + cur.lng.toFixed(3) + "）" : (loading ? "加载中…" : "请选择省 / 市 / 区")),
          h(Btn, { kind: "mini pri", onClick: add, disabled: !cur }, "＋ 添加")));
    }

    function SettingsView(props) {
      const { store, update, now, pushCap } = props;
      const [sec, setSec] = useState("work"); // 0.7.2：设置页二级分栏（一排 pill 切换，不再一条长列表往下滚）
      const [q, setQ] = useState("");
      const [results, setResults] = useState([]);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      const updRem = (fn) => update((s) => ({ ...s, settings: { ...s.settings, reminders: fn(s.settings.reminders || []) } }));
      const toggleReminder = (id) => updRem((arr) => arr.map((x) => x.id === id ? { ...x, enabled: !x.enabled } : x));
      const setReminderIv = (id, iv) => updRem((arr) => arr.map((x) => x.id === id ? { ...x, intervalMin: iv } : x));
      const delReminder = (id) => updRem((arr) => arr.filter((x) => x.id !== id));
      const addReminder = () => updRem((arr) => arr.concat([{ id: uid(), type: "custom", emoji: "⏰", name: "自定义提醒", enabled: true, intervalMin: 60, start: "09:00", end: "18:00", msg: "休息一下～" }]));
      const resetReminders = () => update((s) => ({ ...s, settings: { ...s.settings, reminders: JSON.parse(JSON.stringify(DEFAULT_REMINDERS)) } }));
      // 0.9.1：胶囊停留秒数（下限 3 秒，上限 60 秒）
      const reminderSec = Number(store.settings.reminderSeconds) || 6;
  const capX = Math.min(100, Math.max(0, Number.isFinite(Number(store.settings.capsX)) ? Number(store.settings.capsX) : 92));
  const capY = Math.min(100, Math.max(0, Number.isFinite(Number(store.settings.capsY)) ? Number(store.settings.capsY) : 92));
  const setCapPct = (k, v) => update((s) => ({ ...s, settings: { ...s.settings, [k]: Math.min(100, Math.max(0, Math.round(Number(v) || 0))) } }));
      const setReminderSec = (v) => update((s) => ({ ...s, settings: { ...s.settings, reminderSeconds: Math.min(60, Math.max(3, Number(v) || 6)) } }));
      // 0.8.6：手动预览一条提醒（弹胶囊 + 15s 内侧边栏自动弹出），不写 lastFiredAt、不影响正式计时
      const previewRemind = (rm) => {
        // 面板内胶囊是纯客户端渲染，不依赖宿主 —— 先弹，再顺带让宿主发一条 Windows 通知
        if (pushCap) pushCap({ id: rm.id, name: rm.name, msg: rm.msg });
        setMsg("已在面板右上角弹了一次「" + (rm.name || "提醒") + "」胶囊（" + reminderSec + " 秒后自动消失，点一下立即关）。这是预览，不影响正式计时。");
        post("/remind/test", { id: rm.id, name: rm.name, msg: rm.msg }).then((r) => {
          if (!r || !r.ok) {
            setMsg("面板胶囊已弹出（" + reminderSec + " 秒）。Windows 通知没发出去：" + String((r && r.error) || "宿主没加载 /remind/test"));
          }
        });
      };
      const drinkTotalMl = () => (store.settings.drink && store.settings.drink.totalMl) || 2100;
      const drinkCups = () => (store.settings.drink && store.settings.drink.cups) || 9;
      const setDrinkWeight = (w) => update((s) => { const totalMl2 = Math.round(w * 35); const cups = Math.max(1, Math.round(totalMl2 / 233)); return { ...s, settings: { ...s.settings, drink: { ...(s.settings.drink || {}), weightKg: w, totalMl: totalMl2, cups: cups } } }; });
      const diy = store.settings.diy || {};
      const setDiy = (patch) => update((s) => ({ ...s, settings: { ...s.settings, diy: { ...(s.settings.diy || {}), ...patch } } }));
      /* 0.9.0 文字颜色 */
      const tone = store.settings.textTone || "auto";
      const toneColor = store.settings.textColor || "";
      const setTone = (t) => update((s) => ({ ...s, settings: { ...s.settings, textTone: t } }));
      const setToneColor = (c) => update((s) => ({ ...s, settings: { ...s.settings, textColor: c, textTone: "custom" } }));
      const browseFolder = async () => { try { const r = await postJson(apiUrl("/pick-folder"), {}); if (r && r.ok && r.path) setDiy({ dir: r.path }); else if (r && r.error) setMsg("选择文件夹失败：" + r.error); } catch (e) { setMsg(String((e && e.message) || e)); } };
      const updCfg = store.settings.update || {};
      const [upd, setUpd] = useState(null);
      const [updBusy, setUpdBusy] = useState(false);
      const setUpdateCfg = (patch) => update((s) => ({ ...s, settings: { ...s.settings, update: { ...(s.settings.update || {}), ...patch } } }));
      const checkUpdate = async () => { setUpdBusy(true); try { const r = await getJson(apiUrl("/update/check")); setUpd(r); setUpdateCfg({ lastCheck: Date.now(), lastLatest: (r && r.latest) || "" }); } catch (e) { setUpd({ ok: false, available: false, error: String((e && e.message) || e) }); } finally { setUpdBusy(false); } };
      useEffect(() => { const c = (store.settings && store.settings.update) || {}; if (c.autoCheck && Date.now() - (c.lastCheck || 0) > 86400000) checkUpdate(); }, []);
      const search = async () => {
        const s = q.trim(); if (!s) return;
        setBusy(true); setMsg("");
        try { const j = await getJson(apiUrl("/geocode", "q=" + encodeURIComponent(s))); setResults((j && j.results) || []); if (!j || !j.ok) setMsg("查询失败：" + ((j && j.error) || "")); else if (!(j.results || []).length) setMsg("没找到，换个写法试试（如「北京 朝阳」）"); }
        catch (e) { setMsg(String((e && e.message) || e)); }
        setBusy(false);
      };
      const addCity = (r) => update((s) => {
        if ((s.weatherCities || []).some((c) => c.name === r.name || (Math.abs(c.latitude - r.latitude) < 0.002 && Math.abs(c.longitude - r.longitude) < 0.002))) return s;
        const parts = r.fullName ? r.fullName.split("·") : [r.name];
        let district = parts.length > 1 ? parts[parts.length - 1] : "";
        const province = parts.length >= 3 ? parts[0] : "";
        const cityName = parts.length >= 3 ? parts[1] : (parts.length === 2 ? parts[0] : "");
        /* 加的是「市」时，区县名与市名相同，去掉重复的区，最终统一成 省·市 */
        if (district && cityName && district === cityName) district = "";
        const city = { id: uid(), name: r.name, province: province, city: cityName, district: district, fullName: "", latitude: r.latitude, longitude: r.longitude };
        city.fullName = cityNameOf(city);
        const nc = (s.weatherCities || []).concat([city]);
        return { ...s, weatherCities: nc, settings: { ...s.settings, activeCityId: s.settings.activeCityId || city.id } };
      });
      const addRegion = (rec) => update((s) => {
        if ((s.weatherCities || []).some((c) => c.name === rec.name || (Math.abs(c.latitude - rec.latitude) < 0.002 && Math.abs(c.longitude - rec.longitude) < 0.002))) return s;
        const city = { id: uid(), name: rec.name, province: rec.province || "", city: rec.city || "", district: rec.district || rec.name, fullName: [rec.province, rec.city, rec.district].filter(Boolean).join("·"), latitude: rec.latitude, longitude: rec.longitude };
        const nc = (s.weatherCities || []).concat([city]);
        return { ...s, weatherCities: nc, settings: { ...s.settings, activeCityId: s.settings.activeCityId || city.id } };
      });
      return h("div", { className: "dsc-settings", "data-cur": sec },
        h("div", { className: "dsc-subtabs" },
          [["work", "班制"], ["city", "城市"], ["remind", "提醒"], ["look", "外观"], ["data", "数据"], ["about", "关于"]].map((pair) =>
            h("button", { key: pair[0], type: "button", className: "dsc-subtab" + (sec === pair[0] ? " on" : ""), onClick: () => setSec(pair[0]) }, pair[1]))),
        h("div", { className: "sg", "data-g": "work" },
        h("div", { className: "dsc-sec-h" }, "人员休息日 / 班制"),
        h(PeopleView, { store, update, now: now || new Date() }),
        ),
        h("div", { className: "sg", "data-g": "city" },
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
            h("span", { className: "dsc-muted", style: { fontSize: 11.5 } }, c.latitude.toFixed(2) + "," + c.longitude.toFixed(2)),
            h(Btn, { kind: "mini ghost", onClick: () => update((s) => ({ ...s, weatherCities: s.weatherCities.filter((x) => x.id !== c.id) })) }, "删除")))) : h("div", { className: "dsc-empty" }, "还没有城市")),
          // 0.8.5：这条刷新说明只在「设置 → 城市」里出现，今日页不再显示
          h("div", { className: "dsc-muted", style: { fontSize: 11.5, marginTop: 6, lineHeight: 1.5 } },
            (WX_CACHE.at ? "上次刷新 " + new Date(WX_CACHE.at).toTimeString().slice(0, 5) + " · " : "") + "天气每天 8:30 / 12:00 / 17:30 自动刷新一次，其他时间保持静态不跳动；想立刻更新就回「今日」点右上角 🔄 刷新。"),
        ),
        h("div", { className: "sg", "data-g": "remind" },
        h("div", { className: "dsc-sec dsc-card" },
          h("div", { className: "dsc-sec-h" }, "提醒"),
          h("label", { className: "dsc-row", style: { marginBottom: 6 } }, h("input", { type: "checkbox", checked: !!store.settings.reminderSound, onChange: (e) => update((s) => ({ ...s, settings: { ...s.settings, reminderSound: e.target.checked } })) }), "提示音"),
          h("label", { className: "dsc-row" }, h("input", { type: "checkbox", checked: !!store.settings.workReminder, onChange: (e) => update((s) => ({ ...s, settings: { ...s.settings, workReminder: e.target.checked } })) }), "上下班提醒"),
          h("label", { className: "dsc-row", style: { marginTop: 4 } }, h("input", { type: "checkbox", checked: store.settings.reminderToast !== false, onChange: (e) => update((s) => ({ ...s, settings: { ...s.settings, reminderToast: e.target.checked } })) }), "到点弹「胶囊」（面板右上角浮一条，最小化时再走 Windows 通知）"),
          h("div", { className: "dsc-row", style: { marginTop: 2, marginBottom: 4, flexWrap: "wrap" } },
            h("span", { className: "dsc-muted", style: { minWidth: 56 } }, "停留时间"),
            [3, 5, 8, 12].map((n) => h(Btn, { key: n, kind: reminderSec === n ? "mini pri" : "mini ghost", onClick: () => setReminderSec(n) }, n + " 秒")),
            h("input", { className: "dsc-input", type: "number", min: 3, max: 60, value: reminderSec, style: { width: 62 }, onChange: (e) => setReminderSec(e.target.value) }),
            h("span", { className: "dsc-muted" }, "秒（3~60，点胶囊立即关；胶囊浮在整个 DSH 界面之上）")),
          h("div", { className: "dsc-row", style: { marginTop: 2, marginBottom: 2, flexWrap: "wrap" } },
            h("span", { className: "dsc-muted", style: { minWidth: 56 } }, "弹出位置"),
            h("span", { className: "dsc-muted" }, "左右"),
            h("input", { className: "dsc-range", type: "range", min: 0, max: 100, value: capX, onChange: (e) => setCapPct("capsX", e.target.value) }),
            h("span", { className: "dsc-muted", style: { width: 36 } }, capX + "%"),
            h("span", { className: "dsc-muted" }, "上下"),
            h("input", { className: "dsc-range", type: "range", min: 0, max: 100, value: capY, onChange: (e) => setCapPct("capsY", e.target.value) }),
            h("span", { className: "dsc-muted", style: { width: 36 } }, capY + "%"),
            h(Btn, { kind: "mini", onClick: () => { if (pushCap) pushCap({ id: "pos-test", name: "位置测试", msg: "这是测试胶囊，点一下可关闭（" + reminderSec + " 秒后自动消失）" }); } }, "测试")),
          h("div", { className: "dsc-muted", style: { marginBottom: 4 } }, "胶囊浮在整个 DSH 界面之上（不在侧边栏里）：左右/上下都是相对整个窗口的百分比，拖完点「测试」立刻看位置；多条提醒竖向排一列（最多 5 条），点胶囊立刻关。"),
          h("label", { className: "dsc-row", style: { marginTop: 4 } }, h("input", { type: "checkbox", checked: store.settings.reminderPopup !== false, onChange: (e) => update((s) => ({ ...s, settings: { ...s.settings, reminderPopup: e.target.checked } })) }), "到点自动弹出侧边栏（定位到日程助手）"),
          h("label", { className: "dsc-row", style: { marginTop: 4 } }, h("input", { type: "checkbox", checked: store.settings.showAlmanac !== false, onChange: (e) => update((s) => ({ ...s, settings: { ...s.settings, showAlmanac: e.target.checked } })) }), "今日头部显示黄历（宜/忌）"),
          h("label", { className: "dsc-row", style: { marginTop: 4 } }, h("input", { type: "checkbox", checked: store.settings.showHoroscope !== false, onChange: (e) => update((s) => ({ ...s, settings: { ...s.settings, showHoroscope: e.target.checked } })) }), "今日底部显示星座运势")),
        h("div", { className: "dsc-sec dsc-card" },
          h("div", { className: "dsc-sec-h" }, "健康/趣味提醒",
            h("span", { className: "sp" },
              h(Btn, { kind: "mini", onClick: resetReminders }, "恢复默认"),
              h(Btn, { kind: "mini pri", onClick: addReminder }, "＋ 新增"))),
          (store.settings.reminders || []).map((rm) => h("div", { key: rm.id, className: "dsc-row", style: { marginBottom: 5 } },
            h("input", { type: "checkbox", checked: !!rm.enabled, onChange: () => toggleReminder(rm.id) }),
            h("span", { style: { flex: 1, minWidth: 60 } }, (rm.emoji || "⏰") + " " + (rm.name || "提醒")),
            h("span", { className: "dsc-muted", style: { fontSize: 11.5, whiteSpace: "nowrap" } }, "每 " + (rm.intervalMin || 60) + " 分"),
            h("input", { className: "dsc-input", type: "number", style: { width: 52 }, value: rm.intervalMin || 60, onChange: (e) => setReminderIv(rm.id, Math.max(5, Number(e.target.value) || 5)) }),
            h("button", { className: "dsc-btn mini ghost", style: { padding: "2px 6px" }, title: "手动预览：立刻弹一次胶囊，15 秒内侧边栏自动弹出（不影响正式计时）", onClick: () => previewRemind(rm) }, "▶"),
            h("button", { className: "dsc-btn mini ghost", onClick: () => delReminder(rm.id) }, "✕"))),
          h("div", { className: "dsc-sec-h", style: { marginTop: 6 } }, "喝水计划（科学饮水）"),
          h("div", { className: "dsc-row" },
            h("span", { className: "dsc-muted", style: { fontSize: 12 } }, "体重"),
            h("input", { className: "dsc-input", type: "number", style: { width: 64 }, value: (store.settings.drink && store.settings.drink.weightKg) || 60, onChange: (e) => setDrinkWeight(Number(e.target.value) || 60) }),
            h("span", { className: "dsc-muted", style: { fontSize: 12 } }, "kg → 每日约 " + drinkTotalMl() + " ml · " + drinkCups() + " 次 · 每次约 " + Math.round(drinkTotalMl() / drinkCups()) + " ml")),
          h("div", { className: "dsc-muted", style: { fontSize: 11.5, marginTop: 3 } }, "每日饮水量 ≈ 体重×35ml，分 8~10 次、每次 200~250ml，间隔约 1~1.5 小时；运动或天气热时适当增加。" )),
        ),
        h("div", { className: "sg", "data-g": "look" },
        h("div", { className: "dsc-sec dsc-card" },
          h("div", { className: "dsc-sec-h" }, "文字颜色（壁纸深浅不定时手动调）"),
          h("div", { className: "dsc-row", style: { marginBottom: 6, flexWrap: "wrap" } },
            h(Btn, { kind: tone === "auto" ? "mini pri" : "mini ghost", onClick: () => setTone("auto") }, "自动"),
            h(Btn, { kind: tone === "dark" ? "mini pri" : "mini ghost", onClick: () => setTone("dark") }, "深色字"),
            h(Btn, { kind: tone === "light" ? "mini pri" : "mini ghost", onClick: () => setTone("light") }, "浅色字"),
            h(Btn, { kind: tone === "custom" ? "mini pri" : "mini ghost", onClick: () => setTone("custom") }, "自定义")),
          (tone === "custom" ? h("div", { className: "dsc-row", style: { marginBottom: 6 } },
            h("input", { type: "color", value: toneColor || "#1b2233", onChange: (e) => setToneColor(e.target.value), style: { width: 44, height: 26, padding: 0, border: "1px solid var(--line)", borderRadius: 6, background: "transparent" } }),
            h("span", { style: { fontSize: 12, color: toneColor || "#1b2233" } }, "示例文字：今天 10:00 项目评审")) : null),
          h("div", { className: "dsc-muted", style: { fontSize: 11.5, marginTop: 3 } }, "壁纸偏深选「浅色字」，壁纸偏浅选「深色字」；轮播深浅混杂就选「自定义」取一个中间色（如 #6b7280 灰）。这项只改界面文字颜色，不动卡片与遮罩。")),
        h("div", { className: "dsc-sec dsc-card" },
          h("div", { className: "dsc-sec-h" }, "DIY 背景（壁纸文件夹轮播）"),
          h("label", { className: "dsc-row", style: { marginBottom: 6 } },
            h("input", { type: "checkbox", checked: !!diy.enabled, onChange: (e) => setDiy({ enabled: e.target.checked }) }),
            "启用背景图轮播（深浅色自动适配）"),
          h("label", { className: "dsc-row", style: { marginBottom: 6 } },
            h("input", { type: "checkbox", checked: diy.frost !== false, onChange: (e) => setDiy({ frost: e.target.checked }) }),
            "磨砂玻璃效果（关闭后更透明、能清楚看壁纸）"),
          h("div", { className: "dsc-row", style: { marginBottom: 6 } },
            h("input", { className: "dsc-input", style: { flex: 1, minWidth: 120 }, placeholder: "壁纸文件夹绝对路径，如 D:/壁纸，可手输或点浏览", value: diy.dir || "", onChange: (e) => setDiy({ dir: e.target.value }) }),
            h(Btn, { kind: "mini", onClick: browseFolder }, "浏览…")),
          h("div", { className: "dsc-row", style: { marginBottom: 6 } },
            h("span", { className: "dsc-muted", style: { fontSize: 12 } }, "切换间隔(秒)"),
            h("input", { className: "dsc-input", type: "number", style: { width: 64 }, min: 1, value: diy.intervalSec || 30, onChange: (e) => setDiy({ intervalSec: Math.max(1, Number(e.target.value) || 30) }) }),
            h("span", { className: "dsc-muted", style: { fontSize: 12 } }, "壁纸透明度(%)"),
            h("input", { className: "dsc-input", type: "number", style: { width: 64 }, min: 0, max: 100, value: Math.round((1 - (diy.veil == null ? 0.18 : diy.veil)) * 100), onChange: (e) => setDiy({ veil: Math.min(1, Math.max(0, 1 - (Number(e.target.value) || 0) / 100)) }) })),
          // 0.8.7：轮播顺序可切换（顺序 = 按文件夹列表一张张来；随机 = 每次随机挑，且不会连着重复同一张）
          h("div", { className: "dsc-row", style: { marginBottom: 6 } },
            h("span", { className: "dsc-muted", style: { fontSize: 12 } }, "轮播顺序"),
            h(Btn, { kind: diy.order === "rand" ? "mini ghost" : "mini pri", onClick: () => setDiy({ order: "seq" }), title: "按文件夹里的列表顺序一张张轮" }, "顺序"),
            h(Btn, { kind: diy.order === "rand" ? "mini pri" : "mini ghost", onClick: () => setDiy({ order: "rand" }), title: "每次从文件夹里随机挑一张（不会连着重复同一张）" }, "随机")),
          h("div", { className: "dsc-muted", style: { fontSize: 11.5, marginTop: 2 } }, "只需填壁纸文件夹路径；插件读取文件夹内图片（jpg/png/webp/gif）自动轮播为面板背景。「壁纸透明度」0~100（0=不显示壁纸，100=壁纸完全显示），建议 75~90（数字越大壁纸越清楚、白雾越少）；启用后卡片会半透明透出壁纸，深色/浅色模式自动适配。")),
        h("div", { className: "dsc-sec dsc-card" },
          h("div", { className: "dsc-sec-h" }, "日历配色（点色块改颜色）"),
          [["weekend", "周末"], ["rest", "休息日"], ["holiday", "法定假期"], ["makeup", "补班上班"]].map((pair) =>
            h("label", { key: pair[0], className: "dsc-row", style: { marginBottom: 4 } },
              h("span", { style: { flex: 1 } }, pair[1]),
              h("input", { type: "color", value: (store.settings.colors || CAL_COLORS)[pair[0]] || CAL_COLORS[pair[0]], onChange: (e) => update((s) => ({ ...s, settings: { ...s.settings, colors: Object.assign({}, CAL_COLORS, s.settings.colors || {}, { [pair[0]]: e.target.value }) } })), style: { width: 44, height: 24, padding: 0, border: "none", background: "transparent" } }),
              h(Btn, { kind: "mini ghost", onClick: () => update((s) => ({ ...s, settings: { ...s.settings, colors: Object.assign({}, CAL_COLORS, s.settings.colors || {}, { [pair[0]]: CAL_COLORS[pair[0]] }) } })) }, "默认")))),
        ),
        h("div", { className: "sg", "data-g": "data" },
        h("div", { className: "dsc-sec dsc-card" },
          h("div", { className: "dsc-sec-h" }, "数据"),
          h("div", { className: "dsc-row" },
            h(Btn, { kind: "mini", onClick: () => props.reload() }, "重新加载"),
            h("span", { className: "dsc-muted", style: { fontSize: 12 } }, "数据存插件包 data/store.json，自动保存"))),
        ),
        h("div", { className: "sg", "data-g": "about" },
        h("div", { className: "dsc-sec dsc-card" },
          h("div", { className: "dsc-sec-h" }, "关于"),
          h("div", { className: "dsc-row" },
            h("span", { style: { flex: 1, fontSize: 12 } }, "日程助手 · 开源插件，喜欢请点个 Star ⭐"),
            h(Btn, { kind: "mini pri", onClick: () => { try { window.open(REPO_URL, "_blank"); } catch (e) { /* ignore */ } } }, "GitHub Star"))),
        h("div", { className: "dsc-sec dsc-card" },
          h("div", { className: "dsc-sec-h" }, "关于与更新"),
          h("div", { className: "dsc-row", style: { marginBottom: 6 } },
            h("span", { style: { flex: 1, fontSize: 12 } }, "当前版本 v" + VERSION),
            h(Btn, { kind: "mini pri", onClick: checkUpdate }, updBusy ? "检查中…" : "检查更新")),
          upd && upd.installType === "local" ? h("div", { className: "dsc-muted", style: { fontSize: 12, lineHeight: 1.6, marginTop: 2 } }, "当前为本地开发版（link 安装），如需更新请 git pull 或重新发布；不支持从 npm 一键安装。") : null,
          upd && upd.error ? h("div", { className: "dsc-muted", style: { fontSize: 12, color: "#e05a5a", marginTop: 2 } }, "检查失败：" + upd.error + "（可稍后重试）") : null,
          upd && !upd.error && upd.ok ? h("div", { style: { fontSize: 12, lineHeight: 1.7, marginTop: 4 } },
            h("div", null, "最新版本：" + (upd.latest || "未知") + (upd.hasUpdate ? "　🆕 有新版本" : "　✓ 已是最新")),
            upd.source ? h("div", { className: "dsc-muted", style: { fontSize: 11.5 } }, "来源：" + upd.source) : null,
            upd.hasUpdate && upd.installType !== "local" ? h("div", { style: { marginTop: 6 } }, h(Btn, { kind: "mini", onClick: () => { try { window.open(upd.latestUrl || REPO_URL, "_blank"); } catch (e) { /* ignore */ } } }, "查看新版"), h("span", { className: "dsc-muted", style: { fontSize: 11.5, marginLeft: 6 } }, "升级需手动批准并重启")) : null) : null,
          h("label", { className: "dsc-row", style: { marginTop: 8 } },
            h("span", { style: { flex: 1, fontSize: 12 } }, "自动检查更新（仅检查并提示，不自动安装）"),
            h("input", { type: "checkbox", checked: !!updCfg.autoCheck, onChange: (e) => { setUpdateCfg({ autoCheck: e.target.checked }); if (e.target.checked) checkUpdate(); } }))),
        ),
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
      return h("div", { className: "dsc-card", style: { marginBottom: 6, borderColor: "var(--accent)" } },
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
    function MailView(props) {
      const { store, update } = props;
      const [showContacts, setShowContacts] = useState(false); // 联系人弹层
      const [contactQ, setContactQ] = useState("");
      const [cName, setCName] = useState("");
      const [cEmail, setCEmail] = useState("");
      const [st, setSt] = useState(null);
      const [items, setItems] = useState([]);
      const [sel, setSel] = useState(null);
      const [bodyText, setBodyText] = useState("");
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      const [email, setEmail] = useState("");
      const [authCode, setAuthCode] = useState("");
      const [label, setLabel] = useState("");
      const [editId, setEditId] = useState(""); // 非空 = 正在编辑已有账号（避免每次保存都新建一条）
      const [showSetup, setShowSetup] = useState(false);
      const [kw, setKw] = useState("");
      const [tab, setTab] = useState("all"); // all | unread | sent
      const [compose, setCompose] = useState(null); // {to,cc,subject,text,attachments}
      const [sending, setSending] = useState(false);
      const [preview, setPreview] = useState(null); // 附件预览 {url,name}
      const [pickTo, setPickTo] = useState("to");   // 联系人点选填到哪一栏：to | cc
      const [bulk, setBulk] = useState(false);      // 群发：收件人按逗号/分号/换行拆开，逐个单独发
      const [gapSec, setGapSec] = useState(3);      // 群发间隔秒（防判垃圾邮件）
      const [prog, setProg] = useState("");         // 群发进度文案
      // 0.7.1：多账号 —— acctFilter 过滤收件（""=全部账号），fromId 选发件账号
      const [acctFilter, setAcctFilter] = useState("");
      const [fromId, setFromId] = useState("");

      const load = useCallback(async () => {
        try {
          const a = await getJson(apiUrl("/mail/state"));
          setSt(a);
          const l = await getJson(apiUrl("/mail/list", "since=0"));
          const list = ((l && l.items) || []).slice().reverse();
          setItems(list);
          return list;
        } catch (e) { setMsg("加载失败：" + String((e && e.message) || e)); return []; }
      }, []);
      useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
      // 0.7.1：发件账号默认取第一个已启用账号（多账号时用户可在写信面板改）
      useEffect(() => {
        const en = ((st && st.accounts) || []).filter((a) => a && a.enabled);
        if (!fromId && en.length) setFromId(en[0].id);
      }, [st]);
      const post = async (path, body) => { setBusy(true); try { const r = await postJson(apiUrl(path), body || {}); if (r && r.ok === false && r.error) setMsg(r.error); await load(); return r; } catch (e) { setMsg(String((e && e.message) || e)); } finally { setBusy(false); } };
      // ── 附件（0.6.1）：浏览器侧选文件 → base64 → 宿主校验后再发；客户端先做一次大小闸门 ──
      const MAX_ONE = 8 * 1024 * 1024;
      const MAX_ALL = 20 * 1024 * 1024;
      // 图片一律压一张 ≤360px 的缩略图（约 20~40KB）：界面预览不再看文件大小脸色
      const thumbOf = (dataUrl) => new Promise((res) => {
        try {
          const img = new Image();
          img.onload = () => {
            try {
              const max = 360;
              const r = Math.min(1, max / Math.max(img.width || 1, img.height || 1));
              const w = Math.max(1, Math.round((img.width || 1) * r));
              const hh = Math.max(1, Math.round((img.height || 1) * r));
              const cv = document.createElement("canvas");
              cv.width = w; cv.height = hh;
              const cx = cv.getContext("2d");
              cx.drawImage(img, 0, 0, w, hh);
              res(cv.toDataURL("image/jpeg", 0.75));
            } catch (e) { res(""); }
          };
          img.onerror = () => res("");
          img.src = dataUrl;
        } catch (e) { res(""); }
      });
      const readFileB64 = (f) => new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onerror = () => rej(fr.error || new Error("读取失败"));
        fr.onload = async () => {
          const s = String(fr.result || "");
          const b64 = s.slice(s.indexOf(",") + 1);
          const isImg = /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(f.type || "");
          // 原图 ≤2MB 才留原件（点缩略图看清晰大图），更大的用缩略图兜底
          const keepUrl = isImg && f.size <= 2 * 1024 * 1024;
          const thumb = isImg ? await thumbOf(s) : "";
          res({ b64, dataUrl: keepUrl ? s : "", thumb });
        };
        fr.readAsDataURL(f);
      });
      // 附件类型徽标：按扩展名给两三个字母 + 一组配色，替代难看的 emoji
      const attBadge = (name, type) => {
        const ext = (String(name || "").split(".").pop() || "").toLowerCase().slice(0, 4);
        const t = String(type || "");
        if (/^image\//.test(t) || /^(png|jpe?g|gif|webp|bmp|svg)$/.test(ext)) return { t: "IMG", c: "#0f9d58", bg: "rgba(15,157,88,.14)" };
        if (/^(pdf)$/.test(ext)) return { t: "PDF", c: "#d93025", bg: "rgba(217,48,37,.14)" };
        if (/^(docx?|rtf)$/.test(ext)) return { t: "DOC", c: "#1a73e8", bg: "rgba(26,115,232,.14)" };
        if (/^(xlsx?|csv)$/.test(ext)) return { t: "XLS", c: "#137333", bg: "rgba(19,115,51,.14)" };
        if (/^(pptx?)$/.test(ext)) return { t: "PPT", c: "#e37400", bg: "rgba(227,116,0,.14)" };
        if (/^(zip|rar|7z|gz|tar)$/.test(ext)) return { t: "ZIP", c: "#8e24aa", bg: "rgba(142,36,170,.14)" };
        if (/^(txt|md|log)$/.test(ext)) return { t: "TXT", c: "#5f6368", bg: "rgba(95,99,104,.14)" };
        const e2 = (ext || "FILE").toUpperCase().slice(0, 3);
        return { t: e2, c: "#546e7a", bg: "rgba(84,110,122,.14)" };
      };
      const kb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + "MB" : Math.max(1, Math.round((n || 0) / 1024)) + "KB");
      // 0.7.2：正文里的网址渲染成可点的蓝色链接；点击交给宿主 /mail/open-url 用系统浏览器打开
      const linkify = (text) => {
        const s = String(text || "");
        const re = /(https?:\/\/[^\s<>"'（）【】\[\]]+)/gi;
        const out = [];
        let last = 0;
        let m;
        let k = 0;
        while ((m = re.exec(s))) {
          if (m.index > last) out.push(s.slice(last, m.index));
          const u = m[1].replace(/[.,;:!?]+$/, "");
          if (u.length > 8) {
            out.push(h("a", { key: "u" + (k++), className: "dsc-mail-link", href: u, title: u + "（点开用系统默认浏览器）", onClick: (e) => { e.preventDefault(); post("/mail/open-url", { url: u }).then((r) => { if (r && r.ok) setMsg("已在浏览器打开：" + u); else setMsg("打不开：宿主没加载 /open-url（0.7.2 新接口，刷新无效，要彻底退出 DSH 再启动）"); }); } }, u));
          } else {
            out.push(m[1]);
          }
          last = m.index + m[1].length;
        }
        if (last < s.length) out.push(s.slice(last));
        return out.length ? out : [s];
      };
      // ── 联系人（0.6.3）：存在 store.contacts，沿用现有 /data 落盘，纯客户端即可，不用重启宿主 ──
      const contacts = (store && store.contacts) || [];
      const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
      const addContact = () => {
        const em = String(cEmail || "").trim();
        if (!emailOk(em)) { setMsg("邮箱格式不对，例如 someone@example.com"); return; }
        if (contacts.some((x) => String(x.email).toLowerCase() === em.toLowerCase())) { setMsg("这个邮箱已经在联系人里了"); return; }
        update((s) => ({ ...s, contacts: (s.contacts || []).concat([{ id: "c-" + Math.random().toString(36).slice(2, 10), name: String(cName || "").trim() || em.split("@")[0], email: em }]) }));
        setCName(""); setCEmail(""); setMsg("已保存联系人");
      };
      const delContact = (id) => update((s) => ({ ...s, contacts: (s.contacts || []).filter((x) => x.id !== id) }));
      const pickContact = (x) => {
        // 收件人 / 抄送两栏都能点选（0.6.6）：按 pickTo 决定填哪一栏
        const field = pickTo === "cc" ? "cc" : "to";
        const cur = String((compose && compose[field]) || "").trim();
        const parts = cur ? cur.split(/[,;，；\s]+/).filter(Boolean) : [];
        const em = String((x && x.email) || "").trim();
        if (!em) return;
        if (!parts.some((p) => p.toLowerCase() === em.toLowerCase())) parts.push(em);
        setCompose({ ...(compose || { to: "", cc: "", subject: "", text: "", attachments: [] }), [field]: parts.join(", ") });
        setShowContacts(false);
        setMsg("已加入" + (field === "cc" ? "抄送" : "收件人") + "：" + em + (field === "to" && bulk ? "（群发会自动拆成单独一封）" : ""));
      };
      // ── 草稿箱（0.6.6）：存 store.drafts，纯客户端，走既有 /data 落盘 ──
      const drafts = (store && store.drafts) || [];
      const saveDraft = () => {
        if (!compose) return;
        const d = {
          id: "d-" + Math.random().toString(36).slice(2, 10),
          at: Date.now(),
          to: compose.to || "", cc: compose.cc || "", subject: compose.subject || "", text: compose.text || "",
          // 附件只留元信息：base64 存进 store 会把 data.json 撑爆
          attachments: (compose.attachments || []).map((a) => ({ filename: a.filename, size: a.size, contentType: a.contentType })),
        };
        update((s) => ({ ...s, drafts: [d].concat(s.drafts || []).slice(0, 50) }));
        const hadAtt = (compose.attachments || []).length;
        setCompose(null);
        setTab("draft");
        setMsg("已存草稿" + (hadAtt ? "（附件需重新添加）" : ""));
      };
      const openDraft = (d) => {
        setCompose({ to: d.to || "", cc: d.cc || "", subject: d.subject || "", text: d.text || "", attachments: [] });
        setMsg("已载入草稿" + (((d.attachments || []).length) ? "，原附件需重新添加" : ""));
      };
      const delDraft = (id) => update((s) => ({ ...s, drafts: (s.drafts || []).filter((x) => x.id !== id) }));
      const collectContacts = (addrs) => update((s) => {
        const list = (s.contacts || []).slice();
        for (const a of addrs) {
          const em = String(a || "").trim();
          if (!emailOk(em)) continue;
          if (!list.some((x) => String(x.email).toLowerCase() === em.toLowerCase())) list.push({ id: "c-" + Math.random().toString(36).slice(2, 10), name: em.split("@")[0], email: em });
        }
        return { ...s, contacts: list };
      });
      const pickFiles = () => {
        const el = document.createElement("input");
        el.type = "file";
        el.multiple = true;
        el.onchange = async () => {
          const files = Array.from(el.files || []);
          if (!files.length) return;
          const cur = (compose && compose.attachments) || [];
          let total = cur.reduce((s, a) => s + (a.size || 0), 0);
          const next = cur.slice();
          for (const f of files) {
            if (f.size > MAX_ONE) { setMsg("「" + f.name + "」超过单个 8MB，已跳过"); continue; }
            if (total + f.size > MAX_ALL) { setMsg("附件合计超过 20MB，「" + f.name + "」已跳过"); continue; }
            try {
              const r = await readFileB64(f);
              next.push({ filename: f.name, contentType: f.type || "", size: f.size, base64: r.b64, dataUrl: r.dataUrl || r.thumb || "", thumb: r.thumb || "" });
              total += f.size;
            } catch (e) {
              setMsg("读取「" + f.name + "」失败：" + String((e && e.message) || e));
            }
          }
          setCompose({ ...(compose || {}), attachments: next });
        };
        el.click();
      };

      const accounts = (st && st.accounts) || [];
      const enabled = !!(st && st.enabled);
      const inbox = items.filter((m) => m && m.folder !== "sent");
      // 0.7.0：垃圾 / 垃圾箱都是标记位 —— 正常视图看不到，但数据还在，可以还原
      const live = inbox.filter((m) => m.trashed !== true && m.spam !== true);
      const unread = live.filter((m) => m.seen !== true).length;
      const starredCount = inbox.filter((m) => m.starred === true && m.trashed !== true).length;
      const spamCount = inbox.filter((m) => m.spam === true && m.trashed !== true).length;
      const trashCount = inbox.filter((m) => m.trashed === true).length;

      // 列表：先按 tab 过滤，再按关键字搜（主题/发件人/摘要/正文）
      const filtered = items.filter((m) => {
        if (!m) return false;
        if (acctFilter && String(m.accountId || "") !== acctFilter) return false;
        if (tab === "draft") return false; // 草稿存在本地 store.drafts，不走邮件列表
        if (tab === "trash") { if (m.trashed !== true) return false; }
        else if (tab === "spam") { if (m.spam !== true || m.trashed === true) return false; }
        else if (tab === "star") { if (m.starred !== true || m.trashed === true) return false; }
        else if (tab === "sent") { if (m.folder !== "sent") return false; }
        else {
          if (m.folder === "sent") return false;
          if (m.trashed === true || m.spam === true) return false;
          if (tab === "unread" && m.seen === true) return false;
        }
        const k = kw.trim().toLowerCase();
        if (!k) return true;
        const hay = ((m.subject || "") + " " + ((m.from && (m.from.name || m.from.address)) || "") + " " + (m.snippet || "") + " " + (m.text || "")).toLowerCase();
        return hay.indexOf(k) >= 0;
      });

      const openMail = useCallback(async (m) => {
        setSel(m);
        setBodyText(m.text || m.preview || m.snippet || "");
        // 0.6.7：详情改成覆盖层，不再滚到列表底部（用户要的是「不滚动、盖住页面读」）
        if (m.seen !== true) post("/mail/mark-read", { seq: m.seq, seen: true });
        try {
          const r = await postJson(apiUrl("/mail/body"), { seq: m.seq });
          if (r && r.ok && r.text) setBodyText(r.text);
        } catch (e) { /* 正文取不到就退回摘要 */ }
      }, []);

      const timeStr = (v) => {
        if (!v) return "";
        const d = new Date(v);
        if (isNaN(d.getTime())) return String(v);
        const now = new Date();
        const same = d.toDateString() === now.toDateString();
        const hh = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
        return same ? hh : d.getMonth() + 1 + "/" + d.getDate() + " " + hh;
      };

      return h("div", null,
        // ── 顶栏：标题 + 未读 + 写信 + 刷新 + 设置 ──
        h("div", { className: "dsc-sec-h" }, "邮件" + (unread ? " · 未读 " + unread : ""), h("span", { className: "sp" },
          h(Btn, { kind: "mini pri", onClick: () => setCompose({ to: "", cc: "", subject: "", text: "", attachments: [] }) }, "✏ 写信"),
          h(Btn, { kind: "mini ghost", onClick: () => { load(); setMsg("已刷新"); } }, "刷新"),
          h(Btn, { kind: "mini ghost", onClick: () => setShowSetup((v) => !v) }, showSetup ? "收起设置" : "⚙ 账号设置"))),
        msg ? h("div", { className: "dsc-tagline" }, msg) : null,

        // ── 账号设置（折叠） ──
        showSetup ? h("div", { className: "dsc-card", style: { marginBottom: 6 } },
          h("div", { className: "dsc-muted", style: { fontSize: 12, marginBottom: 6 } }, "状态：" + (enabled ? "监控中" : "未开启") + " · 账号 " + accounts.length + " · 收件 " + inbox.length + " 封 · 未读 " + unread),
          accounts.length ? accounts.map((a) => {
            // 0.7.9：已保存账号显示完整信息（邮箱、服务器、端口/TLS、轮询间隔、上次检查、收件与未读）
            const mine = items.filter((m) => String(m.accountId || "") === String(a.id));
            const mineUnc = mine.filter((m) => m.seen !== true && m.folder !== "sent" && m.trashed !== true && m.spam !== true).length;
            const iv = Number(a.pollIntervalSec) || Number(st && st.pollIntervalSec) || 30;
            const lc = Number(a.lastCheckAt) || 0;
            return h("div", { key: a.id, style: { marginBottom: 6, padding: "5px 7px", borderRadius: 8, border: "1px solid var(--line)", background: "rgba(255,255,255,.5)" } },
              h("div", { className: "dsc-row", style: { gap: 6, alignItems: "center" } },
                h("span", { style: { flex: 1, minWidth: 0, fontWeight: 700, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, (a.label || a.email || "账号") + (a.enabled ? "" : "（已停用）")),
                h(Btn, { kind: "mini ghost", onClick: () => { setEditId(a.id); setLabel(a.label || ""); setEmail(a.email || ""); setAuthCode(""); setMsg("正在编辑 " + (a.label || a.email) + "：授权码留空表示保持不变"); } }, "编辑"),
                h(Btn, { kind: "mini", onClick: () => post("/mail/account/test", { id: a.id }) }, "测试"),
                h(Btn, { kind: "mini ghost", onClick: () => post("/mail/account/delete", { id: a.id }) }, "删除")),
              h("div", { className: "dsc-muted", style: { fontSize: 11.5, marginTop: 2, wordBreak: "break-all" } }, a.email || "（未填邮箱）"),
              h("div", { className: "dsc-muted", style: { fontSize: 11.5 } }, (a.imapHost || "imap.qq.com") + ":" + (a.imapPort || 993) + (a.tls === false ? "（未加密）" : " · SSL/TLS") + " · 每 " + iv + " 秒检查"),
              h("div", { className: "dsc-muted", style: { fontSize: 11.5 } }, (a.hasAuthCode ? "授权码已保存" : "缺授权码") + " · 收件 " + mine.length + " · 未读 " + mineUnc + " · " + (lc ? "上次检查 " + timeStr(lc) : "尚未检查") + (a.lastError ? " · ⚠" + a.lastError : "")));
          }) : h("div", { className: "dsc-muted", style: { fontSize: 12 } }, "还没有账号，添加一个 QQ 邮箱账号："),
          h("div", { className: "dsc-row", style: { marginTop: 6, gap: 6 } },
            h("input", { className: "dsc-input", style: { flex: 1, minWidth: 90 }, placeholder: "备注(可选)", value: label, onChange: (e) => setLabel(e.target.value) }),
            h("input", { className: "dsc-input", style: { flex: 1.3, minWidth: 110 }, placeholder: "QQ邮箱地址", value: email, onChange: (e) => setEmail(e.target.value) })),
          h("div", { className: "dsc-row", style: { marginTop: 6, gap: 6 } },
            h("input", { className: "dsc-input", style: { flex: 1, minWidth: 110 }, type: "password", placeholder: editId ? "IMAP 授权码（留空=不改）" : "IMAP 授权码", value: authCode, onChange: (e) => setAuthCode(e.target.value) }),
            h(Btn, { kind: "mini pri", onClick: async () => {
              const em = email.trim();
              if (!em) { setMsg("请填邮箱地址"); return; }
              const same = accounts.find((a) => String(a.email || "").trim().toLowerCase() === em.toLowerCase());
              const payload = { label: label.trim() || em, email: em, authCode: authCode.trim() };
              const tid = editId || (same ? same.id : "");
              if (tid) payload.id = tid; // 带 id = 更新已有账号；不带 = 新建（会重复建号，多连接抢同一邮箱）
              const r = await post("/mail/account/save", payload);
              if (r && r.ok) { setEmail(""); setAuthCode(""); setLabel(""); setEditId(""); setMsg("已保存账号"); }
            } }, "保存账号"),
            h(Btn, { kind: "mini", onClick: () => post("/mail/config", { enabled: !enabled }) }, enabled ? "关闭监控" : "开启监控")),
          h("div", { className: "dsc-muted", style: { fontSize: 12, lineHeight: 1.7, marginTop: 8 } },
            "IMAP 授权码不是 QQ 密码。获取：电脑登录 QQ邮箱网页版 → 设置 → 账号 → 账号与安全 → 安全设置 → POP3/IMAP/SMTP 服务 → 生成授权码（首次需手机短信验证），填上方授权码框。",
            h("span", { style: { marginLeft: 6 } }, h(Btn, { kind: "mini ghost", onClick: () => { try { window.open("https://wx.mail.qq.com/account/index#/verify/gac", "_blank"); } catch (e) { /* ignore */ } } }, "如何获取授权码？")))) : null,

        // ── 工具栏：搜索 + 筛选 ──
        h("div", { className: "dsc-row", style: { gap: 6, marginBottom: 8 } },
          h("input", { className: "dsc-input", style: { flex: 1, minWidth: 100 }, placeholder: "搜索主题/发件人/正文", value: kw, onChange: (e) => setKw(e.target.value) }),
          h(Btn, { kind: "mini", onClick: () => setKw("") }, "清空")),
        // 0.7.1：多账号收信 —— 只在配了 2 个以上账号时出现，单账号不占地方
        (accounts.length > 1
          ? h("div", { className: "dsc-row", style: { gap: 6, marginBottom: 8 } },
              h("span", { className: "dsc-muted", style: { fontSize: 12, flex: "0 0 auto" } }, "邮箱"),
              h("select", { className: "dsc-input", style: { flex: 1, height: 28 }, value: acctFilter, onChange: (e) => setAcctFilter(e.target.value) },
                h("option", { value: "" }, "全部邮箱（" + accounts.length + " 个账号）"),
                accounts.map((a) => h("option", { key: a.id, value: a.id }, (a.label || a.email) + " <" + a.email + ">" + (a.enabled ? "" : "（已停用）")))))
          : null),
        h("div", { className: "dsc-row", style: { gap: 6, marginBottom: 8 } },
          h(Btn, { kind: tab === "all" ? "mini pri" : "mini ghost", onClick: () => setTab("all") }, "全部 " + live.length),
          h(Btn, { kind: tab === "unread" ? "mini pri" : "mini ghost", onClick: () => setTab("unread") }, "未读 " + unread),
          h(Btn, { kind: tab === "star" ? "mini pri" : "mini ghost", onClick: () => setTab("star") }, "★ 收藏 " + starredCount),
          h(Btn, { kind: tab === "spam" ? "mini pri" : "mini ghost", onClick: () => setTab("spam") }, "垃圾 " + spamCount),
          h(Btn, { kind: tab === "trash" ? "mini pri" : "mini ghost", onClick: () => setTab("trash") }, "垃圾箱 " + trashCount),
          h(Btn, { kind: tab === "sent" ? "mini pri" : "mini ghost", onClick: () => setTab("sent") }, "已发送 " + items.filter((m) => m && m.folder === "sent").length),
          h(Btn, { kind: tab === "draft" ? "mini pri" : "mini ghost", onClick: () => setTab("draft") }, "草稿 " + drafts.length)),

        // ── 写信面板 ──
        compose ? h("div", { className: "dsc-card", style: { marginBottom: 6 } },
          h("div", { className: "dsc-sec-h" }, bulk ? "群发邮件" : "写邮件", h("span", { className: "sp" },
            h(Btn, { kind: "mini ghost", onClick: saveDraft, title: "存到草稿箱，稍后接着写" }, "存草稿"),
            h(Btn, { kind: "mini ghost", onClick: () => setCompose(null) }, "取消"))),
          h("div", { className: "dsc-row", style: { gap: 6, marginBottom: 6 } },
            h("span", { className: "dsc-muted", style: { fontSize: 12, width: 42 } }, "收件人"),
            h("input", {
              className: "dsc-input", style: { flex: 1 },
              placeholder: bulk ? "多个地址用逗号/分号/换行分隔（每人单独一封）" : "a@example.com，多个用逗号分隔",
              value: compose.to,
              onFocus: () => { if (!String(compose.to || "").trim() && contacts.length) { setPickTo("to"); setShowContacts(true); } },
              onChange: (e) => setCompose({ ...compose, to: e.target.value }),
            }),
            h(Btn, { kind: "mini ghost", onClick: () => { setPickTo("to"); setShowContacts(true); }, title: "从联系人选择（可新增/删除）" }, "👤 联系人"),
            h(Btn, { kind: bulk ? "mini pri" : "mini ghost", onClick: () => { setBulk(!bulk); setProg(""); }, title: "群发：把收件人拆开，逐个单独发送" }, bulk ? "群发 开" : "群发")),
          h("div", { className: "dsc-row", style: { gap: 6, marginBottom: 6 } },
            h("span", { className: "dsc-muted", style: { fontSize: 12, width: 42 } }, "抄送"),
            h("input", {
              className: "dsc-input", style: { flex: 1 }, placeholder: "可选，点右侧或聚焦本框选联系人",
              value: compose.cc,
              onFocus: () => { if (!String(compose.cc || "").trim() && contacts.length) { setPickTo("cc"); setShowContacts(true); } },
              onChange: (e) => setCompose({ ...compose, cc: e.target.value }),
            }),
            h(Btn, { kind: "mini ghost", onClick: () => { setPickTo("cc"); setShowContacts(true); }, title: "从联系人选择填到抄送" }, "👤 抄送人")),
          // 0.7.1：多账号发信 —— 有 2 个以上启用账号时才出现，选哪封就从哪个邮箱发出去
          (accounts.filter((a) => a.enabled).length > 1
            ? h("div", { className: "dsc-row", style: { gap: 6, marginBottom: 6 } },
                h("span", { className: "dsc-muted", style: { fontSize: 12, width: 42 } }, "发件"),
                h("select", { className: "dsc-input", style: { flex: 1, height: 28 }, value: fromId, onChange: (e) => setFromId(e.target.value) },
                  accounts.filter((a) => a.enabled).map((a) => h("option", { key: a.id, value: a.id }, (a.label || a.email) + " <" + a.email + ">"))))
            : null),
          (bulk ? h("div", { className: "dsc-row", style: { gap: 6, marginBottom: 6, alignItems: "center" } },
            h("span", { className: "dsc-muted", style: { fontSize: 12, width: 42 } }, "间隔"),
            h("input", { className: "dsc-input", style: { width: 70 }, type: "number", min: 1, max: 120, value: gapSec, onChange: (e) => setGapSec(Math.max(1, Math.min(120, Number(e.target.value) || 1))) }),
            h("span", { className: "dsc-muted", style: { fontSize: 11.5 } }, "秒/封（防判垃圾邮件）"),
            prog ? h("span", { style: { fontSize: 11.5, color: "var(--sub)", flex: 1, textAlign: "right" } }, prog) : null) : null),
          h("div", { className: "dsc-row", style: { gap: 6, marginBottom: 6 } },
            h("span", { className: "dsc-muted", style: { fontSize: 12, width: 42 } }, "主题"),
            h("input", { className: "dsc-input", style: { flex: 1 }, placeholder: "邮件主题", value: compose.subject, onChange: (e) => setCompose({ ...compose, subject: e.target.value }) })),
          h("textarea", { className: "dsc-input", style: { width: "100%", minHeight: 120, resize: "vertical", lineHeight: 1.6 }, placeholder: "正文（纯文本）", value: compose.text, onChange: (e) => setCompose({ ...compose, text: e.target.value }) }),
          h("div", { className: "dsc-row", style: { gap: 6, marginTop: 6, alignItems: "center", flexWrap: "wrap" } },
            h(Btn, { kind: "mini ghost", onClick: pickFiles }, "＋ 附件"),
            ((compose.attachments || []).length
              ? h("span", { className: "dsc-muted", style: { fontSize: 11.5, flex: 1 } }, (compose.attachments || []).length + " 个 · 共 " + kb((compose.attachments || []).reduce((s2, a) => s2 + (a.size || 0), 0)))
              : h("span", { className: "dsc-muted", style: { fontSize: 11.5, flex: 1 } }, "单个 ≤8MB，合计 ≤20MB")),
            ((compose.attachments || []).length
              ? h(Btn, { kind: "mini ghost", onClick: () => setCompose({ ...compose, attachments: [] }) }, "清空")
              : null)),
          ((compose.attachments || []).length
            ? h("div", { className: "dsc-row", style: { marginTop: 6, gap: 6 } }, (compose.attachments || []).map((a, i) => {
                const b = attBadge(a.filename, a.contentType);
                return h("span", { key: i, title: a.filename + " · " + kb(a.size), style: { display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 5px 3px 3px", borderRadius: 8, border: "1px solid var(--line)", background: "rgba(255,255,255,.5)", maxWidth: "100%" } },
                  (a.dataUrl
                    ? h("img", { src: a.dataUrl, alt: a.filename, onClick: () => setPreview({ url: a.dataUrl, name: a.filename }), style: { width: 26, height: 26, borderRadius: 6, objectFit: "cover", cursor: "zoom-in", flex: "0 0 auto" } })
                    : h("span", { style: { width: 26, height: 26, borderRadius: 6, background: b.bg, color: b.c, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, letterSpacing: 0.2, flex: "0 0 auto" } }, b.t)),
                  h("span", { style: { fontSize: 11.5, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, a.filename),
                  h("span", { className: "dsc-muted", style: { fontSize: 11.5, flex: "0 0 auto" } }, kb(a.size)),
                  h("span", { title: "移除", onClick: () => setCompose({ ...compose, attachments: (compose.attachments || []).filter((_, j) => j !== i) }), style: { cursor: "pointer", color: "var(--sub)", fontSize: 13, lineHeight: 1, padding: "0 2px", flex: "0 0 auto" } }, "×"));
              }))
            : null),
          h("div", { className: "dsc-row", style: { marginTop: 8, gap: 6, justifyContent: "flex-end" } },
            h(Btn, { kind: "mini pri", onClick: async () => {
              if (sending) return;
              const c = compose;
              const raw = String(c.to || "").trim();
              if (!raw) { setMsg("请填收件人"); return; }
              const atts = (c.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, base64: a.base64 }));
              const list = raw.split(/[,;，；\s]+/).filter(Boolean);
              setSending(true);
              // ── 单封 ──
              if (!bulk || list.length <= 1) {
                const r = await post("/mail/send", { to: raw, cc: c.cc, subject: c.subject, text: c.text, attachments: atts, accountId: fromId || undefined });
                setSending(false);
                if (r && r.ok) {
                  collectContacts(list);
                  setCompose(null);
                  setMsg("已发送 ✓" + (atts.length ? "（含 " + atts.length + " 个附件）" : "") + (r.ms ? " · " + r.ms + "ms" : ""));
                } else {
                  // 失败必须显式报出来：旧版这里只有 if-ok 分支，点发送「没反应」就是这么来的
                  setMsg("发送失败：" + String((r && r.error) || "宿主没响应 /mail/send —— 请彻底退出 DSH 再启动（不是刷新，是退出进程）"));
                }
                return;
              }
              // ── 群发：逐个单独发（每人一封，收件人之间互相看不到）──
              let ok = 0; const bad = [];
              for (let i = 0; i < list.length; i++) {
                setProg("群发 " + (i + 1) + "/" + list.length);
                const r = await post("/mail/send", { to: list[i], cc: c.cc, subject: c.subject, text: c.text, attachments: atts, accountId: fromId || undefined });
                if (r && r.ok) ok++; else bad.push(list[i] + "：" + String((r && r.error) || "无响应"));
                if (i < list.length - 1) await new Promise((s2) => setTimeout(s2, Math.max(1, gapSec) * 1000));
              }
              setSending(false);
              collectContacts(list);
              setProg("");
              if (ok) {
                setMsg("群发完成 ✓ 成功 " + ok + "/" + list.length + (bad.length ? "；失败 " + bad.length + "：" + bad.slice(0, 3).join("；") : ""));
                if (!bad.length) setCompose(null);
              } else {
                setMsg("群发全部失败：第一封 " + (bad[0] || "无响应") + " —— 宿主没响应 /mail/send 时请彻底退出 DSH 再启动");
              }
            } }, sending ? "发送中…" : (bulk ? "群发 " + (String(compose.to || "").split(/[,;，；\s]+/).filter(Boolean).length || 0) + " 封" : "发送")))) : null,

        // ── 列表（草稿箱单独渲染：本地 store.drafts，不进邮件列表）──
        (tab === "draft"
          ? h("div", { className: "dsc-sec-h" }, "草稿箱（" + drafts.length + " 封）")
          : h("div", { className: "dsc-sec-h" }, (tab === "sent" ? "已发送" : tab === "unread" ? "未读邮件" : "收件箱") + "（" + filtered.length + " 封）")),
        (tab === "draft"
          ? (drafts.length
              ? drafts.map((d) => h("div", { key: d.id, className: "dsc-item", style: { cursor: "pointer" }, onClick: () => openDraft(d) },
                  h("div", { style: { flex: 1, minWidth: 0, fontWeight: 400 } },
                    h("div", { className: "t" }, (d.subject || "(无主题)") + ((d.attachments || []).length ? " 📎" : "")),
                    h("div", { className: "m" }, "发给 " + (d.to || "（空）") + " · " + timeStr(d.at) + ((d.attachments || []).length ? " · 附件 " + d.attachments.length + " 个（需重选）" : ""))),
                  h("span", { title: "删除草稿", onClick: (e) => { e.stopPropagation(); delDraft(d.id); setMsg("已删除草稿"); }, style: { cursor: "pointer", color: "var(--sub)", fontSize: 14, padding: "0 6px", flex: "0 0 auto" } }, "×")))
              : h("div", { className: "dsc-card dsc-empty" }, "草稿箱是空的：写信时点「存草稿」就存到这里"))
          : (filtered.length ? filtered.map((m, i) => {
              const from = (m.from && (m.from.name || m.from.address)) || m.fromAddress || "未知发件人";
              const isUnread = m.folder !== "sent" && m.seen !== true;
              // 标记位按「收藏 / 垃圾 / 垃圾箱 / 未读 / 附件」顺序排，一眼能分清状态
              const mark = (m.starred === true ? "★ " : "") + (m.spam === true ? "🚫 " : "") + (m.trashed === true ? "🗑 " : "") + (isUnread ? "● " : "") + (m.hasAttach ? "📎 " : "");
              return h("div", { key: m.seq || i, className: "dsc-item " + (isUnread ? "dsc-unread" : "dsc-read"), style: { cursor: "pointer", fontWeight: isUnread ? 700 : 400 }, onClick: () => openMail(m) },
                h("div", { style: { flex: 1, minWidth: 0 } },
                  h("div", { className: "t" }, mark + (m.subject || "(无主题)")),
                  h("div", { className: "m" }, (accounts.length > 1 && m.accountLabel ? "[" + m.accountLabel + "] " : "") + (m.folder === "sent" ? "发给 " : "") + from + (m.date ? " · " + timeStr(m.date) : ""))),
                // 行内快捷操作：收藏 / 垃圾 / 垃圾箱（垃圾箱里换成还原 + 彻底删除）
                h("span", { className: "dsc-mail-ops" },
                  h("span", { title: m.starred ? "取消收藏" : "收藏", onClick: (e) => { e.stopPropagation(); post("/mail/star", { seq: m.seq, starred: m.starred !== true }); }, style: { cursor: "pointer", color: m.starred === true ? "#f5a623" : "var(--sub)" } }, m.starred === true ? "★" : "☆"),
                  (m.trashed === true
                    ? h("span", { title: "还原到收件箱", onClick: (e) => { e.stopPropagation(); post("/mail/restore", { seq: m.seq }); }, style: { cursor: "pointer", color: "var(--sub)" } }, "↩")
                    : h("span", { title: m.spam === true ? "不是垃圾，移回收件箱" : "标记为垃圾邮件", onClick: (e) => { e.stopPropagation(); post("/mail/spam", { seq: m.seq, spam: m.spam !== true }); }, style: { cursor: "pointer", color: m.spam === true ? "#d93025" : "var(--sub)" } }, "🚫")),
                  (m.trashed === true
                    ? h("span", { title: "彻底删除（本地 + 服务器）", onClick: (e) => { e.stopPropagation(); if (window.confirm("彻底删除这封邮件？删除后不可还原")) post("/mail/delete", { seq: m.seq }); }, style: { cursor: "pointer", color: "#d93025" } }, "×")
                    : h("span", { title: "移到垃圾箱", onClick: (e) => { e.stopPropagation(); post("/mail/trash", { seq: m.seq }); }, style: { cursor: "pointer", color: "var(--sub)" } }, "🗑"))));
            }) : h("div", { className: "dsc-card dsc-empty" }, kw ? "没有匹配「" + kw + "」的邮件" : tab === "trash" ? "垃圾箱是空的" : tab === "spam" ? "没有标记为垃圾的邮件" : tab === "star" ? "还没有收藏的邮件" : "暂无邮件"))),

        // ── 详情（0.6.7：覆盖层，盖住页面读，不把列表滚走）──
        sel ? h("div", {
          className: "dsc-mail-ov",
          onMouseDown: (e) => { if (e.target === e.currentTarget) setSel(null); },
        }, h("div", { className: "dsc-card dsc-mail-ov-card", id: "dsc-mail-detail" },
          // 0.7.2：标题 + 操作按钮固定在卡片最上面一排（横排、可换行），正文自己滚动，长正文不再把按钮挤成竖列
          h("div", { className: "dsc-mail-ovhead" },
            h("div", { className: "dsc-mail-ovsub", title: sel.subject || "" }, (sel.subject || "(无主题)")),
            h(Btn, { kind: "mini ghost", onClick: () => setSel(null), title: "关闭（Esc 也可）" }, "✕ 关闭")),
          h("div", { className: "dsc-mail-ovbtns" },
            h(Btn, { kind: "mini ghost", onClick: () => post("/mail/star", { seq: sel.seq, starred: sel.starred !== true }) }, sel.starred === true ? "★ 已收藏" : "☆ 收藏"),
            h(Btn, { kind: "mini ghost", onClick: () => post("/mail/mark-read", { seq: sel.seq, seen: sel.seen !== true }) }, sel.seen === true ? "标为未读" : "标为已读"),
            (sel.trashed === true
              ? h(Btn, { kind: "mini ghost", onClick: () => post("/mail/restore", { seq: sel.seq }) }, "↩ 还原")
              : h(Btn, { kind: "mini ghost", onClick: () => post("/mail/spam", { seq: sel.seq, spam: sel.spam !== true }) }, sel.spam === true ? "不是垃圾" : "标记垃圾")),
            (sel.trashed === true
              ? h(Btn, { kind: "mini ghost", onClick: () => { if (window.confirm("彻底删除这封邮件？删除后不可还原")) post("/mail/delete", { seq: sel.seq }).then((r) => { if (r && r.ok) setSel(null); }); } }, "× 彻底删除")
              : h(Btn, { kind: "mini ghost", onClick: () => post("/mail/trash", { seq: sel.seq }) }, "🗑 删除"))),
          h("div", { className: "dsc-muted", style: { fontSize: 12, marginBottom: 6 } },
            ((sel.from && (sel.from.name || sel.from.address)) || "") + (sel.folder === "sent" ? " · 已发送" : "") + " · " + (sel.date ? new Date(sel.date).toLocaleString("zh-CN") : "")),
          // 正文区：占满卡片剩余高度、自己滚动，头部按钮永不跟着滚走
          h("div", { id: "dsc-mail-body", style: { flex: "1 1 auto", minHeight: 90, overflow: "auto", fontSize: 12, lineHeight: 1.8, whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "2px 4px 2px 0" } },
            linkify(bodyText || sel.preview || sel.snippet || "(这封邮件没有可显示的文字正文，可能整封都是图片。)")),
          (bodyText && String(bodyText).length < 60 && sel.hasAttach && !(sel.attachments || []).length)
            ? h("div", { className: "dsc-muted", style: { fontSize: 11.5, marginTop: 4 } }, "正文很短，主要内容和图片可能在附件里（这封是旧记录，重开一次会重新收附件）。")
            : null,
          ((sel.attachments || []).length
            ? h("div", { style: { marginTop: 8, borderTop: "1px dashed var(--line)", paddingTop: 6 } },
                h("div", { className: "dsc-muted", style: { fontSize: 11.5, marginBottom: 4 } }, "附件 " + (sel.attachments || []).length + " 个 · 点图片看大图，↗ 用系统默认应用打开"),
                h("div", { className: "dsc-row", style: { gap: 6, flexWrap: "wrap" } },
                  (sel.attachments || []).map((a) => {
                    const url = apiUrl("/mail/attach", "seq=" + sel.seq + "&i=" + a.i);
                    const b = attBadge(a.filename, a.contentType);
                    const isImg = /^image\//i.test(a.contentType || "") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename || "");
                    const hasFile = !!a.file;
                    // 0.7.2：交给 Windows 默认关联程序（宿主 spawn cmd start）；浏览器里 window.open 唤不起本地程序
                    const openSys = () => post("/mail/attach-open", { seq: sel.seq, i: a.i }).then((r) => { if (r && r.ok) setMsg("已用系统默认应用打开：" + a.filename); else setMsg("打不开：" + a.filename + " —— " + ((r && r.error) || "宿主没加载 /mail/attach-open，要彻底退出 DSH 再启动")); });
                    return h("span", { key: a.i, title: a.filename + " · " + kb(a.size), style: { display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 6px 3px 3px", borderRadius: 8, border: "1px solid var(--line)", background: "rgba(255,255,255,.5)", maxWidth: "100%" } },
                      (isImg && hasFile
                        ? h("img", { src: url, alt: a.filename, onClick: () => setPreview({ url, name: a.filename }), style: { width: 26, height: 26, borderRadius: 6, objectFit: "cover", cursor: "zoom-in", flex: "0 0 auto", background: "rgba(0,0,0,.04)" } })
                        : h("span", { onClick: openSys, title: "用系统默认应用打开", style: { width: 26, height: 26, borderRadius: 6, background: b.bg, color: b.c, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, cursor: "pointer", flex: "0 0 auto" } }, b.t)),
                      h("span", { onClick: openSys, title: "用系统默认应用打开", style: { cursor: "pointer", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 170 } }, a.filename),
                      h("span", { className: "dsc-muted", style: { fontSize: 11 } }, kb(a.size)),
                      h("span", { onClick: openSys, title: "用系统默认应用打开", style: { cursor: "pointer", fontSize: 12, color: "var(--sub)", padding: "0 2px", flex: "0 0 auto" } }, "↗"));
                  })))
            : null))) : null,

        // ── 联系人弹层（点选填入收件人，可搜索、可新增、可删除）──
        (showContacts
          ? h("div", { onClick: () => setShowContacts(false), className: "dsc-contacts-ov", style: { position: "fixed", inset: 0, zIndex: 9998, background: "rgba(10,14,22,.40)", backdropFilter: "blur(12px) saturate(1.06)", WebkitBackdropFilter: "blur(12px) saturate(1.06)", display: "flex", padding: 16, overflow: "auto" } },
              h("div", { onClick: (e) => e.stopPropagation(), className: "dsc-card", style: { margin: "auto", width: "100%", maxWidth: 460, maxHeight: "86vh", display: "flex", flexDirection: "column", boxShadow: "0 18px 50px rgba(8,12,20,.32)" } },
                h("div", { className: "dsc-sec-h" }, "联系人（" + contacts.length + "）", h("span", { className: "sp" }, h(Btn, { kind: "mini ghost", onClick: () => setShowContacts(false) }, "关闭"))),
                h("input", { className: "dsc-input", style: { width: "100%", marginBottom: 6 }, placeholder: "搜索姓名 / 邮箱", value: contactQ, onChange: (e) => setContactQ(e.target.value) }),
                h("div", { style: { flex: 1, minHeight: 56, maxHeight: 240, overflow: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 4 } },
                  (() => {
                    const q = contactQ.trim().toLowerCase();
                    const list = q ? contacts.filter((x) => String(x.name || "").toLowerCase().indexOf(q) >= 0 || String(x.email || "").toLowerCase().indexOf(q) >= 0) : contacts;
                    if (!list.length) return h("div", { className: "dsc-muted", style: { fontSize: 11.5, padding: 8 } }, contacts.length ? "没有匹配「" + contactQ + "」的联系人" : "还没有联系人，下面填一个吧");
                    return list.map((x) => h("div", { key: x.id, className: "dsc-contact-row", onClick: () => pickContact(x) },
                      h("span", { style: { fontWeight: 600, fontSize: 12, minWidth: 56, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, x.name || "—"),
                      h("span", { className: "dsc-muted", style: { fontSize: 11.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, x.email),
                      h("span", { title: "删除联系人", onClick: (e) => { e.stopPropagation(); delContact(x.id); }, style: { cursor: "pointer", color: "var(--sub)", fontSize: 13, padding: "0 4px" } }, "×")));
                  })()),
                h("div", { className: "dsc-row", style: { marginTop: 6, gap: 5 } },
                  h("input", { className: "dsc-input", style: { width: 84 }, placeholder: "姓名", value: cName, onChange: (e) => setCName(e.target.value) }),
                  h("input", { className: "dsc-input", style: { flex: 1 }, placeholder: "邮箱 someone@example.com", value: cEmail, onChange: (e) => setCEmail(e.target.value) }),
                  h(Btn, { kind: "mini pri", onClick: addContact }, "保存"))))
          : null),

        // ── 附件预览浮层（点图片看大图，点任意处关闭）──
        (preview
          ? h("div", { onClick: () => setPreview(null), style: { position: "fixed", inset: 0, zIndex: 9999, background: "rgba(8,12,18,.74)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, cursor: "zoom-out" } },
              h("img", { src: preview.url, alt: preview.name || "", style: { maxWidth: "92vw", maxHeight: "88vh", borderRadius: 10, boxShadow: "0 16px 48px rgba(0,0,0,.55)", background: "#fff" } }))
          : null));
    }

    function ScheduleTab(props) {
      const { ctx } = props;
      const { store, status, err, update, reload } = useStore();
      const [nav, setNav] = useState("today");
      const [now, setNow] = useState(new Date());
      const [adding, setAdding] = useState(null);
  /* 0.9.0：面板自带的「使用说明 / 快速上手」入口（技能硬闸门：带 UI 的插件必须有帮助入口） */
  const [help, setHelp] = useState(false);
      const [alert, setAlert] = useState("");
      /* 0.9.1：面板内「胶囊」提醒条 —— 像悬浮球一样浮在面板右上角，停留 settings.reminderSeconds 秒自动消失，点一下立即关 */
      // 0.9.2：胶囊浮层是模块级 DOM（挂 body 上），整个 DSH 界面可见，不限于侧边栏；这里只做一次投递
      const pushCap = (item) => pushCaps(item, (store && store.settings) || CAP_SETTINGS);
      const fired = useRef({});
      const alertTimer = useRef(null);

      useEffect(() => {
        // 只有「今日」页需要秒级倒计时。以前是全面板 1s 一次 setState，会把当前页整棵树（比如邮件页 23 条列表）
        // 一起重算 —— 实测 renderer 单核 25%、GPU 进程 33%（2026-11-12 采样）。非今日页降到 30s 走一次，够处理跨天换日。
        const ms = nav === "today" ? 1000 : 30000;
        const t = setInterval(() => setNow(new Date()), ms);
        return () => clearInterval(t);
      }, [nav]);
      const diyCfg = (store && store.settings && store.settings.diy) || {};
      const [wallList, setWallList] = useState([]);
      const [wallIdx, setWallIdx] = useState(0);
      const [bgUrls, setBgUrls] = useState(["", ""]);
      const [bgFront, setBgFront] = useState(0);
      // 0.8.7：轮播顺序（seq 顺序 / rand 随机）与两个"当前真实状态"的 ref。
      // ref 是必须的：轮播要在不依赖闭包旧值的前提下知道"现在前台是哪层、是第几张"。
      const frontRef = useRef(0);
      const curNameRef = useRef("");   // 当前正在显示的文件名（不靠闭包、不靠下标，换目录/排序都不会错位）
      const bagRef = useRef([]);       // 随机模式的「洗牌队列」：一轮里每个文件只出一次
      const wallOrder = diyCfg && diyCfg.order === "rand" ? "rand" : "seq";
      useEffect(() => {
        if (!diyCfg.enabled || !diyCfg.dir) { setWallList([]); setWallIdx(0); return; }
        let cancelled = false;
        getJson(apiUrl("/wallpapers", "dir=" + encodeURIComponent(diyCfg.dir)))
          .then((j) => { if (!cancelled) { setWallList((j && j.files) || []); setWallIdx(0); } })
          .catch(() => { if (!cancelled) setWallList([]); });
        return () => { cancelled = true; };
      }, [diyCfg.enabled, diyCfg.dir]);
      const wallUrlOfName = (nm) => apiUrl("/wallpaper", "dir=" + encodeURIComponent(diyCfg.dir) + "&name=" + encodeURIComponent(nm));
      // 0.8.7 修「换图发白」：旧实现让「首图 effect」和「轮播 setInterval」同时往 bgUrls 里抢写，
      // 切图瞬间两层可能都处于"背景图还在下载 = 该层空"的状态 → 露出白底闪一下。
      // 现在两条通道彻底分开，且**一律 preload 完成（onload/onerror）之后才切层**，
      // 切层时用 opacity 交叉淡入：新层淡入的同时旧层淡出，任何一帧都至少有一层是实图。
      useEffect(() => {
        if (!wallList.length) { setBgUrls(["", ""]); setBgFront(0); frontRef.current = 0; curNameRef.current = ""; bagRef.current = []; return; }
        let cancelled = false;
        curNameRef.current = wallList[0];
        bagRef.current = [];
        const url = wallUrlOfName(wallList[0]);
        const img = new Image();
        const put = () => {
          if (cancelled) return;
          setBgUrls((prev) => { const nx = prev.slice(); nx[0] = url; return nx; });
          frontRef.current = 0;
          setBgFront(0);
        };
        img.onload = put;
        img.onerror = put;
        img.src = url;
        return () => { cancelled = true; };
      }, [wallList, diyCfg.dir]);
      // 0.8.8：随机模式不再用「随机数硬撞」（只保证不与当前那张相同，仍会撞回刚播过的），
      // 改成**洗牌队列**：把整个列表洗一遍依次放，一轮里每张只出现一次；
      // 一轮放完才重新洗牌，且新一轮第一张不与上一轮最后一张相同。
      useEffect(() => {
        if (wallList.length < 2) return;
        const n = wallList.length;
        const sec = Math.max(1, Number(diyCfg.intervalSec) || 30);
        const rand = wallOrder === "rand";
        let cancelled = false;
        let timer = null;
        const shuffle = (arr) => {
          const a = arr.slice();
          for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
          return a;
        };
        const pickNextName = () => {
          const cur = curNameRef.current;
          if (!rand) {
            const i = wallList.indexOf(cur);
            return wallList[i >= 0 ? (i + 1) % n : 0];
          }
          let bag = bagRef.current.filter((nm) => wallList.indexOf(nm) >= 0 && nm !== cur);
          if (!bag.length) {
            bag = shuffle(wallList);
            if (n > 1 && bag[0] === cur) { const t = bag[0]; bag[0] = bag[1]; bag[1] = t; }
          }
          const next = bag.shift();
          bagRef.current = bag;
          return next;
        };
        const step = () => {
          const nextName = pickNextName();
          const url = wallUrlOfName(nextName);
          const img = new Image();
          const apply = () => {
            if (cancelled) return;
            curNameRef.current = nextName;
            const back = 1 - frontRef.current;
            setBgUrls((prev) => { const nx = prev.slice(); nx[back] = url; return nx; });
            frontRef.current = back;
            setBgFront(back);
            timer = setTimeout(step, sec * 1000);
          };
          img.onload = apply;
          img.onerror = apply;
          img.src = url;
        };
        timer = setTimeout(step, sec * 1000);
        return () => { cancelled = true; clearTimeout(timer); };
      }, [wallList, diyCfg.intervalSec, diyCfg.dir, wallOrder]);

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
          /* 以前是「整分相等」判定：面板那一刻没开着就永远错过。改成 10 分钟窗口 + 当日去重，
             宿主侧也会独立扫一遍并发系统通知（lib/index.js 的 scanReminders）。 */
          const wMin = now.getHours() * 60 + now.getMinutes();
          const wStart = sh * 60 + sm, wEnd = eh * 60 + em;
          if (wMin >= wStart && wMin <= wStart + 10) due.push({ key: "ws-" + tk, msg: "该上班啦（" + person.name + " " + sc.workStart + "）" });
          if (wMin >= wEnd && wMin <= wEnd + 10) due.push({ key: "we-" + tk, msg: "该下班啦（" + person.name + " " + sc.workEnd + "）" });
        }
        const occ = occurrencesForDate(tk, store.events, lunarTodayDays);
        // 健康/趣味提醒：久坐 · 喝水(科学) · 摸鱼/护眼 · 听音乐 · 自定义
        {
          const rems = store.settings.reminders || [];
          const nowMin = now.getHours() * 60 + now.getMinutes();
          for (const rm of rems) {
            if (!rm || !rm.enabled) continue;
            const parseHM = (t) => { const a = String(t || "00:00").split(":").map(Number); return (a[0] || 0) * 60 + (a[1] || 0); };
            const sMin = parseHM(rm.start || "00:00"), eMin = parseHM(rm.end || "23:59");
            const iv = Math.max(5, Number(rm.intervalMin) || 60);
            if (nowMin < sMin || nowMin >= eMin) continue;
            const slot = Math.floor((nowMin - sMin) / iv);
            if (slot < 0 || nowMin !== sMin + slot * iv) continue;
            const key = "rm-" + rm.id + "-" + tk + "-" + slot;
            if (fired.current[key]) continue;
            fired.current[key] = true;
            let extra = "";
            if (rm.type === "drink") {
              const dk = store.settings.drink || {};
              const totalMl = dk.totalMl || 2100;
              const cups = dk.cups || 9;
              extra = "（每次约 " + Math.round(totalMl / cups) + "ml，今天共 " + cups + " 次，合计约 " + totalMl + "ml）";
            }
            due.push({ key: key, msg: (rm.emoji ? rm.emoji + " " : "") + (rm.name || "提醒") + "：" + (rm.msg || "休息一下～") + extra });
          }
        }
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

      const goAdd = (date, mode) => { setAdding({ date: date || todayKey(), mode: mode || "none" }); };

      if (status === "loading") return h("div", { className: "dsc-root" }, h("div", { className: "dsc-body dsc-empty" }, "日程助手加载中…"));
      if (status === "error" || !store) return h("div", { className: "dsc-root" }, h("div", { className: "dsc-body" }, h("div", { className: "dsc-empty" }, "加载失败：" + (err || "未知错误")), h("div", { style: { textAlign: "center" } }, h(Btn, { onClick: reload }, "重试"))));

      const tk = dateKey(now);
      const lToday = lunarNow.days && lunarNow.days[tk];
      const holToday = holidaysNow[tk];
      const ws = workStatus(person, now);
      const navItems = [["today", "今日"], ["calendar", "日历"], ["events", "日程"], ["mail", "邮件"], ["todos", "待办"], ["reports", "报告"], ["settings", "设置"]];

      const _vRaw = (diyCfg.veil == null ? 0.18 : Number(diyCfg.veil));
      // 蒙层浓度下限从 0.45 放到 0.12：壁纸不再被一层白色雾糊住（用户 2026-11-12 反馈）
      const _vSafe = Math.min(0.92, Math.max(0.12, isFinite(_vRaw) ? _vRaw : 0.18));
      const veilA = String(_vSafe);
      const toneVars = textVars(store.settings.textTone, store.settings.textColor);
      return h("div", { className: "dsc-root" + (wallList.length ? " has-bg" : "") + (wallList.length && diyCfg.frost === false ? " no-frost" : ""), style: toneVars || undefined },
        (wallList.length ? [0, 1].map((li) => h("div", {
          key: "bg" + li,
          className: "dsc-bglayer",
          style: {
            backgroundImage: bgUrls[li] ? ("url(" + bgUrls[li] + ")") : "none",
            opacity: (li === bgFront && bgUrls[li]) ? 1 : 0,
            zIndex: (li === bgFront ? 2 : 1),
          },
        })) : null),
        // 0.8.7：壁纸还没就位（首图下载中）时不挂白雾层 —— 否则页面一打开/一刷新会先白一下
        ((bgUrls[0] || bgUrls[1]) ? h("div", { className: "dsc-bgscrim", style: { background: "rgba(var(--dsc-scrim-rgb), " + veilA + ")" } }) : null),
        h("div", { className: "dsc-head" },
          h("div", null,
            h("div", { className: "dsc-hdate" }, now.getMonth() + 1 + "月" + now.getDate() + "日 " + WD[now.getDay()] + (function () { const p = [lToday ? "农历" + lToday.monthCn + lToday.dayCn : "", lToday && lToday.term ? lToday.term : "", holToday ? holToday.name : ""].filter(Boolean); if (store.settings.showAlmanac !== false && almanacToday) { p.push("宜：" + (almanacToday.yi || []).join("/") + " 忌：" + (almanacToday.ji || []).join("/")); } return p.length ? " · " + p.join(" · ") : ""; })())),
          h("div", { className: "dsc-pill" + (ws.rest ? " rest" : "") },
            ws.rest ? "今日休息" : h("span", null, ws.label + " ", h("small", null, fmtDur(ws.ms)))),
          h("button", { className: "dsc-btn mini", style: { marginLeft: 6 }, title: "使用说明 / 快速上手", onClick: () => setHelp(true) }, "?"),
          h("button", { className: "dsc-btn mini", style: { marginLeft: 6 }, onClick: () => { setNav("settings"); }, title: "设置" }, "⚙"),
          h("button", { className: "dsc-btn mini", id: "dsc-upd-btn", "data-dsh-upd": "dsh-schedule-calendar", style: { marginLeft: 6 }, title: "检查更新（有新版可一键安装，装完需彻底退出 DSH 再启动）" }, "⟳"),
          h("span", { "data-dsh-upd": "dsh-schedule-calendar", style: { fontSize: 10, color: "var(--sub)", marginLeft: 4, whiteSpace: "nowrap", cursor: "pointer" }, title: "点一下检查插件更新", onClick: () => { setNav("settings"); } }, "v" + VERSION)),
        store ? h("div", { className: "dsc-buffbar" },
          h("span", { className: "dsc-buff-ico" }, "🎁"),
          h("span", { className: "dsc-buff-txt" }, (store.settings.buff && store.settings.buff.date === dateKey(now)) ? ("今日Buff：「" + (store.settings.buff.text || "") + "」 · 连续签到 " + (store.settings.buff.streak || 0) + " 天") : "今日还没签到，点右侧签到得好运Buff"),
          h("span", { style: { flex: 1 } }),
          h(Btn, { kind: "mini pri", onClick: doCheckin }, (store.settings.buff && store.settings.buff.date === dateKey(now)) ? "已签到" : "签到")) : null,
        alert ? h("div", { className: "dsc-alert" }, "🔔 " + alert) : null,
        h("div", { className: "dsc-nav" }, navItems.map(([k, label]) => h("button", { key: k, className: nav === k ? "on" : "", onClick: () => setNav(k) }, label))),
        h("div", { className: "dsc-body" + (nav === "calendar" ? " dsc-fit" : "") },
          nav === "today" ? h(TodayView, { store, update, now, lunarToday: lunarNow.days, holidays: holidaysNow, goSettings: () => setNav("settings") }) : null,
          nav === "calendar" ? h(CalendarView, { store, update, now, goAdd, hasBg: wallList.length > 0 }) : null,
          nav === "events" ? h(EventsView, { store, update, goAdd }) : null,
          nav === "todos" ? h(TodosView, { store, update }) : null,
          nav === "reports" ? h(ReportsView, { store, update, now }) : null,
          nav === "mail" ? h(MailView, { now: now, store, update }) : null,
          nav === "settings" ? h(SettingsView, { store, update, reload, now, pushCap }) : null),
        // 0.6.3 添加日程改为覆盖层：盖在当前页之上，不切视图、不挤占日历
        adding ? h("div", { className: "dsc-overlay", onMouseDown: (e) => { if (e.target === e.currentTarget) setAdding(null); } },
          h(AddPanel, { store, update, init: adding, onClose: () => setAdding(null) })) : null,
        /* 0.9.0 使用说明（面板自带帮助入口）：讲「怎么用」，不讲开发细节；文案与 0.9.0 实际能力逐条对应 */
        help ? h("div", { className: "dsc-overlay", onMouseDown: (e) => { if (e.target === e.currentTarget) setHelp(false); } },
          h("div", { className: "dsc-card", style: { maxWidth: 620, maxHeight: "100%", overflow: "auto" } },
            h("div", { className: "dsc-sec-h" }, "使用说明 · 快速上手"),
            [
              ["日程与待办", "点日历任意一天（或在「日程」页新建）就能加日程：填标题、日期、时间，可设提前提醒。待办勾掉即完成，日报 / 周报按实际完成情况自动统计。"],
              ["邮件收信", "「邮件 → ⚙ 账号设置」里填邮箱与 IMAP 授权码后保存，可加多个账号（收件箱顶部按邮箱筛选）。授权码不是 QQ 密码：QQ 邮箱网页版 → 设置 → 账号 → 生成授权码。同一个邮箱只保存一次即可，重复保存会更新原账号而不是新增。"],
              ["写信 / 群发", "点 ✏ 写信；收件人可点「👤 联系人」从已保存联系人里选。点「群发」后收件人行填多个地址、设间隔秒数，会逐封发送以防判垃圾邮件。附件单封 ≤ 8MB、合计 ≤ 20MB。"],
              ["邮件整理", "星标收藏、标为已读 / 未读、标记垃圾、删除（本地删除并尽力同步邮箱服务器）、垃圾箱可还原、草稿箱存未写完的信（草稿里的附件需重新选择）。"],
              ["提醒", "设置 → 提醒：久坐 / 喝水 / 护眼 / 听音乐四条内置，可改间隔与时段；到点弹界面内「胶囊」（浮在整个 DSH 界面之上，停留秒数与弹出位置可调，点一下立即关），也能同时推 Windows 通知；可选自动弹出侧边栏。每条右侧「▶」可手动预览一次，不影响正式计时。"],
              ["壁纸与文字颜色", "设置 → 外观：填壁纸文件夹绝对路径并勾选启用，可调切换间隔、透明度、磨砂开关、顺序 / 随机（随机是一轮内不重复的洗牌）。黑字看不清就在同一页「文字颜色」切深色字 / 浅色字，或自定义取色。"],
              ["数据在哪", "全部保存在本机插件 data 目录的 JSON 里，不上传云端；换机时整目录复制即可带走。"],
            ].map((pair) => h("div", { key: pair[0], style: { marginBottom: 7 } },
              h("div", { style: { fontWeight: 700, fontSize: 12.5, marginBottom: 2 } }, pair[0]),
              h("div", { className: "dsc-muted", style: { fontSize: 12, lineHeight: 1.55 } }, pair[1]))),
            h("div", { className: "dsc-row", style: { marginTop: 8, justifyContent: "flex-end" } },
              h(Btn, { kind: "mini pri", onClick: () => setHelp(false) }, "知道了")))) : null);
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
      return pad(hh) + ":" + pad(mm) + ":" + pad(ss);
    }

    /* ============================ apply ============================ */
    function openSchedulePanel(ctx) {
      try { if (ctx.layout && ctx.layout.openRightbar) ctx.layout.openRightbar(true, false); } catch (e) { /* ignore */ }
      try { if (__safeSvc(ctx, "betterSidebar") && __safeSvc(ctx, "betterSidebar").openTab) __safeSvc(ctx, "betterSidebar").openTab({ type: NAME, title: "日程助手", reveal: true }); } catch (e) { /* ignore */ }
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

    // 2026-11-12：cordis 在服务未就绪时裸读 ctx.<service> 会抛，直接导致本 entry 判
    // "failed"；shared 服务名统一走这个安全取值器（取不到返回 undefined）。
    function __safeSvc(ctx, name) {
      try { return ctx[name]; } catch (e) { return undefined; }
    }
    // 官方扩展点写法（与 dsh-univer-office 一致）：服务晚到时用响应式注入，
    // cordis 会在 betterSidebar 就绪后自行运行回调；不再写进 exports.inject，
    // 否则服务慢就绪会让本 entry 永远 pending，整个 web boot 超时（11-12 崩溃）。
    function apply(ctx) {
      ctx.inject(["betterSidebar"], function (__sbCtx) {
        try { __applyReal(__sbCtx); }
        catch (e) { try { console.warn("[dsh] activate with betterSidebar failed:", e); } catch (e2) {} }
      });
    }

    function __applyReal(ctx) {
      if (__safeSvc(ctx, "betterSidebar") === undefined) {
        // 软依赖：服务晚到时最多等 30s 再挂，等不到就静默跳过，绝不把整个
        // web boot 拖死（2026-11-12 崩溃：declared inject 缺服务 → pending → 启动超时）。
        var __t = 0;
        var __tm = setInterval(function () {
          var __s = __safeSvc(ctx, "betterSidebar");
          if (__s === undefined && (++__t) < 60) return;
          try { clearInterval(__tm); } catch (e) {}
          if (__s !== undefined) { try { apply(ctx); } catch (e) {} }
        }, 500);
        return;
      }
      try { ensureStyles(); } catch (e) { /* ignore */ }
      // 到点提醒（久坐/喝水/摸鱼/听歌/自定义）：宿主每 60s 扫一次并发「胶囊」系统通知，
      // 这里只轮询增量，命中就把右侧栏自动弹出来并定位到「日程助手」（受 settings.reminderPopup 控制）。
      const syncCapSettings = async () => {
        try {
          const r = await fetch(apiUrl("/data"), { headers: { accept: "application/json" } });
          if (!r || !r.ok) return;
          const j = await r.json();
          const st = (j && j.data && j.data.settings) || null;
          if (st && typeof st === "object") CAP_SETTINGS = st;
          renderCaps(CAP_SETTINGS);
        } catch (e) { /* ignore */ }
      };
      try {
        syncCapSettings();
        const capCfgTimer = setInterval(syncCapSettings, 60000);
        if (ctx && ctx.effect) { try { ctx.effect(() => () => clearInterval(capCfgTimer)); } catch (e) { /* ignore */ } }
      } catch (e) { /* ignore */ }
      let lastSeq = 0;
      let remindFirst = true;
      const pollRemind = async () => {
        try {
          const r = await fetch(apiUrl("/remind/pending", "since=" + lastSeq), { headers: { accept: "application/json" } });
          if (!r || !r.ok) return;
          const j = await r.json();
          const next = Number(j && j.seq) || 0;
          const items = (j && j.items) || [];
          if (remindFirst) { lastSeq = next; remindFirst = false; return; } // 首轮只对齐游标，不补弹历史
          if (next > lastSeq) lastSeq = next;
          if (items.length) {
            // 0.9.2：胶囊浮在整个 DSH 界面（body 固定层），侧边栏展开与否都能看到
            try { items.forEach(function (it) { pushCaps(it, CAP_SETTINGS); }); } catch (e) { /* ignore */ }
            if (j.popup !== false) openSchedulePanel(ctx);
          }
        } catch (e) { /* 轮询失败静默，下一轮再来 */ }
      };
      try {
        const remindTimer = setInterval(pollRemind, 15000);
        if (ctx && ctx.effect) { try { ctx.effect(() => () => clearInterval(remindTimer)); } catch (e) { /* ignore */ } }
      } catch (e) { /* ignore */ }
      const bs = ctx && __safeSvc(ctx, "betterSidebar");
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
    exports.inject = ["slots", "layout"];
    exports.apply = apply;
    return module.exports;
  },
});
