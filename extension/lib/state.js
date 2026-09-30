// Shared session model. Loaded into every context (background, popup,
// blocked page, content overlay) as a plain classic script so it works
// without a bundler or ES module support in the MV3 service worker.

const FOCUS_STORAGE_KEY = "focusSession";
const FOCUS_LOG_KEY = "focusSessionLog";

const FOCUS_STATUS = {
  ACTIVE: "active",
  BREAK: "break",
};

function createSession({ focusTabId, focusWindowId, planText, breaksPlanned, mainDurationMs }) {
  const now = Date.now();
  return {
    status: FOCUS_STATUS.ACTIVE,
    focusTabId,
    focusWindowId,
    planText,
    breaksPlanned,
    breaksTaken: 0,
    mainDurationMs,
    mainEndAt: now + mainDurationMs,
    mainRemainingMs: null,
    breakEndAt: null,
    extensionsMs: 0,
    blockedTabs: {},
    startedAt: now,
  };
}

async function getSession() {
  const data = await browser.storage.local.get(FOCUS_STORAGE_KEY);
  return data[FOCUS_STORAGE_KEY] || null;
}

async function setSession(session) {
  await browser.storage.local.set({ [FOCUS_STORAGE_KEY]: session });
}

async function clearSession() {
  await browser.storage.local.remove(FOCUS_STORAGE_KEY);
}

async function getLog() {
  const data = await browser.storage.local.get(FOCUS_LOG_KEY);
  return data[FOCUS_LOG_KEY] || [];
}

async function pushLog(entry) {
  const log = await getLog();
  log.unshift(entry);
  await browser.storage.local.set({ [FOCUS_LOG_KEY]: log.slice(0, 20) });
}
