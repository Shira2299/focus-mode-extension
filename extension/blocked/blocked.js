const app = document.getElementById("app");
let countdownTimer = null;

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

async function refresh() {
  const { session } = await sendMsg("GET_STATE");
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (!session) {
    renderIdle();
  } else if (session.status === "break") {
    renderBreak(session);
  } else {
    renderActive(session);
  }
}

function renderIdle() {
  app.innerHTML = `
    <div class="card">
      <h1>🔓 אין מצב ריכוז פעיל כרגע</h1>
      <p>אפשר לסגור את הכרטיסייה הזו ולהמשיך כרגיל.</p>
    </div>
  `;
}

function renderActive(session) {
  app.innerHTML = `
    <div class="card">
      <h1>🔒 מצב ריכוז פעיל</h1>
      <div class="countdown" id="countdown">--:--</div>
      ${session.planText ? `<div class="plan-box">${escapeHtml(session.planText)}</div>` : ""}
      <button class="primary full" id="gotoBtn">↩️ חזרה לכרטיסייה הממוקדת</button>

      <div class="minor-actions">
        <button class="secondary" id="breakBtn">☕ הפסקה</button>
        <button class="secondary" id="finishBtn">✅ סיימתי</button>
        <button class="danger" id="quitBtn">✖ ביטול</button>
      </div>
      <div id="breakForm" class="hidden">
        <input type="number" id="breakMinutes" min="1" max="120" value="10" /> <span>דקות הפסקה</span>
        <button class="primary" id="confirmBreakBtn">✔️ אישור</button>
      </div>
      <div id="quitConfirm" class="hidden">
        <p class="warn">זה ימחק את התוכנית והחסימות. להמשיך?</p>
        <button class="danger" id="quitYes">כן, לבטל</button>
        <button class="secondary" id="quitNo">חזרה</button>
      </div>
    </div>
  `;

  const tick = () => {
    document.getElementById("countdown").textContent = formatClock(session.mainEndAt - Date.now());
  };
  tick();
  countdownTimer = setInterval(tick, 1000);

  document.getElementById("gotoBtn").addEventListener("click", () => sendMsg("FOCUS_TAB"));
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
    <div class="card">
      <h1>☕ הפסקה פעילה</h1>
      <div class="countdown" id="countdown">--:--</div>
      <p>אפשר לדפדף בחופשיות עד שההפסקה נגמרת.</p>
      <button class="primary full" id="resumeBtn">▶️ חזרה למיקוד עכשיו</button>
    </div>
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
