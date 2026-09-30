// Manual-run functional check, not a CI test suite: builds the Chrome
// target, launches a real (headed) Chromium with the unpacked extension
// loaded via Playwright, and drives the actual UI through the main flows
// (blocking, break, manual finish -> overlay -> confetti, restore on
// finish, quit). Screenshots land in tests/screenshots/ for visual review.
//
// Extensions only load in Chromium through launchPersistentContext, and
// only in headed mode — there is no popup *window* to click from an
// automated context, so we open popup/popup.html directly as a normal tab;
// it runs the same JS and talks to the same background worker.
//
// Run with: node tests/e2e-check.js

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXT_PATH = path.join(ROOT, "dist", "chrome");
const USER_DATA_DIR = path.join(__dirname, ".pw-user-data");
const SHOT_DIR = path.join(__dirname, "screenshots");

// A tiny local server instead of real external sites: this sandbox's
// network intercepts TLS for outbound HTTPS (ERR_CERT_AUTHORITY_INVALID),
// so plain localhost HTTP sidesteps that entirely and is more deterministic.
const PAGES = {
  "/a": "<title>Page A (focus tab)</title><h1>Page A</h1>",
  "/b": "<title>Page B</title><h1>Page B</h1>",
  "/d": "<title>Page D</title><h1>Page D</h1>",
};

function startLocalServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = PAGES[req.url] || "<title>Unknown</title><h1>404</h1>";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

let passCount = 0;
let failCount = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  OK   ${label}`);
    passCount++;
  } else {
    console.log(`  FAIL ${label}`);
    failCount++;
  }
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false });
}

// Polls page.url() instead of page.waitForURL(): a `tabs.onCreated` handler
// in the background can redirect a brand-new tab before Playwright attaches
// its navigation listener, which makes waitForURL time out even though the
// tab already ended up at the right place.
async function pollUrl(page, predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(page.url())) return true;
    await page.waitForTimeout(150);
  }
  return predicate(page.url());
}

// chrome-extension:// page.goto() occasionally races with the service
// worker and aborts (net::ERR_ABORTED); one retry clears it reliably.
async function openPopup(context, popupUrl) {
  const popup = await context.newPage();
  try {
    await popup.goto(popupUrl);
  } catch (err) {
    await popup.waitForTimeout(400);
    await popup.goto(popupUrl);
  }
  return popup;
}

(async () => {
  console.log("בונה את dist/chrome...");
  execFileSync("node", [path.join(ROOT, "build.js"), "chrome"], { stdio: "inherit" });

  const server = await startLocalServer();
  const base = `http://127.0.0.1:${server.address().port}`;

  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const extensionId = new URL(sw.url()).hostname;
  console.log("Extension ID:", extensionId);
  sw.on("console", (msg) => console.log("  [sw]", msg.text()));
  context.on("close", () => console.log("  [context] closed"));
  context.on("page", (p) => p.on("crash", () => console.log("  [page] crashed:", p.url())));

  const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
  const blockedUrl = `chrome-extension://${extensionId}/blocked/blocked.html`;

  // Close the default blank tab Chromium opens
  const initialPages = context.pages();

  const tabA = await context.newPage(); // will become the focus tab
  await tabA.goto(`${base}/a`);
  const tabB = await context.newPage(); // should get blocked
  await tabB.goto(`${base}/b`);

  for (const p of initialPages) await p.close().catch(() => {});

  console.log("\n--- התחלת סשן ---");
  let popup = await openPopup(context, popupUrl);
  await popup.waitForSelector("#tabPicker");

  // pick the option that is Page A (tabA)
  await popup.selectOption(
    "#tabPicker",
    await popup.$eval("#tabPicker", (sel) => {
      const opt = [...sel.options].find((o) => o.textContent.includes("Page A"));
      return opt ? opt.value : sel.options[0].value;
    })
  );
  await popup.fill("#hours", "0");
  await popup.fill("#minutes", "5");
  await popup.fill("#planText", "בדיקת אינטגרציה אוטומטית");
  await popup.fill("#breaksPlanned", "1");
  await popup.click("#startBtn");
  await popup.waitForTimeout(800);

  await pollUrl(tabB, (u) => u === blockedUrl);
  check("טאב B הופנה לעמוד החסימה", tabB.url() === blockedUrl);
  await shot(tabB, "01-tabB-blocked.png");

  console.log("\n--- פתיחת טאב חדש בזמן חסימה ---");
  const tabC = await context.newPage();
  await pollUrl(tabC, (u) => u === blockedUrl);
  check("טאב חדש (C) הופנה מיד לעמוד החסימה", tabC.url() === blockedUrl);

  console.log("\n--- בדיקת הפסקה ---");
  popup = await openPopup(context, popupUrl);
  await popup.waitForSelector("#breakBtn", { timeout: 5000 });
  await popup.click("#breakBtn");
  await popup.fill("#breakMinutes", "1");
  await popup.click("#confirmBreakBtn");
  await popup.waitForTimeout(500);

  const tabD = await context.newPage(); // opened during break — should NOT be blocked
  await tabD.goto(`${base}/d`);
  await tabD.waitForTimeout(800);
  check("טאב שנפתח בזמן הפסקה נשאר חופשי (לא הופנה לחסימה)", tabD.url().includes("/d"));
  await tabD.close();

  popup = await openPopup(context, popupUrl);
  await popup.waitForSelector("#resumeBtn", { timeout: 5000 });
  await popup.click("#resumeBtn");
  await popup.waitForTimeout(500);

  console.log("\n--- סיום ידני -> מודאל על הטאב הממוקד ---");
  popup = await openPopup(context, popupUrl);
  await popup.waitForSelector("#finishBtn", { timeout: 5000 });
  await popup.click("#finishBtn");
  await tabA.bringToFront();
  await tabA.waitForTimeout(600);
  const finishModalVisible = await tabA
    .locator("#focus-mode-overlay-host")
    .evaluate((host) => !!host.shadowRoot.querySelector(".backdrop"));
  check("מודאל 'האם סיימת?' מופיע בטאב הממוקד", finishModalVisible);
  await shot(tabA, "02-finish-prompt.png");

  console.log("\n--- לחיצה על 'כן, סיימתי' -> חגיגה + שחזור טאבים ---");
  await tabA.evaluate(() => {
    const host = document.getElementById("focus-mode-overlay-host");
    host.shadowRoot.querySelector("#btn-yes").click();
  });
  await tabA.waitForTimeout(700);
  const celebrationVisible = await tabA
    .locator("#focus-mode-overlay-host")
    .evaluate((host) => !!host.shadowRoot.querySelector("canvas"));
  check("אנימציית הקונפטי הופיעה", celebrationVisible);
  await shot(tabA, "03-celebration-confetti.png");

  await pollUrl(tabB, (u) => u.endsWith("/b"));
  check("טאב B שוחזר לכתובת המקורית (/b)", tabB.url().endsWith("/b"));
  await tabC.waitForTimeout(500);
  check("טאב C (שנפתח ריק בזמן החסימה) שוחזר/לא נשאר על עמוד חסימה", tabC.url() !== blockedUrl);

  console.log("\n--- בדיקת ביטול (quit) ---");
  popup = await openPopup(context, popupUrl);
  await popup.waitForSelector("#tabPicker", { timeout: 5000 });
  // explicitly pick tabA — left to the default, the picker would target
  // whichever tab looked "active" at the moment, which can be this very
  // popup tab when it's opened this way (a quirk of testing popup.html as
  // a plain tab instead of a real toolbar popup window)
  await popup.selectOption(
    "#tabPicker",
    await popup.$eval("#tabPicker", (sel) => {
      const opt = [...sel.options].find((o) => o.textContent.includes("Page A"));
      return opt ? opt.value : sel.options[0].value;
    })
  );
  await popup.fill("#minutes", "5");
  await popup.fill("#planText", "בדיקת ביטול");
  await popup.click("#startBtn");
  await popup.waitForTimeout(800);

  popup = await openPopup(context, popupUrl);
  await popup.waitForSelector("#quitBtn", { timeout: 5000 });
  await popup.click("#quitBtn");
  await popup.click("#quitYes");
  await popup.waitForTimeout(800);

  await tabB.waitForTimeout(500);
  check("אחרי ביטול: טאב B שוחזר ואינו על עמוד החסימה", tabB.url() !== blockedUrl);

  popup = await openPopup(context, popupUrl);
  await popup.waitForSelector("#tabPicker", { timeout: 5000 });
  check("אחרי ביטול: הפופאפ חזר למסך ההגדרה (idle)", true);

  console.log(`\n=== תוצאה: ${passCount} עברו, ${failCount} נכשלו ===`);
  console.log("צילומי מסך נשמרו ב-tests/screenshots/");

  await context.close();
  server.close();
  process.exit(failCount > 0 ? 1 : 0);
})().catch((err) => {
  console.error("שגיאה בהרצת הבדיקה:", err);
  process.exit(1);
});
