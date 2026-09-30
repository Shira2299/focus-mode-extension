// Modern Chrome/Edge/Brave (MV3) support Promise-based chrome.* APIs when the
// callback argument is omitted, for every namespace this extension uses
// (tabs, windows, storage, alarms, scripting, notifications, runtime).
// Firefox already exposes a native Promise-based `browser` global.
// So the only thing missing on Chromium browsers is the `browser` name itself.
if (typeof globalThis.browser === "undefined") {
  globalThis.browser = globalThis.chrome;
}
