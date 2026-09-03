import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import SedPopover from "./SedPopover.jsx";
import "./styles.css";

// ── 运行时错误回收（排查白屏）──
// 把 window.onerror / unhandledrejection / console.error 写进数据目录的
// hd_fe_err.txt，WorkBuddy 侧可直接读，绕过沙箱拿不到系统日志的限制。
function feReport(m) {
  try {
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("report_fe_error", { msg: String(m) }).catch(() => {})
    );
  } catch (e) { /* ignore */ }
}
window.addEventListener("error", (e) => {
  feReport("window.onerror: " + ((e.message) || (e.error && e.error.stack) || e) +
    " @ " + (e.filename || "") + ":" + (e.lineno || ""));
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  feReport("unhandledrejection: " + ((r && (r.stack || r.message)) || r));
});
const _ce = console.error.bind(console);
console.error = (...a) => {
  try {
    feReport("console.error: " + a.map((x) =>
      (typeof x === "string") ? x : ((x && x.stack) ? x.stack : JSON.stringify(x))
    ).join(" "));
  } catch (_) {}
  _ce(...a);
};

// 按窗口 label 分流：sed-pop = 菜单栏久坐提醒小窗；其余 = 主小组件
async function resolveComponent() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const label = getCurrentWindow().label;
    if (label === "sed-pop") return <SedPopover />;
  } catch (e) { /* 非 Tauri 环境（浏览器 dev）走主窗口 */ }
  return <App />;
}

resolveComponent().then((el) => {
  try {
    ReactDOM.createRoot(document.getElementById("root")).render(
      <React.StrictMode>{el}</React.StrictMode>
    );
    feReport("BOOT_OK label=" + (el && el.type && el.type.name));
  } catch (err) {
    feReport("RENDER_THROW: " + ((err && err.stack) || err));
  }
}).catch((err) => {
  feReport("RESOLVE_THROW: " + ((err && err.stack) || err));
});
