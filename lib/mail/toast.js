// dsh-schedule-calendar · 邮件模块 —— Windows 系统桌面通知（宿主 Node 进程发起）。
//
// 适配自 dsh-qq-mail/lib/toast.js（原样逻辑），仅改 scripts/toast.ps1 的相对路径
// （本文件在 lib/mail/，需上溯两级到包根再 /scripts/toast.ps1）。
//
// 机制：宿主 spawn powershell.exe（Windows PowerShell 5.1）运行 scripts/toast.ps1，
// 用 WinRT ToastNotificationManager 发 toast，AUMID 固定为 DSH 桌面端已注册的
// "electron.app.DSH NEXT"（→ toast 以「DSH NEXT」身份+图标弹出、点击可聚焦）。
//
// 为什么不用 Electron 的 Notification：宿主与 Electron main 是不同进程，无现成 IPC；
// 为什么不用 node-notifier：保持零额外依赖，减少故障面（Lead 已拍板）。
//
// 声音：-Sound 开关让脚本顺便播一段系统通知音（后台也能响，不依赖渲染进程定时器）。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../lib/mail
const TOAST_PS1 = join(HERE, "..", "..", "scripts", "toast.ps1"); // → <pkg>/scripts/toast.ps1
const POWERSHELL = process.env.SystemRoot
  ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe";

// DSH 桌面端已注册的 AppUserModelID（实测存在于开始菜单）。
const DSH_AUMID = process.env.DSH_SCHEDULE_CALENDAR_MAIL_AUMID || "electron.app.DSH NEXT";

// 常见系统通知音（存在才用）。
const SOUND_CANDIDATES = [
  process.env.SystemRoot ? join(process.env.SystemRoot, "Media", "Windows Notify Email.wav") : null,
  process.env.SystemRoot ? join(process.env.SystemRoot, "Media", "Windows Notify Messaging.wav") : null,
  process.env.SystemRoot ? join(process.env.SystemRoot, "Media", "notify.wav") : null,
];

function pickSound() {
  for (const p of SOUND_CANDIDATES) if (p && existsSync(p)) return p;
  return "";
}

function clean(s, max) {
  return String(s == null ? "" : s)
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, max || 200)
    .trim();
}

/**
 * 异步弹出系统 toast（fire-and-forget，不阻塞宿主轮询）。
 * @returns {{ok:boolean, pid?:number, error?:string}}
 */
export function showToast(opts) {
  const title = clean(opts && opts.title, 80) || "新邮件";
  const body = clean(opts && opts.body, 300);
  const withSound = !!(opts && opts.sound);
  if (!existsSync(TOAST_PS1)) return { ok: false, error: "toast.ps1 not found: " + TOAST_PS1 };
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    TOAST_PS1,
    "-Title",
    title,
    "-Body",
    body,
    "-AppId",
    DSH_AUMID,
  ];
  if (withSound) {
    const sp = (opts && opts.soundPath) || pickSound();
    if (sp) args.push("-SoundPath", sp);
    else args.push("-Sound");
  }
  try {
    const child = spawn(POWERSHELL, args, { detached: true, windowsHide: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** 仅播声音（后台也响），用于「邮件来了但系统通知关掉、只留声音」的场景。 */
export function playSound(soundPath) {
  const sp = soundPath || pickSound();
  const inner = sp
    ? `try { $p = New-Object System.Media.SoundPlayer '${sp.replace(/'/g, "''")}'; $p.Play() } catch { [System.Media.SystemSounds]::Notification.Play() }`
    : `try { [System.Media.SystemSounds]::Notification.Play() } catch {}`;
  try {
    const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", inner], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

export { TOAST_PS1, DSH_AUMID, pickSound };
