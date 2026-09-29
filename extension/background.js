/*
 * Service worker: opens the side panel from the toolbar icon (which also grants
 * activeTab for the meeting tab, needed by chrome.tabCapture), owns the
 * offscreen capture document and shows a "REC" badge while capturing.
 *
 * Messages in (target "background"):
 *   capture-start {options}  → creates the offscreen document, forwards "start"
 *   capture-stop  {flush}     → forwards "stop", then closes the offscreen document
 *   capture-status            → current capture snapshot ({state: "idle"} without a document)
 */

const OFFSCREEN_PATH = "offscreen.html";
const POPUP_SIZE = { width: 420, height: 780 };

function setup() {
  // We open the panel ourselves in action.onClicked (and fall back to a popup window
  // in browsers without chrome.sidePanel, e.g. some Chromium forks).
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })?.catch?.(() => {});
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

async function openPopupWindow(tab) {
  const url = chrome.runtime.getURL(`sidepanel.html?tab=${tab.id}&window=popup`);
  const { popupWindowId } = await chrome.storage.session.get("popupWindowId");
  if (popupWindowId) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      chrome.runtime.sendMessage({ target: "panel", type: "invoked-tab", tabId: tab.id }).catch(() => {});
      return;
    } catch { /* the window was closed */ }
  }
  const win = await chrome.windows.create({ url, type: "popup", ...POPUP_SIZE });
  await chrome.storage.session.set({ popupWindowId: win.id });
}

chrome.action.onClicked.addListener((tab) => {
  // The click grants activeTab for `tab`: remember it as the meeting tab to capture.
  const invoked = { id: tab.id, windowId: tab.windowId, title: tab.title || "", url: tab.url || "", at: Date.now() };
  if (chrome.sidePanel?.open) {
    // Must run synchronously inside the user gesture.
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => openPopupWindow(tab));
  } else {
    openPopupWindow(tab).catch(() => {});
  }
  chrome.storage.session.set({ invokedTab: invoked }).catch(() => {});
  chrome.runtime.sendMessage({ target: "panel", type: "invoked-tab", tabId: tab.id }).catch(() => {});
});

// ------------------------------------------------------------ offscreen ---
let creating = null;

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts.length > 0;
  }
  return chrome.offscreen.hasDocument ? chrome.offscreen.hasDocument() : false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Захват звука вкладки встречи и микрофона для ассистента Recapper",
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function closeOffscreen() {
  try { if (await hasOffscreen()) await chrome.offscreen.closeDocument(); } catch { /* already closed */ }
}

function toOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function handle(msg) {
  switch (msg.type) {
    case "capture-start": {
      await ensureOffscreen();
      return toOffscreen({ type: "start", options: msg.options });
    }
    case "capture-stop": {
      if (!(await hasOffscreen())) return { ok: true, status: { state: "idle" } };
      const res = await toOffscreen({ type: "stop", flush: msg.flush !== false, reason: msg.reason });
      await closeOffscreen();
      return res;
    }
    case "capture-status": {
      if (!(await hasOffscreen())) return { ok: true, status: { state: "idle" } };
      return toOffscreen({ type: "status" });
    }
    default:
      return { ok: false, error: { code: "unknown_message" } };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "capture-event" && msg.event?.kind === "state") {
    const running = ["starting", "running", "stopping"].includes(msg.event.status?.state);
    chrome.action.setBadgeText({ text: running ? "REC" : "" }).catch(() => {});
    if (running) chrome.action.setBadgeBackgroundColor({ color: "#d93025" }).catch(() => {});
    return false;
  }
  if (msg?.target !== "background") return false;
  handle(msg).then(sendResponse, (e) => sendResponse({
    ok: false, error: { code: "background_error", message: String(e?.message || e) },
  }));
  return true;
});
