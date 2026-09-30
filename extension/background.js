// Chrome's MV3 service_worker key only accepts a single file, so we pull in
// the shared libs ourselves here. Firefox instead lists all three files in
// manifest.firefox.json's background.scripts array (already loaded by the
// time this file runs there), so importScripts is skipped — it only exists
// in the real service-worker global anyway.
if (typeof importScripts === "function") {
  importScripts("lib/browser-api.js", "lib/state.js");
}

const ALARM_MAIN = "focus-main-end";
const ALARM_BREAK = "focus-break-end";

function blockedPageUrl() {
  return browser.runtime.getURL("blocked/blocked.html");
}

function isExtensionBlockedUrl(url) {
  return typeof url === "string" && url.startsWith(blockedPageUrl());
}

async function redirectTabToBlocked(tab, session) {
  if (!tab || tab.id == null) return;
  if (tab.id === session.focusTabId) return;
  if (isExtensionBlockedUrl(tab.url)) return;
  if (!(tab.id in session.blockedTabs)) {
    const url = tab.url || "";
    const isRestricted = url.startsWith("chrome:") || url.startsWith("edge:") || url.startsWith("about:");
    session.blockedTabs[tab.id] = isRestricted || !url ? "about:blank" : url;
  }
  try {
    await browser.tabs.update(tab.id, { url: blockedPageUrl() });
  } catch (err) {
    console.warn("focus-mode: couldn't redirect tab to blocked page", tab.id, err.message);
  }
}

async function lockAllExceptFocus(session) {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === session.focusTabId) continue;
    await redirectTabToBlocked(tab, session);
  }
  await setSession(session);
}

// Takes the blockedTabs map directly (not a session object) because the
// stored session must already be cleared/inactive before these tabs.update
// calls run — each one fires tabs.onUpdated, and if the session were still
// "active" in storage at that moment, the enforcement listener would see a
// non-focus tab navigating away from the blocked page and immediately send
// it right back, undoing the restore.
async function restoreTabs(blockedTabs) {
  const entries = Object.entries(blockedTabs || {});
  for (const [tabIdStr, originalUrl] of entries) {
    try {
      await browser.tabs.update(Number(tabIdStr), { url: originalUrl });
    } catch (err) {
      console.warn("focus-mode: couldn't restore tab", tabIdStr, originalUrl, err.message);
    }
  }
}

async function injectOverlay(tabId) {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["lib/browser-api.js", "lib/confetti.js", "content/overlay.js"],
    });
  } catch (err) {
    // focus tab may be on a page scripts can't reach (chrome://, store pages, etc.)
  }
}

async function sendToOverlay(tabId, message) {
  try {
    await browser.tabs.sendMessage(tabId, message);
  } catch (err) {
    await injectOverlay(tabId);
    try {
      await browser.tabs.sendMessage(tabId, message);
    } catch (err2) {
      // give up silently — focus tab is on a page we can't reach
    }
  }
}

async function notify(title, message) {
  try {
    await browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon128.png"),
      title,
      message,
    });
  } catch (err) {
    // notifications permission/availability varies by platform; non-fatal
  }
}

// ---- Session lifecycle ----

async function startSession({ focusTabId, focusWindowId, planText, breaksPlanned, mainDurationMs }) {
  const session = createSession({ focusTabId, focusWindowId, planText, breaksPlanned, mainDurationMs });
  await setSession(session);
  await lockAllExceptFocus(session);
  await browser.alarms.create(ALARM_MAIN, { when: session.mainEndAt });
  await injectOverlay(focusTabId);
}

function buildSummary(session) {
  const actualMs = Date.now() - session.startedAt;
  return {
    plannedMs: session.mainDurationMs,
    actualMs,
    diffMs: actualMs - session.mainDurationMs,
    breaksTaken: session.breaksTaken,
    extendedMs: session.extensionsMs,
  };
}

async function endSession(session, { completed, summary }) {
  await browser.alarms.clear(ALARM_MAIN);
  await browser.alarms.clear(ALARM_BREAK);
  await clearSession(); // before restoring tabs — see restoreTabs() comment
  await restoreTabs(session.blockedTabs);
  await pushLog({
    planText: session.planText,
    mainDurationMs: session.mainDurationMs,
    actualDurationMs: Date.now() - session.startedAt,
    extensionsMs: session.extensionsMs,
    breaksTaken: session.breaksTaken,
    completed,
    endedAt: Date.now(),
  });
  if (completed) {
    await sendToOverlay(session.focusTabId, { type: "SHOW_CELEBRATION", summary });
  }
}

async function requestBreak(session, breakDurationMs) {
  session.mainRemainingMs = session.mainEndAt - Date.now();
  session.status = FOCUS_STATUS.BREAK;
  session.breaksTaken += 1;
  session.breakEndAt = Date.now() + breakDurationMs;
  await browser.alarms.clear(ALARM_MAIN);
  await browser.alarms.create(ALARM_BREAK, { when: session.breakEndAt });
  await setSession(session);
}

async function resumeFromBreak(session) {
  session.status = FOCUS_STATUS.ACTIVE;
  session.mainEndAt = Date.now() + (session.mainRemainingMs || 0);
  session.mainRemainingMs = null;
  session.breakEndAt = null;
  await browser.alarms.clear(ALARM_BREAK);
  await browser.alarms.create(ALARM_MAIN, { when: session.mainEndAt });
  await setSession(session);
  await lockAllExceptFocus(session); // re-lock anything opened during the break
  await notify("ההפסקה נגמרה", "חוזרים למצב ריכוז.");
}

async function extendTime(session, extraMs) {
  session.mainEndAt += extraMs;
  session.extensionsMs += extraMs;
  await browser.alarms.create(ALARM_MAIN, { when: session.mainEndAt });
  await setSession(session);
}

// ---- Event listeners ----

browser.runtime.onStartup.addListener(async () => {
  const session = await getSession();
  if (!session) return;
  if (session.status === FOCUS_STATUS.BREAK && session.breakEndAt) {
    await browser.alarms.create(ALARM_BREAK, { when: session.breakEndAt });
  } else if (session.mainEndAt) {
    await browser.alarms.create(ALARM_MAIN, { when: session.mainEndAt });
  }
});

browser.tabs.onCreated.addListener(async (tab) => {
  const session = await getSession();
  if (!session || session.status !== FOCUS_STATUS.ACTIVE) return;
  if (tab.id === session.focusTabId) return;
  await redirectTabToBlocked(tab, session);
  await setSession(session);
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const session = await getSession();
  if (!session) return;

  if (tabId === session.focusTabId) {
    if (changeInfo.status === "complete") {
      await injectOverlay(tabId);
    }
    return;
  }

  if (session.status !== FOCUS_STATUS.ACTIVE) return;
  if (!changeInfo.url) return;
  if (isExtensionBlockedUrl(changeInfo.url)) return;
  await redirectTabToBlocked(tab, session);
  await setSession(session);
});

browser.windows.onCreated.addListener(async (win) => {
  const session = await getSession();
  if (!session || session.status !== FOCUS_STATUS.ACTIVE) return;
  const tabs = await browser.tabs.query({ windowId: win.id });
  for (const tab of tabs) {
    await redirectTabToBlocked(tab, session);
  }
  await setSession(session);
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getSession();
  if (!session) return;

  if (tabId !== session.focusTabId) {
    if (session.blockedTabs && tabId in session.blockedTabs) {
      delete session.blockedTabs[tabId];
      await setSession(session);
    }
    return;
  }

  // the focus tab itself was closed — there's nothing left to return to
  await browser.alarms.clear(ALARM_MAIN);
  await browser.alarms.clear(ALARM_BREAK);
  await clearSession();
  await restoreTabs(session.blockedTabs);
  await notify("מצב ריכוז בוטל", "הטאב הממוקד נסגר, כל החסימות הוסרו.");
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  const session = await getSession();
  if (!session) return;

  if (alarm.name === ALARM_MAIN) {
    await sendToOverlay(session.focusTabId, { type: "SHOW_FINISH_PROMPT" });
  } else if (alarm.name === ALARM_BREAK) {
    await resumeFromBreak(session);
  }
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true; // keep the message channel open for the async response
});

async function handleMessage(message) {
  switch (message.type) {
    case "GET_STATE": {
      const session = await getSession();
      const log = await getLog();
      return { session, log };
    }
    case "GET_TABS": {
      const tabs = await browser.tabs.query({});
      const [active] = await browser.tabs.query({ active: true, currentWindow: true });
      return {
        tabs: tabs.map((t) => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url })),
        activeTabId: active ? active.id : null,
      };
    }
    case "START_SESSION": {
      await startSession(message.payload);
      return { ok: true };
    }
    case "REQUEST_BREAK": {
      const session = await getSession();
      if (session && session.status === FOCUS_STATUS.ACTIVE) {
        await requestBreak(session, message.payload.breakDurationMs);
      }
      return { ok: true };
    }
    case "END_BREAK_EARLY": {
      const session = await getSession();
      if (session && session.status === FOCUS_STATUS.BREAK) {
        await resumeFromBreak(session);
      }
      return { ok: true };
    }
    case "MANUAL_FINISH_CLICK": {
      const session = await getSession();
      if (session) {
        await sendToOverlay(session.focusTabId, { type: "SHOW_FINISH_PROMPT" });
      }
      return { ok: true };
    }
    case "FINISH_YES": {
      const session = await getSession();
      if (!session) return { ok: false };
      await endSession(session, { completed: true, summary: buildSummary(session) });
      return { ok: true };
    }
    case "FINISH_NO_STOP": {
      const session = await getSession();
      if (!session) return { ok: false };
      await endSession(session, { completed: false });
      return { ok: true };
    }
    case "EXTEND_TIME": {
      const session = await getSession();
      if (session) {
        await extendTime(session, message.payload.extraMs);
      }
      return { ok: true };
    }
    case "QUIT_SESSION": {
      const session = await getSession();
      if (session) {
        await browser.alarms.clear(ALARM_MAIN);
        await browser.alarms.clear(ALARM_BREAK);
        await clearSession();
        await restoreTabs(session.blockedTabs);
      }
      return { ok: true };
    }
    case "FOCUS_TAB": {
      const session = await getSession();
      if (session) {
        await browser.tabs.update(session.focusTabId, { active: true });
        await browser.windows.update(session.focusWindowId, { focused: true });
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: "unknown message type" };
  }
}
