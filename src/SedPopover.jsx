// SedPopover.jsx -- 菜单栏图标下方的久坐提醒弹窗（独立小窗口 sed-pop 渲染）
// 样式与小组件内的久坐弹窗完全一致（同配色/同文案/同按钮）。
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t as T } from "./i18n.js";

const SW = 2;
const ICO_CHAIR = (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={SW} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3v8" /><path d="M18 3v8" /><path d="M6 5h12" /><path d="M6 11h12" />
    <path d="M8 11v7a2 2 0 0 1-2 2" /><path d="M18 11v7a2 2 0 0 0 2 2" /><path d="M8 14h8" />
  </svg>
);

// Apple 系统色（与主弹窗一致的琥珀色系）
const AMBER = "#FF9F0A";

export default function SedPopover() {
  const [idleMin, setIdleMin] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let dead = false;
    const read = async () => {
      try {
        const s = await invoke("read_data");
        if (!s || dead) return;
        const d = JSON.parse(s);
        const t = (d && d.today) || {};
        setIdleMin(t.idle_min || 0);
        const snoozeUntil = Number(t.snooze_until || 0);
        const snoozed = snoozeUntil > Date.now();
        if (!t.sedentary || snoozed) {
          // 不久坐 / 已点"稍后"：内容隐藏 + 真正收起原生窗口，避免透明窗口壳残留
          setDismissed(true);
          getCurrentWindow().hide().catch(() => {});
        } else {
          setDismissed(false);
        }
      } catch (e) { /* 忽略 */ }
    };
    read();
    const id = setInterval(read, 3000);
    return () => { dead = true; clearInterval(id); };
  }, []);

  const onLater = async () => {
    setDismissed(true);
    try { await invoke("snooze_sedentary", { minutes: 30 }); } catch (e) {}
    getCurrentWindow().hide().catch(() => {});
  };
  const onStoodUp = async () => {
    setDismissed(true);
    try { await invoke("reset_sedentary"); } catch (e) {}
    getCurrentWindow().hide().catch(() => {});
  };

  if (dismissed) return null;

  return (
      <div
      className="sed-popover"
      style={{
        width: "100%", height: "100%", boxSizing: "border-box",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start",
        paddingTop: 14,
        background: "transparent",
      }}
    >
      <div
        style={{
          width: 186, borderRadius: 12, padding: "9px 11px 8px",
          boxSizing: "border-box", position: "relative",
          background: "rgba(38,30,18,0.92)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
          border: "1px solid rgba(255,159,10,0.45)",
          animation: "sed-pop .4s cubic-bezier(.2,.9,.3,1.15)",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 顶部箭头（指向菜单栏图标） */}
        <div style={{ position: "absolute", top: -4.5, left: "50%", marginLeft: -4.5, width: 9, height: 9, background: "rgba(38,30,18,0.92)", borderLeft: "1px solid rgba(255,159,10,0.45)", borderTop: "1px solid rgba(255,159,10,0.45)", transform: "rotate(45deg)" }} />
        <div style={{ fontSize: 10.5, fontWeight: 700, color: AMBER, letterSpacing: 0.2, display: "flex", alignItems: "center", gap: 5 }}>
          {ICO_CHAIR}<span>{T("sedentaryMin", { m: idleMin })}</span>
        </div>
        <div style={{ fontSize: 8.5, color: "rgba(255,159,10,0.65)", marginTop: 2 }}>{T("standHint")}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
          <div
            onMouseDown={function (e) { e.stopPropagation(); onLater(); }}
            style={{ flex: 1, textAlign: "center", fontSize: 9, fontWeight: 600, color: "rgba(255,159,10,0.65)", border: "1px solid rgba(255,159,10,0.35)", padding: "3px 0", borderRadius: 99, cursor: "pointer" }}
          >{T("later")}</div>
          <div
            onMouseDown={function (e) { e.stopPropagation(); onStoodUp(); }}
            style={{ flex: 1, textAlign: "center", fontSize: 9, fontWeight: 600, color: "#0a0a0c", background: AMBER, padding: "4px 0", borderRadius: 99, cursor: "pointer" }}
          >{T("stoodUp")}</div>
        </div>
      </div>
    </div>
  );
}
