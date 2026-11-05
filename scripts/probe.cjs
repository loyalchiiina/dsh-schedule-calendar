/* 本地探针：用迷你 React 运行时加载 client bundle，校验 apply 注册、主组件与各视图渲染无异常。
 * 仅用于开发自测，不随包发布。 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CLIENT = path.join(__dirname, "..", "lib", "client.js");
const SRC = fs.readFileSync(CLIENT, "utf8");

/* ---------- mini React ---------- */
let hookStates = [];
let hookIndex = 0;
let newEffects = [];
let dirty = false;
const hookStore = new Map();

function sameDeps(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const ReactShim = {
  createElement(type, props) {
    const children = [];
    for (let i = 2; i < arguments.length; i++) children.push(arguments[i]);
    const flat = [];
    (function walk(x) {
      if (x == null || x === false || x === true) return;
      if (Array.isArray(x)) return x.forEach(walk);
      flat.push(x);
    })(children);
    return { type: type, props: props || {}, children: flat };
  },
  Fragment: Symbol("Fragment"),
  useState(init) {
    const arr = hookStates;
    const i = hookIndex++;
    if (arr[i] === undefined) arr[i] = typeof init === "function" ? init() : init;
    const set = (v) => {
      const next = typeof v === "function" ? v(arr[i]) : v;
      if (next !== arr[i]) { arr[i] = next; dirty = true; }
    };
    return [arr[i], set];
  },
  useRef(init) {
    const arr = hookStates;
    const i = hookIndex++;
    if (arr[i] === undefined) arr[i] = { current: init };
    return arr[i];
  },
  useMemo(fn, deps) {
    const arr = hookStates;
    const i = hookIndex++;
    const prev = arr[i];
    if (prev && sameDeps(prev.deps, deps)) return prev.value;
    const value = fn();
    arr[i] = { value: value, deps: deps };
    return value;
  },
  useCallback(fn, deps) {
    const arr = hookStates;
    const i = hookIndex++;
    const prev = arr[i];
    if (prev && sameDeps(prev.deps, deps)) return prev.value;
    arr[i] = { value: fn, deps: deps };
    return fn;
  },
  useEffect(fn, deps) {
    const arr = hookStates;
    const i = hookIndex++;
    if (arr[i] === undefined) { arr[i] = { ran: true }; newEffects.push({ fn: fn }); }
  },
};

/* ---------- expand tree ---------- */
function expand(node) {
  if (node == null || node === false || node === true) return null;
  if (Array.isArray(node)) return node.map(expand).filter((x) => x != null);
  if (typeof node === "string" || typeof node === "number") return node;
  if (typeof node.type === "function") {
    const savedStates = hookStates;
    const savedIdx = hookIndex;
    let st = hookStore.get(node.type);
    if (!st) { st = { states: [] }; hookStore.set(node.type, st); }
    hookStates = st.states;
    hookIndex = 0;
    let out;
    try {
      out = node.type(node.props);
    } finally {
      st.states = hookStates;
      hookStates = savedStates;
      hookIndex = savedIdx;
    }
    return expand(out);
  }
  return { type: node.type, props: node.props, children: (node.children || []).map(expand).filter((x) => x != null) };
}

/* ---------- collect text / find button ---------- */
function textOf(node) {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return (node.children || []).map(textOf).join("");
}
function findButton(node, label) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "button" && textOf(node).trim() === label && node.props && typeof node.props.onClick === "function") return node;
  for (const c of node.children || []) {
    const r = findButton(c, label);
    if (r) return r;
  }
  return null;
}

/* ---------- globals ---------- */
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "defaults.json"), "utf8"));

function jsonRes(obj) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) });
}
function fetchStub(url) {
  const u = String(url);
  if (u.indexOf("/data") >= 0 && u.indexOf("/data") !== -1) {
    return jsonRes({ ok: true, data: seed });
  }
  if (u.indexOf("/weather") >= 0) {
    return jsonRes({
      ok: true,
      current: { temperature_2m: 18.4, apparent_temperature: 17.1, relative_humidity_2m: 55, wind_speed_10m: 9, weather_code: 2, is_day: 1 },
      daily: { time: ["2026-11-05", "2026-11-06", "2026-11-07"], weather_code: [2, 3, 61], temperature_2m_max: [20, 19, 16], temperature_2m_min: [11, 10, 8], precipitation_probability_max: [10, 20, 80] },
    });
  }
  if (u.indexOf("/holidays") >= 0) {
    return jsonRes({ ok: true, map: { "2026-01-01": { name: "元旦", holiday: true }, "2026-10-01": { name: "国庆节", holiday: true } } });
  }
  if (u.indexOf("/resolve") >= 0) {
    return jsonRes({ ok: false, error: "stub" });
  }
  if (u.indexOf("/divisions") >= 0) {
    return jsonRes({ ok: true, adcode: "100000", list: [{ adcode: "110000", name: "北京市", lng: 116.4, lat: 39.9, childrenNum: 16 }] });
  }
  if (u.indexOf("/geocode") >= 0) {
    return jsonRes({ ok: true, results: [{ name: "广州", latitude: 23.13, longitude: 113.26, country: "中国", admin1: "广东省" }] });
  }
  return jsonRes({ ok: true });
}

const docEls = {};
const sandbox = {
  window: {},
  console: console,
  Date: Date,
  Math: Math,
  JSON: JSON,
  Promise: Promise,
  encodeURIComponent: encodeURIComponent,
  fetch: fetchStub,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  location: { reload: () => {} },
  document: {
    getElementById: () => null,
    createElement: () => ({ style: {}, set textContent(v) {}, id: "" }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

let captured = null;
sandbox.window.__ModuleLoader__ = { load: (mod) => { captured = mod; } };

const ctx = vm.createContext(sandbox);
vm.runInContext(SRC, ctx, { filename: "client.js" });

function fail(msg) {
  console.error("PROBE FAIL: " + msg);
  process.exitCode = 1;
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

(async function main() {
  assert(captured, "未捕获 __ModuleLoader__.load");
  assert(captured.id === "dsh-schedule-calendar", "bundle id 不等于包名: " + captured.id);
  const mod = captured.factory((n) => {
    if (n === "react") return ReactShim;
    if (n === "react/jsx-runtime") return {};
    throw new Error("unexpected require: " + n);
  });
  assert(mod.name === "dsh-schedule-calendar", "exports.name 错误");
  assert(Array.isArray(mod.inject) && mod.inject.indexOf("betterSidebar") >= 0, "inject 缺 betterSidebar");

  let reg = null;
  let slotReg = null;
  let openTabArgs = null;
  const fakeCtx = {
    betterSidebar: {
      registerTab: (d) => { reg = d; return () => {}; },
      openTab: (seed) => { openTabArgs = seed; },
    },
    slots: {
      inject: (name, fn) => { return fn(); },
      register: (opts, comp) => { slotReg = { opts: opts, comp: comp }; return () => {}; },
    },
    layout: { openRightbar: () => { openTabArgs = openTabArgs || { _rightbar: true }; } },
    effect: (fn) => { const d = fn(); return d; },
  };
  mod.apply(fakeCtx);
  assert(reg && reg.id === "dsh-schedule-calendar", "registerTab 未调用或 id 错误");
  assert(typeof reg.component === "function", "registerTab.component 不是函数");
  assert(typeof reg.title === "string" && reg.title.length > 0, "title 缺失");
  assert(slotReg && slotReg.opts && slotReg.opts.name === "sidebar.footer.action", "左侧栏槽位未注册");
  assert(typeof slotReg.comp === "function", "左侧栏槽位组件不是函数");
  const launchNode = expand(slotReg.comp({}));
  assert(textOf(launchNode).indexOf("日程") >= 0, "左侧栏按钮文案缺失");
  const launchBtn = (function find(n) {
        if (!n || typeof n !== "object") return null;
        if (n.props && typeof n.props.onClick === "function" && (n.props.role === "button" || n.type === "button") && textOf(n).indexOf("日程") >= 0) return n;
        for (const c of n.children || []) { const r = find(c); if (r) return r; }
        return null;
      })(launchNode);
  if (launchBtn) { launchBtn.props.onClick(); }
  assert(openTabArgs && openTabArgs.type === "dsh-schedule-calendar", "左侧栏点击未打开日程标签页");
  console.log("左侧栏入口注册并点击打开标签页 OK");

  const props = { visible: true, ctx: fakeCtx, store: null, scope: {}, tab: { id: "dsh-schedule-calendar", type: "dsh-schedule-calendar" } };

  // mount loop: render, run new effects, flush microtasks, repeat until settled
  let tree = null;
  for (let round = 0; round < 20; round++) {
    hookIndex = 0;
    newEffects = [];
    dirty = false;
    tree = expand(reg.component(props));
    // run newly registered effects
    newEffects.forEach((e) => {
      try {
        e.fn();
      } catch (err) {
        fail("effect 抛错: " + (err && err.stack ? err.stack : err));
      }
    });
    // flush promises
    await new Promise((r) => setImmediate(r));
    // flush again to let setState settle
    await new Promise((r) => setImmediate(r));
    if (!dirty) break;
  }
  const bodyText = textOf(tree);
  assert(bodyText.length > 10, "组件渲染结果为空");
  console.log("mount 渲染 OK, 文本长度=" + bodyText.length);

  // switch through all views by clicking nav buttons
  const labels = ["今日", "日历", "日程", "待办", "报告", "设置"];
  for (const lb of labels) {
    // find nav button in current tree and click
    const btn = findButton(tree, lb);
    if (!btn) {
      fail("找不到导航按钮: " + lb);
      continue;
    }
    btn.props.onClick();
    // re-render until settled
    for (let round = 0; round < 10; round++) {
      hookIndex = 0;
      newEffects = [];
      dirty = false;
      tree = expand(reg.component(props));
      newEffects.forEach((e) => { try { e.fn(); } catch (err) { fail("切换视图 effect 抛错: " + (err && err.stack ? err.stack : err)); } });
      await new Promise((r) => setImmediate(r));
      if (!dirty) break;
    }
    const t = textOf(tree);
    assert(t.length > 5, "视图「" + lb + "」渲染为空");
    console.log("视图「" + lb + "」渲染 OK (" + t.length + " chars)");
  }

  if (!process.exitCode) console.log("\n=== PROBE PASS ===");
  else console.log("\n=== PROBE FAIL ===");
})().catch((e) => {
  console.error("PROBE CRASH:", e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
