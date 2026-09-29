/*
 * One-time microphone permission for the extension's origin. The offscreen
 * capture document cannot show a permission prompt, so the user grants it here
 * (a normal, visible extension tab); the grant then applies to every
 * extension page, including the offscreen document.
 */

import { makeT } from "./lib/i18n.js";

const $ = (id) => document.getElementById(id);
let t = makeT("ru");

function applyI18n() {
  document.documentElement.lang = t.lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
}

function show(state) {
  const result = $("perm-result");
  const key = { granted: "perm_granted", denied: "perm_denied", nodevice: "perm_no_device" }[state];
  result.textContent = key ? t(key) : "";
  result.className = `result ${state === "granted" ? "ok" : state ? "fail" : ""}`;
  result.dataset.state = state || "";
  $("grant").hidden = state === "granted";
  $("close").hidden = state !== "granted";
}

async function grant() {
  $("grant").disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((track) => track.stop());
    show("granted");
    chrome.runtime.sendMessage({ target: "panel", type: "mic-permission", state: "granted" }).catch(() => {});
  } catch (e) {
    show(e?.name === "NotFoundError" || e?.name === "OverconstrainedError" ? "nodevice" : "denied");
  } finally {
    $("grant").disabled = false;
  }
}

async function init() {
  try {
    const { lang } = await chrome.storage.local.get("lang");
    t = makeT(lang || "ru");
  } catch { /* default ru */ }
  applyI18n();
  $("grant").addEventListener("click", grant);
  $("close").addEventListener("click", () => window.close());
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    if (status.state === "granted") show("granted");
    status.onchange = () => { if (status.state === "granted") show("granted"); };
  } catch { /* Permissions API unavailable */ }
  document.body.dataset.ready = "1";
}

init();
