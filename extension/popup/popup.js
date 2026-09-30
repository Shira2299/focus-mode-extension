const app = document.getElementById("app");
let countdownTimer = null;
let cachedTabs = [];

function sendMsg(type, payload) {
  return browser.runtime.sendMessage({ type, payload });
}

function formatClock(ms) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n) + "…" : str;
}

async function refresh() {
  const { session, log } = await sendMsg("GET_STATE");
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (!session) {
    await renderIdle(log);
  } else if (session.status === "break") {
    renderBreak(session);
  } else {
    renderActive(session);
  }
}

async function renderIdle(log) {
  const { tabs, activeTabId } = await sendMsg("GET_TABS");
  cachedTabs = tabs;
  const options = tabs
    .map(
      (t) =>
        `<option value="${t.id}" ${t.id === activeTabId ? "selected" : ""}>${escapeHtml(
          truncate(t.title || t.url, 48)
        )}</option>`
    )
    .join("");

  const logHtml = (log || [])
    .slice(0, 5)
    .map((entry) => {
      const icon = entry.completed ? "✅" : "⏹️";
      const mins = Math.round(entry.actualDurationMs / 60000);
      return `<li>${icon} ${escapeHtml(truncate(entry.planText || "(ללא תיאור)", 30))} — ${mins} דק'</li>`;
    })
    .join("");

  app.innerHTML = `
    <h1>🎯 מצב ריכוז</h1>
    <label>איזו כרטיסייה תישאר פתוחה?</label>
    <select id="tabPicker">${options}</select>

    <label>כמה זמן להתמקד?</label>
    <div class="row">
      <input type="number" id="hours" min="0" max="12" value="0" /> <span>שעות</span>
      <input type="number" id="minutes" min="0" max="59" value="25" /> <span>דקות</span>
    </div>

    <label>מה מתכננים לעשות בזמן הזה?</label>
    <textarea id="planText" rows="4" placeholder="לדוגמה: לסיים את פרק 3 בקורס ולתרגל..."></textarea>

    <label>כמה הפסקות מתוכננות?</label>
    <input type="number" id="breaksPlanned" min="0" max="20" value="1" />

    <button class="primary full" id="startBtn">▶️ התחלת מיקוד</button>

    ${log && log.length ? `<div class="log"><h2>היסטוריה אחרונה</h2><ul>${logHtml}</ul></div>` : ""}
  `;

  document.getElementById("startBtn").addEventListener("click", async () => {
    const tabId = Number(document.getElementById("tabPicker").value);
    const tab = cachedTabs.find((t) => t.id === tabId);
    const hours = Number(document.getElementById("hours").value) || 0;
    const minutes = Number(document.getElementById("minutes").value) || 0;
    const mainDurationMs = (hours * 60 + minutes) * 60000;
    const planText = document.getElementById("planText").value.trim();
    const breaksPlanned = Number(document.getElementById("breaksPlanned").value) || 0;

    if (!tab || mainDurationMs <= 0) {
      alert("צריך לבחור כרטיסייה ולהזין זמן גדול מ-0");
      return;
    }

    await sendMsg("START_SESSION", {
      focusTabId: tab.id,
      focusWindowId: tab.windowId,
      planText,
      breaksPlanned,
      mainDurationMs,
    });
    window.close();
  });
}

function renderActive(session) {
  app.innerHTML = `
    <h1>🎯 מצב ריכוז פעיל</h1>
    <div class="countdown" id="countdown">--:--</div>
    <div class="plan-box">${escapeHtml(session.planText || "(ללא תיאור)")}</div>
    <div class="breaks-badge">הפסקות: ${session.breaksTaken}${
    session.breaksPlanned ? " / " + session.breaksPlanned : ""
  }</div>

    <button class="secondary full" id="breakBtn">☕ הפסקה</button>
    <div id="breakForm" class="hidden">
      <input type="number" id="breakMinutes" min="1" max="120" value="10" /> <span>דקות הפסקה</span>
      <button class="primary" id="confirmBreakBtn">✔️ אישור</button>
    </div>

    <button class="primary full" id="finishBtn">✅ סיימתי את המשימה</button>
    <button class="danger full" id="quitBtn">✖ ביטול מצב ריכוז</button>
    <div id="quitConfirm" class="hidden">
      <p class="warn">זה ימחק את התוכנית והחסימות. להמשיך?</p>
      <button class="danger" id="quitYes">כן, לבטל</button>
      <button class="secondary" id="quitNo">חזרה</button>
    </div>
  `;

  const tick = () => {
    document.getElementById("countdown").textContent = formatClock(session.mainEndAt - Date.now());
  };
  tick();
  countdownTimer = setInterval(tick, 1000);

  document.getElementById("breakBtn").addEventListener("click", () => {
    document.getElementById("breakForm").classList.toggle("hidden");
  });
  document.getElementById("confirmBreakBtn").addEventListener("click", async () => {
    const mins = Number(document.getElementById("breakMinutes").value) || 10;
    await sendMsg("REQUEST_BREAK", { breakDurationMs: mins * 60000 });
    refresh();
  });
  document.getElementById("finishBtn").addEventListener("click", async () => {
    await sendMsg("MANUAL_FINISH_CLICK");
    await sendMsg("FOCUS_TAB");
    window.close();
  });
  document.getElementById("quitBtn").addEventListener("click", () => {
    document.getElementById("quitConfirm").classList.toggle("hidden");
  });
  document.getElementById("quitNo").addEventListener("click", () => {
    document.getElementById("quitConfirm").classList.add("hidden");
  });
  document.getElementById("quitYes").addEventListener("click", async () => {
    await sendMsg("QUIT_SESSION");
    refresh();
  });
}

function renderBreak(session) {
  app.innerHTML = `
    <h1>☕ הפסקה</h1>
    <div class="countdown" id="countdown">--:--</div>
    <p>הטיימר הראשי מושהה. אפשר לדפדף בחופשיות עד שההפסקה נגמרת.</p>
    <button class="primary full" id="resumeBtn">▶️ חזרה למיקוד עכשיו</button>
  `;
  const tick = () => {
    document.getElementById("countdown").textContent = formatClock(session.breakEndAt - Date.now());
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
  document.getElementById("resumeBtn").addEventListener("click", async () => {
    await sendMsg("END_BREAK_EARLY");
    refresh();
  });
}

refresh();
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[FOCUS_STORAGE_KEY]) {
    refresh();
  }
});
