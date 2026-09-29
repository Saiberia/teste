// Browser end-to-end test of the web UI against a real server with a simulated AI.
// Usage: node tests/e2e/web_ui.mjs <baseUrl> <token> [screenshotDir]
// Requires the `playwright` npm package (installed in desktop/node_modules).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../../desktop/node_modules/playwright");

const [base = "http://127.0.0.1:8765", token = "uitoken", shots = ""] = process.argv.slice(2);
if (shots) mkdirSync(shots, { recursive: true });
const snap = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const fail = (msg) => { throw new Error(msg); };

const launch = {};
if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(launch);
const errors = [];
const watch = (page) => {
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
};
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage(); watch(page);
  await page.goto(`${base}/?token=${token}`);
  await page.waitForSelector("#start");
  if (page.url().includes("token=")) fail("token must be removed from the address bar");
  await snap(page, "01-live-empty");

  await page.fill("#title", "Игра Самоката → Купер");
  await page.click("#start");
  await page.waitForSelector("#finish:not([disabled])");
  for (const line of [
    "Макс: Как мы вообще будем считать конверсию покупки из приложения Самоката в Купер?",
    "Аня: Ассистент, допиши механику монетизации игры: конверсия покупки из приложения Самоката в Купер.",
  ]) { await page.fill("#line", line); await page.press("#line", "Enter"); await page.waitForTimeout(250); }
  await page.click("text=Проанализировать сейчас");
  await page.waitForSelector("#my-tasks .item .summary", { timeout: 10000 });
  await page.waitForSelector("#heard .item", { timeout: 10000 });
  if (await page.locator("#heard .item .chip.st-draft").count()) fail("suggestions must not be answered automatically");

  // The floating panel (desktop) attaches to the running meeting.
  const panel = await ctx.newPage(); watch(panel);
  await panel.setViewportSize({ width: 380, height: 560 });
  await panel.goto(`${base}/?token=${token}&view=panel`);  // as the desktop app opens it
  await panel.waitForSelector("#panel-body .item", { timeout: 10000 });
  await snap(panel, "02-panel");

  await page.click("text=Итог на текущий момент");
  await page.waitForSelector(".assist-result", { timeout: 10000 });
  if ((await page.textContent(".assist-result")).includes("<transcript>")) fail("assist result leaked prompt markup");
  await page.click('#heard .item button:has-text("Ответить")');
  await page.waitForSelector("#heard .item .chip.st-draft", { timeout: 10000 });
  await page.fill(".ask input", "Какие риски у промокодов?"); await page.press(".ask input", "Enter");
  await page.waitForFunction(() => document.querySelectorAll("#my-tasks .item .summary").length >= 2, null, { timeout: 10000 });
  const sources = await page.textContent("#my-tasks .sources");
  if (sources.includes("[object")) fail("sources rendered as [object ...]");
  await snap(page, "03-live-tasks");

  await page.click("#finish");
  await page.waitForURL(/#\/meeting\//, { timeout: 15000 });
  await page.waitForSelector("text=Мои задачи ассистенту");
  await page.fill(".col-side .row input[type=text]", "Что решили?");
  await page.press(".col-side .row input[type=text]", "Enter");
  await page.waitForSelector(".bubble.ai .btn", { timeout: 10000 });
  if ((await page.locator(".bubble.ai .btn").count()) !== 3) fail("chat must offer exactly 3 follow-up questions");
  await snap(page, "04-report");

  await page.goto(`${base}/#/meetings`); await page.waitForSelector(".meeting-row");
  await page.fill("input[type=search]", "монетизации"); await page.press("input[type=search]", "Enter");
  await page.waitForSelector(".hit", { timeout: 5000 });
  await snap(page, "05-meetings");

  await page.goto(`${base}/#/ai`); await page.waitForSelector(".trace");
  await snap(page, "06-ai-check");

  await page.goto(`${base}/#/settings`); await page.waitForSelector(".settings");
  await snap(page, "07-settings");
  await page.selectOption('.setting:has-text("Язык интерфейса") select', "en");
  await page.click("text=Сохранить");
  await page.waitForSelector(".tabs a:has-text('Settings')", { timeout: 5000 });
  await page.selectOption('.setting:has-text("Interface language") select', "ru");
  await page.click("text=Save");
  await page.waitForSelector(".tabs a:has-text('Настройки')", { timeout: 5000 });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 800 } }); watch(mobile);
  await mobile.goto(`${base}/?token=${token}#/live`); await mobile.waitForSelector("#start");
  if (await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail("horizontal overflow at 390px");
  await snap(mobile, "08-mobile");

  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`${base}/`); await anon.waitForSelector("main");
  if (!(await anon.textContent("body")).includes("токен")) fail("without a token the UI must explain how to open it");

  const relevant = errors.filter((e) => !e.includes("401"));
  if (relevant.length) fail("browser errors: " + relevant.join(" | "));
  console.log("web UI e2e: OK");
} finally {
  await browser.close();
}
