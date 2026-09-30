// Injected on-demand into the focus tab only (never into every site).
// Guarded against double-injection within the same document: `tick` alarms
// or repeated "complete" events could otherwise call this twice.
(function () {
  if (window.__focusOverlayReady) return;
  window.__focusOverlayReady = true;

  const host = document.createElement("div");
  host.id = "focus-mode-overlay-host";
  host.style.all = "initial";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .backdrop {
      position: fixed; inset: 0; background: rgba(15, 23, 42, 0.72);
      display: flex; align-items: center; justify-content: center;
      z-index: 2147483000; font-family: -apple-system, "Segoe UI", Arial, sans-serif;
      direction: rtl;
    }
    .card {
      background: #fff; border-radius: 16px; padding: 28px 24px; width: 320px;
      max-width: 90vw; box-shadow: 0 20px 60px rgba(0,0,0,0.35); text-align: center;
      animation: focus-pop .18s ease-out;
    }
    @keyframes focus-pop { from { transform: scale(.92); opacity: 0 } to { transform: scale(1); opacity: 1 } }
    h1, h2 { margin: 0 0 10px; color: #111827; }
    h2 { font-size: 19px; }
    h1 { font-size: 26px; }
    p { margin: 0 0 18px; font-size: 14px; color: #4b5563; line-height: 1.5; }
    .row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
    button {
      border: none; border-radius: 10px; padding: 10px 18px; font-size: 14px;
      cursor: pointer; font-weight: 600;
    }
    .primary { background: #4f46e5; color: #fff; }
    .secondary { background: #e5e7eb; color: #111827; }
    input[type="number"] {
      width: 90px; padding: 8px; border-radius: 8px; border: 1px solid #d1d5db;
      font-size: 14px; text-align: center; margin-bottom: 16px; display: block;
      margin-inline: auto;
    }
    .summary { font-size: 13px; color: #6b7280; margin-top: 8px; line-height: 1.6; }
  `;
  shadow.appendChild(style);

  const container = document.createElement("div");
  shadow.appendChild(container);

  function clear() {
    container.innerHTML = "";
  }

  function renderFinishPrompt() {
    clear();
    const wrap = document.createElement("div");
    wrap.className = "backdrop";
    wrap.innerHTML = `
      <div class="card">
        <h2>⏰ הזמן שהוקצב נגמר</h2>
        <p>האם סיימת את מה שתכננת לעשות?</p>
        <div class="row">
          <button class="primary" id="btn-yes">כן, סיימתי</button>
          <button class="secondary" id="btn-no">לא, עדיין לא</button>
        </div>
      </div>`;
    container.appendChild(wrap);
    wrap.querySelector("#btn-yes").addEventListener("click", () => {
      browser.runtime.sendMessage({ type: "FINISH_YES" });
    });
    wrap.querySelector("#btn-no").addEventListener("click", renderContinuePrompt);
  }

  function renderContinuePrompt() {
    clear();
    const wrap = document.createElement("div");
    wrap.className = "backdrop";
    wrap.innerHTML = `
      <div class="card">
        <h2>להמשיך לעבוד על זה?</h2>
        <p>אפשר להוסיף עוד זמן ולהמשיך במצב ריכוז, או לצאת בלי לסמן שהמשימה הושלמה.</p>
        <div class="row">
          <button class="primary" id="btn-continue">כן, ממשיך/ה</button>
          <button class="secondary" id="btn-stop">לא, עוזב/ת</button>
        </div>
      </div>`;
    container.appendChild(wrap);
    wrap.querySelector("#btn-continue").addEventListener("click", renderExtendPrompt);
    wrap.querySelector("#btn-stop").addEventListener("click", () => {
      browser.runtime.sendMessage({ type: "FINISH_NO_STOP" });
      clear();
    });
  }

  function renderExtendPrompt() {
    clear();
    const wrap = document.createElement("div");
    wrap.className = "backdrop";
    wrap.innerHTML = `
      <div class="card">
        <h2>כמה זמן נוסף?</h2>
        <p>הזינו דקות נוספות למצב הריכוז:</p>
        <input type="number" id="extra-minutes" min="1" value="15" />
        <div class="row">
          <button class="primary" id="btn-extend">הוספה והמשך</button>
        </div>
      </div>`;
    container.appendChild(wrap);
    wrap.querySelector("#btn-extend").addEventListener("click", () => {
      const minutes = Math.max(1, Number(wrap.querySelector("#extra-minutes").value) || 15);
      browser.runtime.sendMessage({ type: "EXTEND_TIME", payload: { extraMs: minutes * 60000 } });
      clear();
    });
  }

  function formatMinutes(ms) {
    const totalMin = Math.round(Math.abs(ms) / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h} שע' ו-${m} דק'` : `${m} דק'`;
  }

  function renderCelebration(summary) {
    clear();
    const wrap = document.createElement("div");
    wrap.className = "backdrop";
    const card = document.createElement("div");
    card.className = "card";

    let diffText = "בדיוק לפי התכנון! 🎯";
    if (summary && summary.diffMs > 60000) diffText = `סיימת ${formatMinutes(summary.diffMs)} אחרי התכנון המקורי`;
    else if (summary && summary.diffMs < -60000) diffText = `סיימת ${formatMinutes(summary.diffMs)} לפני התכנון המקורי`;

    card.innerHTML = `
      <h1>🎉 כל הכבוד! 🎉</h1>
      <p>סיימת את זמן המיקוד שלך.</p>
      <div class="summary">
        ${diffText}${summary ? `<br/>הפסקות שנלקחו: ${summary.breaksTaken}` : ""}
      </div>
      <div class="row" style="margin-top:16px">
        <button class="primary" id="btn-close">סגירה</button>
      </div>
    `;
    wrap.appendChild(card);
    container.appendChild(wrap);
    launchConfetti(shadow);
    wrap.querySelector("#btn-close").addEventListener("click", clear);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "SHOW_FINISH_PROMPT") renderFinishPrompt();
    else if (message.type === "SHOW_CELEBRATION") renderCelebration(message.summary);
  });
})();
