// End-to-end test of the Recapper extension in real Chromium (headful, under xvfb).
//
//   xvfb-run -a node test/e2e/extension.e2e.mjs
//
// Starts two real Recapper servers:
//   - "fake ASR": the production app with only the transcriber replaced
//     (test/fixtures/fake_asr_server.py; validates WAV 16 kHz mono PCM16);
//   - "plain": `python -m recapper serve` (no speech recognition → 503 on audio),
//     with RECAPPER_UI_LANGUAGE=en to check the language switch.
// Loads the unpacked extension, opens sidepanel.html in a tab and drives it.
//
// Tab capture: chrome.tabCapture needs the extension to be "invoked" on the tab
// (toolbar click → activeTab), which automation cannot do. Chromium's
// --allowlisted-extension-id=<id> switch lifts exactly that check, so the real
// getMediaStreamId → offscreen getUserMedia(chromeMediaSource: "tab") path runs.
//
// Env: PLAYWRIGHT_MODULE (default ../desktop/node_modules/playwright), CHROMIUM_PATH,
//      PYTHON (default python3), E2E_SHOTS=<dir> for screenshots, E2E_KEEP=1 to keep temp files.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const EXT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const REPO = resolve(EXT, "..");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || join(REPO, "desktop", "node_modules", "playwright"));
const PYTHON = process.env.PYTHON || "python3";
const TOKEN = "exttoken";
const TMP = mkdtempSync(join(tmpdir(), "recapper-ext-e2e-"));
const SHOTS = process.env.E2E_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// ------------------------------------------------------------------ harness ---
const results = [];
const children = [];
let context = null;
const log = (...a) => console.log(...a);

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    log(`ok ${results.length} - ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    log(`not ok ${results.length} - ${name}\n  ${String(e?.stack || e).split("\n").slice(0, 6).join("\n  ")}`);
    throw e;
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(`assertion failed: ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 20000, interval = 250, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
const snap = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

function freePort() {
  return new Promise((res) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => res(port)); });
  });
}

function startProcess(cmd, args, env, label) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    const timer = setTimeout(() => rej(new Error(`${label} did not start:\n${out}`)), 30000);
    const onData = (d) => {
      out += d.toString();
      const m = /RECAPPER_READY (\S+)/.exec(out);
      if (m) { clearTimeout(timer); res(m[1]); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => { clearTimeout(timer); rej(new Error(`${label} exited (${code}):\n${out}`)); });
  });
}

async function api(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const uploads = async (base) => (await fetch(`${base}/__test__/uploads`)).json();

/** CHROMIUM_PATH, else Playwright's own build, else the newest chromium-* in PLAYWRIGHT_BROWSERS_PATH. */
function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try { if (existsSync(chromium.executablePath())) return undefined; } catch { /* not installed */ }
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const builds = existsSync(dir) ? readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : [];
  for (const b of builds) {
    for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"]) {
      if (existsSync(join(dir, b, sub))) return join(dir, b, sub);
    }
  }
  return undefined;
}

/** Chromium derives an unpacked extension's id from its absolute path. */
function unpackedExtensionId(path) {
  const hex = createHash("sha256").update(path).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

function meetingServer() {
  const html = readFileSync(join(EXT, "test", "fixtures", "meeting.html"));
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res({ srv, url: `http://127.0.0.1:${srv.address().port}/meeting.html` })));
}

// -------------------------------------------------------------------- run ---
let meeting;
const pageErrors = [];
try {
  const [fakePort, plainPort] = [await freePort(), await freePort()];
  const [FAKE, PLAIN] = await Promise.all([
    startProcess(PYTHON, [join(EXT, "test", "fixtures", "fake_asr_server.py"), "--port", String(fakePort), "--token", TOKEN,
      "--data-dir", join(TMP, "fake-data"), "--chunk-seconds", "4"], {}, "fake-ASR server"),
    startProcess(PYTHON, ["-m", "recapper", "serve", "--port", String(plainPort), "--token", TOKEN, "--data-dir", join(TMP, "plain-data")],
      { RECAPPER_LLM: "sim-good", RECAPPER_UI_LANGUAGE: "en", RECAPPER_ASR: "none" }, "plain server"),
  ]);
  meeting = await meetingServer();
  log(`# fake-ASR server ${FAKE}, plain server ${PLAIN}, meeting page ${meeting.url}`);

  const expectedId = unpackedExtensionId(EXT);
  context = await chromium.launchPersistentContext(join(TMP, "profile"), {
    headless: false,
    ...(chromiumExecutable() ? { executablePath: chromiumExecutable() } : {}),
    viewport: { width: 480, height: 1000 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--allowlisted-extension-id=${expectedId}`, // test-only: lifts the activeTab check of tabCapture
    ],
  });

  let sw;
  let extId;
  await step("extension loads: service worker is running, id matches the unpacked path", async () => {
    sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15000 }));
    extId = new URL(sw.url()).host;
    assert(sw.url().endsWith("/background.js"), sw.url());
    assert(extId === expectedId, `extension id ${extId} != ${expectedId}`);
  });

  // The "meeting": a tab playing speech-like audio (started by a real click → user activation).
  const meetingPage = await context.newPage();
  await meetingPage.goto(meeting.url);
  await meetingPage.click("#play");
  await meetingPage.waitForFunction(() => document.getElementById("state").textContent === "running");
  const meetingTabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, meeting.url);
  assert(Number.isInteger(meetingTabId), "meeting tab id");

  const panel = await context.newPage();
  panel.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  panel.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) pageErrors.push(`console: ${m.text()}`);
  });
  const $text = (sel) => panel.locator(sel).first().innerText();
  // Asked from the panel page: a service worker does not receive its own runtime messages.
  const captureStatus = () => panel.evaluate(() => chrome.runtime.sendMessage({ target: "background", type: "capture-status" }));

  await step("side panel page loads (Russian UI by default, settings open on first run)", async () => {
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${meetingTabId}`);
    await panel.waitForSelector("body[data-ready='1']");
    assert(await panel.isVisible("#settings"), "settings visible on first run");
    assert((await $text("#test-conn")) === "Проверить подключение", "Russian labels");
    assert((await $text("#conn")) === "Не настроено", await $text("#conn"));
    assert((await $text("#target-tab")).includes("Созвон"), `target tab: ${await $text("#target-tab")}`);
  });

  await step("wrong token → 'Неверный токен доступа'", async () => {
    await panel.fill("#server-url", FAKE.replace("http://", ""));
    await panel.fill("#token", "wrong-token");
    await panel.click("#save-settings");
    await panel.waitForFunction(() => document.getElementById("conn-result").textContent.includes("Неверный токен"));
    assert((await panel.inputValue("#server-url")) === FAKE, "URL normalized with http://");
  });

  await step("save server URL + token, test connection shows the server mode", async () => {
    await panel.fill("#token", TOKEN);
    await panel.click("#save-settings");
    await panel.waitForFunction(() => document.getElementById("conn-result").textContent.includes("sim-good"));
    const text = await $text("#conn-result");
    assert(text.startsWith("Подключено: Recapper"), text);
    assert(text.includes("fake-wav-check"), text);
    assert((await $text("#conn")).includes("sim-good"), await $text("#conn"));
    const stored = await sw.evaluate(() => chrome.storage.local.get(["serverUrl", "token"]));
    assert(stored.serverUrl === FAKE && stored.token === TOKEN, JSON.stringify(stored));
    await panel.click("#test-conn");
    await panel.waitForFunction(() => document.getElementById("conn-result").textContent.includes("sim-good"));
    await snap(panel, "01-settings");
  });

  await step("choose an existing open session from GET /api/live, then detach", async () => {
    const existing = await api(FAKE, "POST", "/api/live", { title: "Созвон из веб-интерфейса" });
    await panel.click("#refresh-sessions");
    await panel.waitForSelector(`#session-select option[value='${existing.id}']`, { state: "attached" });
    await panel.selectOption("#session-select", existing.id);
    await panel.click("#attach");
    await panel.waitForFunction(() => document.getElementById("meeting-title").textContent === "Созвон из веб-интерфейса");
    assert(await panel.isVisible("#capture"), "capture controls shown");
    await panel.click("#detach");
    await panel.waitForSelector("#meeting-pick:not([hidden])");
  });

  let sid;
  await step("create a new session from the side panel", async () => {
    await panel.click("#settings-toggle"); // collapse settings
    await panel.fill("#new-title", "Игра Самоката → Купер");
    await panel.click("#create-session");
    await panel.waitForFunction(() => document.getElementById("meeting-title").textContent === "Игра Самоката → Купер");
    const live = await api(FAKE, "GET", "/api/live");
    sid = live.find((s) => s.title === "Игра Самоката → Купер")?.id;
    assert(sid, JSON.stringify(live));
    const attached = await sw.evaluate(() => chrome.storage.local.get("attached"));
    assert(attached.attached?.id === sid, JSON.stringify(attached));
    assert((await $text("#meeting-state")) === "идёт", await $text("#meeting-state"));
  });

  await step("consent is required before capture starts", async () => {
    await panel.uncheck("#src-tab");
    await panel.click("#start-capture");
    await panel.waitForSelector("#capture-warnings li[data-code='consent_needed']");
    const status = await captureStatus();
    assert(status?.status?.state === "idle", JSON.stringify(status));
    assert((await uploads(FAKE)).uploads.length === 0, "nothing uploaded");
  });

  const waitUpload = (source, session) => waitFor(async () => {
    const u = await uploads(FAKE);
    return u.uploads.find((x) => x.source === source && x.session === session && x.status === 200) && u;
  }, { timeout: 30000, what: `a ${source} upload` });
  const waitRunning = async () => {
    try {
      await panel.waitForSelector("#capture-status[data-state='running']", { timeout: 15000 });
    } catch (e) {
      const why = await panel.evaluate(() => [document.getElementById("capture-status").textContent,
        ...[...document.querySelectorAll("#capture-warnings li")].map((li) => li.textContent)].join(" | "));
      throw new Error(`capture did not start: ${why}`);
    }
  };
  const waitStopped = () => panel.waitForFunction(() => ["stopped", "idle"].includes(document.getElementById("capture-status").dataset.state), null, { timeout: 30000 });
  const taskCard = (speaker) => panel.locator("#tasks-list .item[data-status='answered']", { has: panel.locator(`.speaker:text-is("${speaker}")`) })
    .filter({ hasText: "Посчитай бюджет на награды для игры" });

  await step("microphone capture via the offscreen document: WAV POSTed with source=mic", async () => {
    await panel.check("#consent");
    await panel.check("#src-mic");
    await panel.click("#start-capture");
    await waitRunning();
    const u = await waitUpload("mic", sid);
    const valid = u.transcriber.filter((c) => c.ok);
    assert(valid.length >= 1, JSON.stringify(u.transcriber));
    assert(u.transcriber.every((c) => c.ok && c.rate === 16000 && c.channels === 1 && c.width === 2), JSON.stringify(u.transcriber));
    const dur = valid[0].duration;
    assert(dur > 2.5 && dur <= 4.01, `chunk length follows capture_chunk_seconds=4 (got ${dur}s)`);
  });

  await step("voice command from the mic appears in 'Мои задачи' with its answer", async () => {
    await taskCard("Я").first().waitFor({ timeout: 20000 });
    const card = taskCard("Я").first();
    assert((await card.locator(".chip").first().innerText()) === "Задача", "kind chip");
    assert((await card.innerText()).includes("голосом"), "origin chip");
    assert((await card.locator(".answer .summary").innerText()).length > 5, "answer summary");
    assert(await card.locator(".answer .md").count(), "answer body rendered");
    await snap(panel, "02-mic-task");
  });

  await step("stop capture", async () => {
    await panel.click("#stop-capture");
    await waitStopped();
    const status = await captureStatus();
    assert(status?.status?.state === "idle", `offscreen document closed after stop: ${JSON.stringify(status)}`);
  });

  await step("tab audio capture (tabCapture → offscreen, played back): WAV POSTed with source=system", async () => {
    await panel.check("#src-tab");
    await panel.uncheck("#src-mic");
    await panel.click("#start-capture");
    await waitRunning();
    const sources = await panel.evaluate(() => JSON.parse(document.getElementById("capture-status").dataset.sources || "{}"));
    assert(sources.system?.state === "on", JSON.stringify(sources));
    assert(sources.system?.playback === true, "tab audio is routed back to the speakers");
    await panel.waitForFunction(() => {
      const bar = document.querySelector("#meters .meter[data-source='system'] i");
      return bar && parseFloat(bar.style.width) > 0;
    }, null, { timeout: 10000 });
    await waitUpload("system", sid);
    await taskCard("Собеседники").first().waitFor({ timeout: 20000 });
    await snap(panel, "03-tab-capture");
  });

  await step("both sources at once, then stop", async () => {
    await panel.click("#stop-capture");
    await waitStopped();
    await panel.check("#src-mic");
    const before = (await uploads(FAKE)).uploads.length;
    await panel.click("#start-capture");
    await waitRunning();
    await waitFor(async () => {
      const u = (await uploads(FAKE)).uploads.slice(before);
      return u.some((x) => x.source === "mic" && x.status === 200) && u.some((x) => x.source === "system" && x.status === 200);
    }, { timeout: 30000, what: "mic + system uploads" });
    await panel.click("#stop-capture");
    await waitStopped();
    const offsets = (await uploads(FAKE)).uploads.filter((x) => x.session === sid).map((x) => Number(x.offset));
    assert(offsets.every((o) => o >= 0 && o < 120), JSON.stringify(offsets));
  });

  await step("heard suggestion → 'Ответить' → answer", async () => {
    await api(FAKE, "POST", `/api/live/${sid}/segments`, {
      text: "Макс: Как мы вообще будем считать конверсию покупки из приложения Самоката в Купер?", flush: true,
    });
    const card = panel.locator("#heard-list .item").filter({ hasText: "конверси" }).first();
    await card.waitFor({ timeout: 15000 });
    assert(await card.locator(".answer").count() === 0, "suggestions are not answered automatically");
    await card.locator("button.answer-btn").click();
    await panel.locator("#heard-list .item[data-status='answered']").filter({ hasText: "конверси" }).first().waitFor({ timeout: 15000 });
  });

  await step("ask box → typed question with answer", async () => {
    await panel.fill("#ask-input", "Какие риски у промокодов?");
    await panel.press("#ask-input", "Enter");
    const card = panel.locator("#tasks-list .item[data-status='answered']").filter({ hasText: "Какие риски у промокодов?" }).first();
    await card.waitFor({ timeout: 15000 });
    assert((await card.innerText()).includes("вы написали"), "typed chip");
    assert((await panel.inputValue("#ask-input")) === "", "input cleared");
  });

  await step("HTML in questions/answers is shown as text, never executed", async () => {
    await panel.fill("#ask-input", '<img src=x onerror="window.__xss=1"> **жирный** [ссылка](javascript:window.__xss=2)');
    await panel.click("#ask-btn");
    const card = panel.locator("#tasks-list .item[data-status='answered']").filter({ hasText: "<img src=x" }).first();
    await card.waitFor({ timeout: 15000 });
    await sleep(300);
    assert(await panel.evaluate(() => window.__xss) === undefined, "no script ran");
    assert(await panel.locator("#tasks-list img").count() === 0, "no <img> element");
    assert(await panel.locator("#tasks-list a[href^='javascript']").count() === 0, "no javascript: link");
  });

  await step("quick action (Live Assist) shows its result", async () => {
    const btn = panel.locator("#assist-actions button[data-action='summary']");
    await btn.waitFor();
    await btn.click();
    await panel.waitForFunction(() => {
      const h = document.querySelector("#assist-result h3");
      return h && h.textContent.length > 0;
    }, null, { timeout: 15000 });
    assert((await $text("#assist-result h3")) === "Итог на текущий момент", await $text("#assist-result"));
    await snap(panel, "04-live");
  });

  await step("secondary tab embeds the server's compact panel", async () => {
    await panel.click("#tab-web");
    const src = await panel.getAttribute("#web-frame", "src");
    assert(src === `${FAKE}/?token=${TOKEN}&view=panel`, src);
    const frame = panel.frameLocator("#web-frame");
    await frame.locator("#panel-body").waitFor({ timeout: 15000 });
    await panel.click("#tab-assistant");
    assert(await panel.isVisible("#tasks"), "back to the assistant tab");
  });

  await step("finish → done → report link", async () => {
    await panel.click("#finish-btn");
    await panel.waitForSelector("#finish-confirm:not([hidden])");
    await panel.click("#finish-yes");
    await panel.waitForSelector("#done-card:not([hidden])", { timeout: 30000 });
    const href = await panel.getAttribute("#report-link", "href");
    assert(href === `${FAKE}/?token=${TOKEN}#/meeting/${sid}`, href);
    assert((await $text("#recap")).length > 0, "recap shown");
    assert((await $text("#meeting-state")) === "завершена", await $text("#meeting-state"));
    assert(await panel.isHidden("#capture"), "capture controls hidden after finish");
    assert(await panel.isHidden("#askbar"), "ask box hidden after finish");
    const report = await api(FAKE, "GET", `/api/meetings/${sid}`);
    assert(report.items.some((i) => i.text.includes("бюджет")), "report saved with the voice command");
    await snap(panel, "05-done");
  });

  await step("report link opens the meeting in the server web UI", async () => {
    const [page] = await Promise.all([context.waitForEvent("page"), panel.click("#report-link")]);
    await page.waitForLoadState();
    await page.waitForFunction((id) => document.body.innerText.includes("Игра Самоката"), sid, { timeout: 15000 });
    const url = page.url();
    assert(!url.includes(TOKEN), `token removed from the address bar: ${url}`);
    await page.close();
  });

  await step("server without speech recognition: UI switches to English, capture stops on 503", async () => {
    await panel.click("#new-after-done");
    await panel.click("#settings-toggle");
    await panel.fill("#server-url", PLAIN);
    await panel.click("#save-settings");
    await panel.waitForFunction(() => document.getElementById("test-conn").textContent === "Test connection", null, { timeout: 15000 });
    assert(await panel.isVisible("#asr-warning"), "ASR-off warning");
    await panel.click("#settings-toggle");
    await panel.fill("#new-title", "No ASR");
    await panel.click("#create-session");
    await panel.waitForFunction(() => document.getElementById("meeting-title").textContent === "No ASR");
    await panel.check("#consent");
    await panel.uncheck("#src-tab");
    await panel.check("#src-mic");
    await panel.click("#start-capture");
    await panel.waitForFunction(() => !document.getElementById("banner").hidden, null, { timeout: 40000 });
    const banner = await $text("#banner-text");
    assert(banner.includes("Speech recognition is off"), banner);
    await waitStopped();
    await snap(panel, "06-asr-off-en");
  });

  await step("meeting finished elsewhere while capturing: 409 stops capture, report link appears", async () => {
    await panel.click("#detach");
    await panel.click("#settings-toggle");
    await panel.fill("#server-url", FAKE);
    await panel.click("#save-settings");
    await panel.waitForFunction(() => document.getElementById("test-conn").textContent === "Проверить подключение", null, { timeout: 15000 });
    await panel.click("#settings-toggle");
    await panel.fill("#new-title", "Завершат в другом окне");
    await panel.click("#create-session");
    await panel.waitForFunction(() => document.getElementById("meeting-title").textContent === "Завершат в другом окне");
    const other = (await api(FAKE, "GET", "/api/live")).find((s) => s.title === "Завершат в другом окне").id;
    await panel.check("#consent");
    await panel.uncheck("#src-tab");
    await panel.check("#src-mic");
    await panel.click("#start-capture");
    await waitRunning();
    await waitUpload("mic", other);
    await api(FAKE, "POST", `/api/live/${other}/finish`);
    await panel.waitForSelector("#done-card:not([hidden])", { timeout: 30000 });
    await waitStopped();
    const href = await panel.getAttribute("#report-link", "href");
    assert(href.endsWith(`#/meeting/${other}`), href);
  });

  await step("permissions page grants the microphone for the extension", async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/permissions.html`);
    await page.waitForSelector("body[data-ready='1']");
    if (await page.isVisible("#grant")) await page.click("#grant");
    await page.waitForSelector("#perm-result[data-state='granted']", { timeout: 10000 });
    assert((await page.innerText("#perm-result")).includes("разрешён"), await page.innerText("#perm-result"));
    await page.close();
    await panel.waitForFunction(() => document.getElementById("mic-state").textContent === "разрешён", null, { timeout: 5000 });
  });

  await step("no uncaught errors in the side panel", async () => {
    assert(pageErrors.length === 0, pageErrors.join("\n"));
  });
} catch (e) {
  if (!results.some((r) => !r.ok)) {
    results.push({ name: "setup", ok: false, error: e });
    log(`not ok - setup\n  ${String(e?.stack || e)}`);
  }
} finally {
  if (context) await context.close().catch(() => {});
  meeting?.srv.close();
  for (const c of children) c.kill("SIGTERM");
  if (!process.env.E2E_KEEP) rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  log(`\n# e2e: ${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
