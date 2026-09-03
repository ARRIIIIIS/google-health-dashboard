// ─────────────────────────────────────────────────────────────────────────────
// App.jsx —— 健康仪表盘（Tauri 跨平台版）
// 由 Übersicht 版 index.jsx 移植：去掉 command/refreshFrequency/render 全局，
// 改为 React 组件 + Tauri IPC。情绪球 JS 内联进 iframe（无 HTTP 服务）。
// 新增：多语言 / 明暗主题 / 设置面板 / 拖拽定位 / 勿扰抑制 / 大模型底部提示。
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t as T, setLang, getLang, LANGS } from "./i18n.js";

// 设置引导页（浏览器中完成 Google 授权 / AI 配置）。改目标改这里即可。
const GOOGLE_SETUP_URL = "https://github.com/ARRIIIIIS/google-health-dashboard#%E5%AE%89%E8%A3%85";
const AI_SETUP_URL = "https://github.com/ARRIIIIIS/google-health-dashboard#%E5%AE%89%E8%A3%85";

// 在默认浏览器中打开外部设置引导页
const openExternal = (url) => {
  if (tauriAvailable()) invoke("open_external", { url }).catch(() => {});
};

// 情绪球库（Vite ?raw 以字符串引入，内联进 iframe，完全离线自包含）
import ringsJs from "./emotion-ball/rings.js?raw";
import emotionsJs from "./emotion-ball/emotions.js?raw";
import ballJs from "./emotion-ball/ball.js?raw";
import engineJs from "./emotion-ball/engine.js?raw";

const EB_LIBS = [ringsJs, emotionsJs, ballJs, engineJs]
  .map((s) => s.replace(/<\/script>/gi, "<\\/script>"))
  .join("</script>\n<script>");

// ── Apple system palette ─────────────────────────────────────────────────────
const C_DARK = {
  label: "rgba(255,255,255,0.95)",
  second: "rgba(250,250,252,0.86)",
  third: "rgba(245,245,250,0.66)",
  // 深色下要「透」但也要「浮得起来」：加深 tint 让面板与壁纸拉开对比（用户反馈对比度不够）
  bg: "linear-gradient(160deg, rgba(48,48,54,0.34) 0%, rgba(26,26,30,0.26) 100%)",
  card: "rgba(255,255,255,0.10)",
  hairline: "rgba(255,255,255,0.12)",
  // 玻璃顶棱（受光），深色下提亮才能看清面板边界
  rim: "rgba(255,255,255,0.30)",
  rimSoft: "rgba(255,255,255,0.12)",
  // 玻璃控件底（刷新按钮/芯片/设置控件统一）
  glassCtl: "rgba(255,255,255,0.10)",
  green: "#30D158",
  red: "#FF375F",
  blue: "#0A84FF",
  teal: "#40C8E0",
  indigo: "#5E5CE6",
  amber: "#FF9F0A",
  alert: "#FF453A",
};
const C_LIGHT = {
  label: "rgba(28,28,30,0.95)",
  second: "rgba(60,60,67,0.90)",
  third: "rgba(60,60,67,0.55)",
  // 系统 NSVisualEffectView 提供真实液态玻璃模糊，前端只叠极薄白色 tint 提亮。
  // 0.74 太重盖住玻璃 → 0.22 透出系统模糊；再降到 0.10/0.05（用户「很透」偏好）
  bg: "linear-gradient(160deg, rgba(240,240,246,0.10) 0%, rgba(232,232,240,0.05) 100%)",
  card: "rgba(0,0,0,0.03)",
  hairline: "rgba(0,0,0,0.07)",
  rim: "rgba(255,255,255,0.45)",
  rimSoft: "rgba(255,255,255,0.18)",
  glassCtl: "rgba(255,255,255,0.14)",
  green: "#248A3D",
  red: "#D70015",
  blue: "#007AFF",
  teal: "#00829A",
  indigo: "#5E5CE6",
  amber: "#B25000",
  alert: "#D70015",
};
// 本地提示兜底池：LLM 未配置 / 失败时启用（蓝点），按分钟轮换保证「久不更新」也能变
const SEDENTARY_TIPS = [
  "久坐伤身，起身走走更健康。",
  "站起来伸个懒腰，感觉会更好。",
  "久坐提醒：起来接杯水吧。",
  "离开椅子活动两分钟，腰背会感谢你。",
];
const FALLBACK_TIPS = [
  "喝杯水，活动一下筋骨吧。",
  "深呼吸，放松一下肩膀。",
  "休息一会，眼睛看向远方。",
  "保持节奏，劳逸结合。",
  "今天的目标很接近了，加油！",
  "保持好心情，状态会更好。",
  "适当补水，身体更轻松。",
  "午后容易困，动一动提提神。",
];
// 当前生效调色板（随系统/设置切换）
let C = C_DARK;

// Apple 风格连续曲线（squircle）：用超椭圆(n=5)采样四角，替代正圆 border-radius
const SQUIRCLE = (function () {
  const w = 344, h = 272, r = 36, n = 5, k = 2 / n, seg = 20;
  const corners = [
    { cx: r, cy: r, sx: -1, sy: -1, t0: 0, t1: Math.PI / 2 },
    { cx: w - r, cy: r, sx: 1, sy: -1, t0: Math.PI / 2, t1: 0 },
    { cx: w - r, cy: h - r, sx: 1, sy: 1, t0: 0, t1: Math.PI / 2 },
    { cx: r, cy: h - r, sx: -1, sy: 1, t0: 0, t1: Math.PI / 2 },
  ];
  const p = [];
  corners.forEach((c) => {
    for (let i = 0; i <= seg; i++) {
      const a = c.t0 + (c.t1 - c.t0) * (i / seg);
      const dx = r * Math.pow(Math.abs(Math.cos(a)), k);
      const dy = r * Math.pow(Math.abs(Math.sin(a)), k);
      p.push([c.cx + c.sx * dx, c.cy + c.sy * dy]);
    }
  });
  return "path('" + p.map((q) => q[0].toFixed(2) + " " + q[1].toFixed(2)).join(" L ") + " Z')";
})();

// 磨砂由系统 NSVisualEffectView 提供（HudWindow 材质），前端不再模拟噪点/高光

// ── Line icons ──────────────────────────────────────────────────────────────
const SW = 2;
const ICO = {
  refresh: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={SW} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  ),
  chair: (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={SW} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3v8" /><path d="M18 3v8" /><path d="M6 5h12" /><path d="M6 11h12" />
      <path d="M8 11v7a2 2 0 0 1-2 2" /><path d="M18 11v7a2 2 0 0 0 2 2" /><path d="M8 14h8" />
    </svg>
  ),
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtTime(d) {
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function fmtSleep(min) {
  if (!min) return null;
  return Math.floor(min / 60) + "h" + (min % 60 ? (min % 60) + "m" : "");
}

function computeBallEmotion(t, sedOverride) {
  if (!t) return "02";
  const isSed = sedOverride !== undefined ? sedOverride : t.sedentary;
  if (isSed) return Math.random() < 0.5 ? "21" : "34";
  const tip = t.tip_level;
  const sleep = t.sleep_asleep_min || 0;
  const steps = t.steps || 0;
  const hr = new Date().getHours();
  if (tip === "alert") return "17";
  if (tip === "warn") return sleep < 300 ? "15" : "11";
  if (hr >= 23 || hr < 6) return "00";
  if (sleep > 0 && sleep < 240) return "00";
  if (sleep > 0 && sleep < 360) return "15";
  if (steps > 10000) return "10";
  if (steps > 0 && steps < 2000) return "12";
  return "19";
}

function cleanTip(s) {
  if (!s) return "";
  return s
    .replace(/[🀀-🿿﻿‍]/gu, "")
    .replace(/[，。、；：！？“”‘’（）《》【】…—～,.;:!?()\[\]"'`\-]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

// ── Settings panel（覆盖在小组件之上的滚动设置层）────────────────────────────
function SettingsPanel({ draft, setDraft, onSave, onCancel, busy, rerender, systemDark, onTestApi, testStatus }) {
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const guideCard = { background: "rgba(128,128,128,0.08)", border: "1px solid " + C.hairline, borderRadius: 12, padding: "9px 11px", marginTop: 6 };
  const guideBtn = { display: "inline-block", marginTop: 7, fontSize: 10, fontWeight: 600, color: "#fff", background: C.blue, padding: "5px 11px", borderRadius: 8, cursor: "pointer" };
  const sedCard = {
    background: "linear-gradient(135deg, rgba(255,159,10,0.10) 0%, rgba(255,159,10,0.03) 100%)",
    border: "1px solid rgba(255,159,10,0.22)", borderRadius: 14, padding: "10px 12px 12px", marginTop: 6, marginBottom: 6,
  };
  const sedLabel = { fontSize: 10.5, fontWeight: 600, color: C.amber, marginTop: 7, display: "block" };

  const inputStyle = {
    width: "100%", boxSizing: "border-box", fontSize: 11, color: C.label,
    background: "rgba(128,128,128,0.14)", border: "1px solid " + C.hairline,
    borderRadius: 7, padding: "4px 7px", outline: "none",
  };
  const labelStyle = { fontSize: 10.5, fontWeight: 600, color: C.second, marginTop: 9, display: "block" };
  const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 9 };
  const checkStyle = (checked) => ({
    width: 16, height: 16, borderRadius: 4, border: "1.5px solid " + (checked ? C.blue : C.hairline),
    background: checked ? C.blue : "transparent", flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all .15s",
  });
  const radioStyle = (checked) => ({
    width: 16, height: 16, borderRadius: "50%", border: "1.5px solid " + (checked ? C.blue : C.hairline),
    background: checked ? C.blue : "transparent", flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all .15s",
  });

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "absolute", inset: 0, zIndex: 100, overflowY: "auto", overflowX: "hidden",
        padding: "12px 14px 16px", borderRadius: 36, WebkitClipPath: SQUIRCLE, clipPath: SQUIRCLE,
        background: C.bg,
        border: "1px solid " + C.hairline, boxSizing: "border-box",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: C.label, marginBottom: 6 }}>{T("settingsTitle")}</div>

      {/* ── 久坐提醒（置顶高亮卡片：自定义阈值）── */}
      <div style={sedCard}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.amber, marginBottom: 7 }}>
          {ICO.chair}{" 久坐提醒"}
        </div>
        <label style={sedLabel}>{T("sedentaryThreshold")}</label>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {[30, 40, 45, 60, 90].map((m) => (
            <div key={m} onClick={() => set("sedentary_min", m)}
              style={{ flex: 1, textAlign: "center", fontSize: 10, fontWeight: 600, padding: "4px 0", borderRadius: 8, cursor: "pointer",
                background: (draft.sedentary_min || 45) === m ? C.amber : "rgba(128,128,128,0.14)",
                color: (draft.sedentary_min || 45) === m ? "#fff" : C.second }}>
              {m} {T("minUnit")}
            </div>
          ))}
        </div>
      </div>

      {/* ── 语言（单选）── */}
      <label style={labelStyle}>{T("language")}</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
        {LANGS.map((l) => (
          <div key={l.code} onClick={() => {
            set("language", l.code);
            setLang(l.code);
            rerender();
          }} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
            <div style={radioStyle(draft.language === l.code)}>
              {draft.language === l.code && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }} />}
            </div>
            <span style={{ fontSize: 11, color: C.label }}>{l.label}</span>
          </div>
        ))}
      </div>

      {/* ── 外观（单选）── */}
      <label style={labelStyle}>{T("theme")}</label>
      <div style={{ display: "flex", gap: 6 }}>
        {[["auto", T("themeAuto")], ["light", T("themeLight")], ["dark", T("themeDark")]].map(([v, lbl]) => (
          <div key={v} onClick={() => {
            set("theme", v);
            const dark = v === "dark" ? true : v === "light" ? false : systemDark;
            C = dark ? C_DARK : C_LIGHT;
            rerender();
          }}
            style={{ flex: 1, textAlign: "center", fontSize: 10, fontWeight: 600, padding: "5px 0", borderRadius: 8, cursor: "pointer",
              background: draft.theme === v ? C.blue : "rgba(128,128,128,0.14)", color: draft.theme === v ? "#fff" : C.second }}>
            {lbl}
          </div>
        ))}
      </div>

      {/* ── 刷新间隔（预设）── */}
      <label style={labelStyle}>{T("refreshInterval")}</label>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {[5, 15, 30].map((m) => (
          <div key={m} onClick={() => {
            set("refresh_interval_min", m);
            invoke("update_refresh_interval", { seconds: m * 60 }).catch(() => {});
          }}
            style={{ fontSize: 10, fontWeight: 600, padding: "4px 9px", borderRadius: 8, cursor: "pointer",
              background: draft.refresh_interval_min === m ? C.blue : "rgba(128,128,128,0.14)",
              color: draft.refresh_interval_min === m ? "#fff" : C.second }}>
            {m} min
          </div>
        ))}
      </div>

      {/* ── 开机自启 ── */}
      <div style={rowStyle}>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.second }}>{T("autostart")}</span>
        <div onClick={() => {
          const next = !draft.autostart;
          set("autostart", next);
          invoke("toggle_autostart_setting", { enabled: next }).catch(() => {});
        }}
          style={{ width: 38, height: 21, borderRadius: 99, padding: 2, cursor: "pointer",
            background: draft.autostart ? C.green : "rgba(128,128,128,0.3)", transition: "background .2s" }}>
          <div style={{ width: 17, height: 17, borderRadius: "50%", background: "#fff", marginLeft: draft.autostart ? 17 : 0, transition: "margin .2s" }} />
        </div>
      </div>

      {/* ── 勿扰 ── */}
      <div style={rowStyle}>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: C.second, maxWidth: 200, lineHeight: 1.25 }}>{T("respectDnd")}</span>
        <div onClick={() => {
          const next = !draft.respect_dnd;
          set("respect_dnd", next);
          invoke("toggle_dnd_setting", { enabled: next }).catch(() => {});
        }}
          style={{ width: 38, height: 21, borderRadius: 99, padding: 2, cursor: "pointer", flexShrink: 0,
            background: draft.respect_dnd ? C.green : "rgba(128,128,128,0.3)" }}>
          <div style={{ width: 17, height: 17, borderRadius: "50%", background: "#fff", marginLeft: draft.respect_dnd ? 17 : 0, transition: "margin .2s" }} />
        </div>
      </div>

      <div style={{ height: 1, background: C.hairline, margin: "10px 0 4px" }} />

      {/* ── Google 健康（浏览器引导）── */}
      <div style={guideCard}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.label }}>Google 健康数据</div >
        <div style={{ fontSize: 9.5, color: C.third, marginTop: 3, lineHeight: 1.35 }}>需在浏览器中完成 Google 授权（OAuth）。点击按钮在默认浏览器打开设置向导。</div >
        <div onClick={() => openExternal(GOOGLE_SETUP_URL)} style={guideBtn}>在浏览器中设置 →</div >
      </div >

      {/* ── AI 模型（浏览器引导）── */}
      <div style={guideCard}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.label }}>AI 提示语</div >
        <div style={{ fontSize: 9.5, color: C.third, marginTop: 3, lineHeight: 1.35 }}>在浏览器中配置大模型（Base URL / API Key / 模型）。点击按钮打开配置页。</div >
        <div onClick={() => openExternal(AI_SETUP_URL)} style={guideBtn}>在浏览器中设置 →</div >
      </div >

      {/* ── LLM API 测试 ── */}
      <div style={guideCard}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.label }}>LLM API 连通性测试</div >
        <div style={{ fontSize: 9.5, color: C.third, marginTop: 3, lineHeight: 1.35 }}>测试 API 是否正常工作及端点延迟。</div >
        <div onClick={onTestApi} style={{ ...guideBtn, background: testStatus?.status === "testing" ? C.amber : (testStatus?.status === "ok" ? C.green : C.blue) }}>
          {testStatus?.status === "testing" ? "测试中..." : (testStatus?.status === "ok" ? "测试成功" : "开始测试")}
        </div >
        {testStatus && <div style={{ fontSize: 8, color: C.second, marginTop: 4 }}>{testStatus.message}</div >}
      </div >

      {/* ── 表情跟随鼠标 ── */}
      <div style={guideCard}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.label }}>表情跟随鼠标</div>
        <div style={{ fontSize: 9.5, color: C.third, marginTop: 3, lineHeight: 1.35 }}>鼠标划过小组件时，表情会看向它。阈值越小越克制，满偏距离越小越灵敏。</div>
        <label style={{ ...labelStyle, marginTop: 8, fontVariantNumeric: "tabular-nums" }}>跟随阈值 {((draft.gaze_threshold != null ? draft.gaze_threshold : 1.0)).toFixed(2)}</label>
        <input type="range" min="0.2" max="1" step="0.05" value={draft.gaze_threshold != null ? draft.gaze_threshold : 1.0}
          onChange={(e) => set("gaze_threshold", parseFloat(e.target.value))}
          style={{ width: "100%", accentColor: C.blue, marginTop: 4, cursor: "pointer" }} />
        <label style={{ ...labelStyle, marginTop: 8, fontVariantNumeric: "tabular-nums" }}>满偏距离 {Math.round(draft.gaze_radius != null ? draft.gaze_radius : 80)} px</label>
        <input type="range" min="60" max="360" step="10" value={draft.gaze_radius != null ? draft.gaze_radius : 80}
          onChange={(e) => set("gaze_radius", parseFloat(e.target.value))}
          style={{ width: "100%", accentColor: C.blue, marginTop: 4, cursor: "pointer" }} />
      </div>

    {/* 保存 / 取け */}
    <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
      <div onClick={onCancel} style={{ flex: 1, textAlign: "center", fontSize: 11, fontWeight: 600, color: C.second, border: "1px solid " + C.hairline, padding: "7px 0", borderRadius: 9, cursor: "pointer" }}>{T("cancel")}</div >
      <div onClick={busy ? undefined : onSave} style={{ flex: 1, textAlign: "center", fontSize: 11, fontWeight: 700, color: "#fff", background: C.blue, padding: "7px 0", borderRadius: 9, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>{T("save")}</div >
    </div >
  </div >
);
}
function Widget({ data, settings, onRefresh, onReset, justResetAt, sedPopRef, dndActive, bottomTip, forceWidgetPop, setForceWidgetPop }) {
  const t = data.today || {};
  const steps = t.steps || 0;
  const active = t.active_minutes || 0;
  const resting = t.resting_hr;
  const liveHr = t.heart_rate;
  const hrVal = liveHr != null ? liveHr : resting;
  const hrLabel = T("heartRate");
  const hrv = t.hrv;
  const spo2 = t.spo2;
  const resp = t.respiratory_rate;
  const distance = t.distance;
  const calories = t.calories;
  const sleep = t.sleep_asleep_min || 0;
  const updated = t.updated_at;
  const sedentary = !!t.sedentary;
  const idleMin = t.idle_min != null ? t.idle_min : null;

  const now = new Date();

  const justReset = (Date.now() - justResetAt) < 90000;
  const effSed = justReset ? false : sedentary;
  const effIdle = justReset ? 0 : idleMin;
  const eid = computeBallEmotion(t, effSed);

  const ballDoc =
    "<!doctype html><html><head><meta charset='utf-8'>" +
    "<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%;-webkit-user-select:none;user-select:none}" +
    "#bot{width:100%;height:100%}#bot svg{display:block;width:100%;height:100%}</style></head><body><div id='bot'></div>" +
    "<script>document.addEventListener('contextmenu',function(e){e.preventDefault();});document.addEventListener('selectstart',function(e){e.preventDefault();});</script>" +
    "<script>" + EB_LIBS + "</script>" +
    "<script>(function(){try{" +
    "var b=EmotionBall.create(document.getElementById('bot')," +
    "{emotion:'" + eid + "',shape:'blob',eyeScale:1.7,idle:true,lite:true,autostart:true});" +
    "b.setGaze(0,0);window.__ball=b;window.__ballReady=true;" +
    "var SED=" + (effSed ? "true" : "false") + ";" +
    "var ac=['10','19','03','13','14','16','30','11','18','33','02','15','12','04','20','35','36','31','39','40'];" +
    "var ai=0;" +
    "window.__cycleEmotion=function(){var arr=SED?['21','34']:ac;ai=(ai+1)%arr.length;b.setEmotion(arr[ai]);};" +
    "if(!SED){window.__autoTimer=setInterval(window.__cycleEmotion,4500);}" +
    "}catch(e){document.title='ERR:'+(e.message||e).slice(0,80)}})()</script>" +
    "</body></html>";

  const ballIframe = (
    <iframe
      srcDoc={ballDoc}
      style={{ width: 52, height: 52, border: "none", background: "transparent", display: "block", flexShrink: 0, borderRadius: "50%", cursor: "pointer", overflow: "hidden" }}
      title="mood-ball"
      ref={function (el) {
        if (!el) return;
        if (el.__ballWired) return;
        el.__ballWired = true;
        let tries = 0;
        const setup = function () {
          const w = el.contentWindow;
          if (!w || !w.__ballReady) { if (tries++ < 50) setTimeout(setup, 100); return; }
          try {
            w.document.addEventListener("click", function () {
              try { w.__cycleEmotion(); } catch (e) {}
            });
            // 表情跟随鼠标：鼠标在窗口内移动时眼睛看过去，移出窗口缓缓回正；
            // 阈值/距离优先读设置（gaze_threshold/gaze_radius），缺省回退 1.0/80（更灵敏）
            const clampN = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
            const onMove = function (e) {
              try {
                const s = settingsRef.current;
                const R = (s && s.gaze_radius) ? s.gaze_radius : 80;
                const TH = (s && s.gaze_threshold) ? s.gaze_threshold : 1.0;
                const rect = el.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                let nx = clampN((e.clientX - cx) / R, -1, 1);
                let ny = clampN((e.clientY - cy) / R, -1, 1);
                nx = clampN(nx, -TH, TH);
                ny = clampN(ny, -TH, TH);
                w.__ball.setGaze(nx, ny);
              } catch (err) {}
            };
            const onLeave = function () { try { w.__ball.clearGaze(); } catch (err) {} };
            window.addEventListener("mousemove", onMove);
            document.addEventListener("mouseleave", onLeave);
            window.addEventListener("blur", onLeave);
          } catch (e) {}
        };
        setup();
      }}
    />
  );

  // 久坐弹窗（勿扰模式下按设置抑制）
  const SED_POP_KEY = "health-widget-sed-pop-v1";
  let popDismissed = false;
  try {
    const rec = JSON.parse(localStorage.getItem(SED_POP_KEY) || "null");
    popDismissed = !!(rec && rec.date === t.date && rec.idle === idleMin);
  } catch (e) {}
  const dndBlock = settings.respect_dnd && dndActive;
  const showSedPop = (effSed || forceWidgetPop) && effIdle != null && !popDismissed && !dndBlock;

  const dismissSedPop = function () {
    try { localStorage.setItem(SED_POP_KEY, JSON.stringify({ date: t.date, idle: idleMin })); } catch (e) {}
    setForceWidgetPop(false);
  };

  const ballWrap = (
    <div data-tauri-drag-region="false" style={{ position: "relative", width: 52, height: 52, flexShrink: 0, zIndex: 10 }}>
      {ballIframe}
    </div>
  );

  const idleChipWithPop = effIdle != null ? (
    <div style={{ position: "relative" }}>
      <div data-tauri-drag-region="false" title={T("sedentaryThreshold")} onMouseDown={function (e) { e.preventDefault(); e.stopPropagation(); if (!effSed || !sedPopRef.current) return; const vis = sedPopRef.current.style.display !== "none"; sedPopRef.current.style.display = vis ? "none" : "block"; if (vis) dismissSedPop(); else { try { localStorage.removeItem(SED_POP_KEY); } catch (err) {} } }} style={{ display: "flex", alignItems: "center", gap: 5, height: 19, padding: "0 8px 0 6px", borderRadius: 99, flexShrink: 0, fontSize: 9, fontWeight: 600, letterSpacing: 0.2, fontVariantNumeric: "tabular-nums", cursor: effSed ? "pointer" : "default", ...(effSed ? { background: "rgba(255,159,10,0.16)", color: C.amber, animation: "sed-pulse 2.2s ease-in-out infinite" } : { background: C.card, color: C.third }) }}>
        {ICO.chair}<span>{effIdle} min</span>
      </div>
      {effSed && effIdle != null && (
        <div ref={function (el) { sedPopRef.current = el; }} style={{ position: "absolute", top: "calc(100% + 8px)", left: "50%", marginLeft: -93, width: 186, zIndex: 50, borderRadius: 12, padding: "9px 11px 8px", background: "rgba(38,30,18,0.92)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: "1px solid rgba(255,159,10,0.45)", display: showSedPop ? "block" : "none", animation: "sed-pop .4s cubic-bezier(.2,.9,.3,1.15)" }}>
          <div style={{ position: "absolute", top: -4.5, left: "50%", marginLeft: -4.5, width: 9, height: 9, background: "rgba(38,30,18,0.92)", borderLeft: "1px solid rgba(255,159,10,0.45)", borderTop: "1px solid rgba(255,159,10,0.45)", transform: "rotate(45deg)" }} />
          <div style={{ fontSize: 10.5, fontWeight: 700, color: C.amber, letterSpacing: 0.2, display: "flex", alignItems: "center", gap: 5 }}>
            {ICO.chair}<span>{T("sedentaryMin", { m: idleMin })}</span>
          </div>
          <div style={{ fontSize: 8.5, color: "rgba(255,159,10,0.65)", marginTop: 2 }}>{T("standHint")}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
            <div onMouseDown={function (e) { e.preventDefault(); e.stopPropagation(); if (sedPopRef.current) sedPopRef.current.style.display = "none"; dismissSedPop(); }} style={{ flex: 1, textAlign: "center", fontSize: 9, fontWeight: 600, color: "rgba(255,159,10,0.65)", border: "1px solid rgba(255,159,10,0.35)", padding: "3px 0", borderRadius: 99, cursor: "pointer" }}>{T("later")}</div>
            <div onMouseDown={function (e) { e.preventDefault(); e.stopPropagation(); if (sedPopRef.current) sedPopRef.current.style.display = "none"; dismissSedPop(); onReset(); }} style={{ flex: 1, textAlign: "center", fontSize: 9, fontWeight: 600, color: "#0a0a0c", background: C.amber, padding: "4px 0", borderRadius: 99, cursor: "pointer" }}>{T("stoodUp")}</div>
          </div>
        </div>
      )}
    </div>
  ) : null;

  const header = (
    <div data-tauri-drag-region style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 2px", cursor: "grab" }}>
      <svg width="18" height="18" viewBox="0 0 18 18" style={{ display: "block", flexShrink: 0 }}>
        <g transform="translate(9,9) rotate(-90)" fill="none" strokeLinecap="round">
          <circle r="7.3" stroke="#FF375F" strokeWidth="1.7" strokeDasharray="45.87" strokeDashoffset="5.5" />
          <circle r="5.0" stroke="#30D158" strokeWidth="1.7" strokeDasharray="31.42" strokeDashoffset="4.2" />
          <circle r="2.8" stroke="#0A84FF" strokeWidth="1.7" strokeDasharray="17.59" strokeDashoffset="2.8" />
        </g>
      </svg>
      <span style={{ fontSize: 11, fontWeight: 700, color: C.label, letterSpacing: 0.1 }}>{T("appTitle")}</span>
      <div style={{ flex: 1 }} />
      {ballWrap}
      {idleChipWithPop}
      <span style={{ fontSize: 9, fontWeight: 500, color: C.third, fontVariantNumeric: "tabular-nums" }}>{updated || fmtTime(now)}</span>
      {/* 设置入口已移至菜单栏 */}
      <div data-tauri-drag-region="false" className="hd-refresh-btn" onMouseDown={function (e) { e.preventDefault(); e.stopPropagation(); if (e.button !== 0) return; onRefresh(); }} title={T("refreshTitle")} style={{ width: 19, height: 19, borderRadius: "50%", background: "rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, color: C.second }}>
        {ICO.refresh}
      </div>
    </div>
  );

  const glassStyle = {
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
    padding: "12px 14px",
    borderRadius: "28px",
    clipPath: SQUIRCLE,
    WebkitClipPath: SQUIRCLE,
    display: "flex",
    flexDirection: "column",
    // 玻璃模糊由系统 NSVisualEffectView 提供；前端叠极薄底色透出系统玻璃
    background: C.bg,
    // CSS 模糊叠加系统 vibrancy：WKWebView 透明后 backdrop-filter 模糊窗口后内容，
    // 与 Popover 磨砂叠加出真正的液态玻璃质感
    backdropFilter: "blur(18px) saturate(1.3)",
    WebkitBackdropFilter: "blur(18px) saturate(1.3)",
    // 顶部亮棱（受光）+ 底部暗收口，无四向棱线（圆角处交叠出暗角）也无外投影（透明窗口裁直角）
    boxShadow: "inset 0 1px 0 " + C.rim + ", inset 0 -0.5px 0 rgba(0,0,0,0.16)",
    overflow: "hidden",
    position: "relative",
  };

  // ── 极简数字风（唯一布局）──
  {
    const stepGoal = 8000;
    const stepPct = Math.min(100, Math.round((steps / stepGoal) * 100));
    const metrics = [
      { label: hrLabel, value: hrVal, unit: T("bpm"), color: C.red },
      { label: T("hrv"), value: hrv, unit: T("ms"), color: C.blue },
      { label: T("spo2"), value: spo2, unit: T("pct"), color: C.teal },
      { label: T("resp"), value: resp, unit: T("perMin"), color: C.indigo },
    ];
    const sleepStages = [
      { k: "awake", v: t.sleep_awake_min || 0, c: "rgba(152,152,157,0.55)" },
      { k: "rem", v: t.sleep_rem_min || 0, c: C.amber },
      { k: "light", v: t.sleep_light_min || 0, c: C.teal },
      { k: "deep", v: t.sleep_deep_min || 0, c: C.indigo },
    ];
    const sleepTotal = sleepStages.reduce(function (a, p) { return a + (p.v || 0); }, 0);
    // 圆点指示提示来源：绿色 = LLM 生效（AI tip / 正在分析），蓝色 = LLM 未配置或失败、回落到本地静态提示池
    const tipDot = bottomTip ? C.green : C.blue;
    // AI tip 优先；AI 未配置 / 请求失败时回落到本地静态池：按分钟轮换（久坐场景优先久坐提醒），
    // 保证提示始终可见且会更新，不再依赖数据里的旧规则 tip（数据不动它就不动的根因）
    const fallbackPool = effSed ? SEDENTARY_TIPS : FALLBACK_TIPS;
    const fallbackTip = fallbackPool[Math.floor(Date.now() / 60000) % fallbackPool.length];
    const tipText = cleanTip(bottomTip) || fallbackTip;
    const distStr = distance != null ? distance.toFixed(1) + "km" : "—";
    const calStr = calories != null ? calories + " " + T("kcal") : "";
    const midLine = T("stepsUnit") + " · " + T("distance") + " " + distStr + (calStr ? " · " + calStr : "");

    return (
      <div style={Object.assign({}, glassStyle, { display: "flex", flexDirection: "column", gap: 8 })}>
        {header}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", padding: "0 4px", position: "relative" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 46, fontWeight: 700, lineHeight: 1, letterSpacing: -2, color: C.label, fontVariantNumeric: "tabular-nums" }}>{steps ? steps.toLocaleString() : "—"}</span>
            <span style={{ fontSize: 11.5, fontWeight: 500, color: C.second, marginTop: 4, letterSpacing: 0.3 }}>
              {midLine}
            </span>
          </div>
          <div style={{ textAlign: "right" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.green, fontVariantNumeric: "tabular-nums" }}>{active != null ? active : "—"}<span style={{ fontSize: 9, color: C.third, fontWeight: 500 }}> {T("minActive")}</span></span>
          </div>
        </div>
        <div style={{ height: 3, borderRadius: 1.5, background: C.card, overflow: "hidden", position: "relative" }}>
          <div style={{ height: "100%", borderRadius: 1.5, width: stepPct + "%", background: "linear-gradient(90deg,#8BF2A8,#30D158)" }} />
        </div>
        <div style={{ display: "flex", padding: "7px 0", borderTop: "1px solid " + C.hairline, borderBottom: "1px solid " + C.hairline, position: "relative" }}>
          {metrics.map(function (m, i) {
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, position: "relative", ...(i > 0 ? { borderLeft: "1px solid " + C.hairline } : {}) }}>
                <span style={{ fontSize: 8, color: C.third, fontWeight: 500, letterSpacing: 0.3 }}>{m.label}</span>
                <span style={{ fontSize: 15, fontWeight: 600, color: m.color, letterSpacing: -0.3, fontVariantNumeric: "tabular-nums" }}>{m.value != null ? m.value : "—"}</span>
                <span style={{ fontSize: 7.5, color: C.third, fontWeight: 500 }}>{m.unit}</span>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 2px", position: "relative" }}>
          <span style={{ fontSize: 9, color: C.third, fontWeight: 500, flexShrink: 0 }}>{T("sleep")}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: C.label, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{fmtSleep(sleep) || "—"}</span>
          <div style={{ flex: 1, height: 4, borderRadius: 2, overflow: "hidden", display: "flex" }}>
            {(sleepTotal ? sleepStages : [{ k: "x", v: 1, c: C.hairline }]).map(function (p) { return <div key={p.k} style={{ flex: Math.max(p.v, 0.001), background: p.c, height: "100%" }} />; })}
          </div>
          <span style={{ fontSize: 8.5, color: C.third, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{t.sleep_deep_min ? T("deepShort") + t.sleep_deep_min + "·REM" + (t.sleep_rem_min || 0) : ""}</span>
        </div>
        {tipText && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 2px", position: "relative" }}>
            <span style={{ width: 4, height: 4, borderRadius: "50%", background: tipDot, opacity: 0.9, flexShrink: 0, boxShadow: "0 0 6px " + tipDot }} />
            <span style={{ fontSize: 9.5, color: C.second, fontWeight: 500, lineHeight: 1.3, flex: 1, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{tipText}</span>
          </div>
        )}
      </div>
    );
  }
}

// ── App：数据加载 + 轮询 + Tauri IPC + 设置 ────────────────────────────────────
function tauriAvailable() {
  return typeof window !== "undefined" && (window.__TAURI_INTERNALS__ || window.__TAURI__);
}

// 大模型实时底部提示
async function genAiTip(data, settings, rolling_averages) {
  if (!settings.llm_base_url || !settings.llm_api_key) return null;
  const td = data && data.today ? data.today : {};
  const hist = (data && Array.isArray(data.history)) ? data.history : [];
  
  // --- 极致优化：同比匹配算法 (Sameday Matching) ---
  // 目标：在历史中寻找与当前时间最接近的“昨日同期”快照，并处理可能的跨天边界情况。
  let yd = null;
  if (hist.length > 0) {
    const now = new Date();
    const now_minutes = now.getHours() * 60 + now.getMinutes();
    let minDiff = Infinity;

    // 遍历历史记录（排除今天）
    for (const h of hist) {
      if (h.date === td.date) continue;

      const h_time = h.time || "00:00";
      const [h_h, h_m] = h_time.split(":").map(Number);
      const h_minutes = h_h * 60 + h_m;

      // 计算绝对分钟差（处理半夜跨天逻辑：例如 00:10 与 23:50 的差值是 20 分钟）
      let diff = Math.abs(now_minutes - h_minutes);
      if (diff > 720) diff = 1440 - diff; // 考虑 24 小时循环

      // 如果在 30 分钟窗口内，且是目前找到的最接近的
      if (diff <= 30 && diff < minDiff) {
        minDiff = diff;
        yd = h;
      }
    }
  }

  // --- 构造强类型的对比对象 ---
  // 确保缺失的数据明确为 null，防止 AI 在面对 {} 时产生幻觉
  const g = (v) => (v === null || v === undefined ? null : v);
  
  const today_ = { 
    steps: g(td.steps), 
    active: g(td.active_minutes), 
    sleep: g(td.sleep_asleep_min), 
    resting_hr: g(td.resting_hr), 
    hrv: g(td.hrv), 
    spo2: g(td.spo2) 
  };
  
  const yd_ = yd ? { 
    steps: g(yd.steps),  
    active: g(yd.active_minutes),  
    sleep: g(yd.sleep_asleep_min),  
    resting_hr: g(yd.resting_hr),  
    hrv: g(yd.hrv),  
    spo2: g(yd.spo2)  
  } : null; // 如果没找到同期数据，设为 null

  const comparison = { 
    今日: today_, 
    昨日同期: yd_, // 可能是 null
    七日平均: rolling_averages 
  };

  const base = settings.llm_base_url.replace(/\/+$/, "");
  const url  = base + "/chat/completions";
  // 方舟 coding 端点不认 "auto"，UI 若选 auto 需兜底到具体模型，否则 404
  const model = (settings.llm_model && settings.llm_model !== "auto")
    ? settings.llm_model : "deepseek-v4-flash";
  
  // --- 重构 System Prompt：引入逻辑优先级与防御性规则 ---
  const sys  =`你是一个亲近、理性的健康助理。我会为你提供“今日”数据、“昨日同期”数据（可能为null）以及“七日平均值”。

请遵循以下逻辑规则进行深度观察：
1. **优先级**：今日数据 > 昨日同期 > 七日平均。
2. **对比逻辑**：
   - 若“昨日同期”存在：请对比今日与昨日的差异（增多/减少/持平），并结合“七日平均值”判断当前状态是处于“常规水平”还是“异常波动”。
   - 若“昨日同期”为null：**严禁**进行数值对比！请仅根据“今日”与“七日平均值”的关系，判断今日是“高于平均”还是“低于平均”。
3. **输出规范**：
   - 20字以内的中文，不含任何标点符号（句号、逗号、叹号等一律不要）。
   - 必须明确趋势（增多/减少/差不多）。
   - 口吻亲切自然，像朋友提醒。
   - 禁止表情符号、专业术语与冗余解释。`;

  const user = JSON.stringify(comparison) + "\n随机因子:" + Math.random();
  const messages = [{ role: "system", content: sys }, { role: "user", content: user }];

  try {
    let raw = null;
    if (tauriAvailable()) {
      raw = await invoke("ai_chat", {
        baseUrl: base,
        apiKey: settings.llm_api_key,
        model: model,
        messages: JSON.stringify(messages),
        maxTokens: 1024,
      });
    } else {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.llm_api_key },
        body: JSON.stringify({ model, messages, temperature: 0.9, max_tokens: 1024 }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) return null;
      raw = await r.text();
    }
    const j = JSON.parse(raw);
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    let c = msg && msg.content;
    if (!c && msg && msg.reasoning_content && /[\u4e00-\u9fa5]/.test(msg.reasoning_content)) {
      c = msg.reasoning_content;
    }
    return c ? c.trim().replace(/\*+/g, "").trim() : null;
  } catch (e) {
    return null;
  }
}
export default function App() {
  const [data, setData] = useState(null);
  const [justResetAt, setJustResetAt] = useState(0);
  const [settings, setSettings] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState(null);

  const [dndActive, setDndActive] = useState(false);
  const [forceWidgetPop, setForceWidgetPop] = useState(false);
  const [aiTip, setAiTip] = useState(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [systemDark, setSystemDark] = useState(true);
  const [testAiStatus, setTestAiStatus] = useState(null); // { status: 'idle'|'testing'|'ok'|'error', message: string }
  const [, forceTick] = useState(0);

  const sedPopRef = useRef(null);
  const settingsRef = useRef(null);

  const aiBusyRef = useRef(false);
  const dataSigRef = useRef("");
  const aiTipRef = useRef(null);      // AI tip 是否已产出（为空则轮询时定期重试）
  const lastAiTryRef = useRef(0);     // 上次尝试时间，失败后退避 5 分钟再试
  const forceAiRefreshRef = useRef(false); // 手动刷新时置位，强制重调一次 AI tip
  // 久坐提醒事件去重：记录已处理（或启动时已存在）的 remind_event 时间戳。
  // 初值 null：首次 load 只记录不弹（避免 app 启动时把历史提醒再弹一遍）
  const lastRemindRef = useRef(null);

  const rerender = useCallback(() => forceTick((x) => x + 1), []);
  const applyTheme = useCallback(() => {
    const s = settingsRef.current;
    const dark = !s ? systemDark : s.theme === "dark" ? true : s.theme === "light" ? false : systemDark;
    C = dark ? C_DARK : C_LIGHT;
    rerender();
  }, [systemDark, rerender]);

  const handleTestApi = useCallback(async () => {
    const s = settingsRef.current;
    if (!s?.llm_base_url || !s?.llm_api_key) {
      setTestAiStatus({ status: 'error', message: T("configMissing") });
      return;
    }
    setTestAiStatus({ status: 'testing', message: T("testLlmTesting") });
    const start = Date.now();
    try {
      const res = await invoke("ai_chat", {
        baseUrl: s.llm_base_url,
        apiKey: s.llm_api_key,
        model: s.llm_model || "deepseek-v4-flash",
        messages: JSON.stringify([{ role: "user", content: "hi" }]),
        maxTokens: 10,
      });
      const latency = Date.now() - start;
      setTestAiStatus({ status: 'ok', message: T("testLlmOk", { ms: latency }) });
    } catch (e) {
      setTestAiStatus({ status: 'error', message: T("testLlmFail", { e: e.message || "unknown" }) });
    }
  }, []);

  // 加载设置 + 应用语言/主题
  const loadSettings = useCallback(async () => {
    if (!tauriAvailable()) return;
    try {
      const s = JSON.parse(await invoke("get_settings"));
      settingsRef.current = s;
      setSettings(s);
      const lang = s.language || "zh-CN";
      setLang(lang);
      // 主动查询系统外观：启动时的 appearance-changed 事件可能早于监听器注册而丢失，
      // 不查的话 systemDark 卡在初始值 true，导致「跟随系统」永远走深色
      let sysDark = systemDark;
      try { sysDark = (await invoke("get_appearance")) === "dark"; } catch (e) {}
      setSystemDark(sysDark);
      const dark = s.theme === "dark" ? true : s.theme === "light" ? false : sysDark;
      C = dark ? C_DARK : C_LIGHT;
      rerender();
    } catch (e) {}
  }, [systemDark, rerender]);

  const load = useCallback(async () => {
    try {
      let parsed = null;
      if (tauriAvailable()) {
        try {
          const s = await invoke("read_data");
          if (s) parsed = JSON.parse(s);
        } catch (e) { /* 忽略，回退示例 */ }
      }
      if (!parsed) {
        const r = await fetch("/sample-data.json");
        if (r.ok) parsed = await r.json();
      }
      if (parsed) {
        // 计算“今日”关键数据签名，仅在步数/活跃分钟/距离/睡眠任一变化时重调 AI
        const today = parsed.today || {};
        const sig = [today.steps|0, today.active_minutes|0, Math.round((today.distance||0)*100), today.sleep_asleep_min|0, today.resting_hr|0].join(",");
        const dataChanged = sig !== dataSigRef.current;
        if (dataChanged) dataSigRef.current = sig;
        setData(parsed);
        // 大模型底部提示：数据有变化时重调（跟随最新数据）；手动点刷新按钮时
        // 强制重调一次（forceAiRefreshRef 在 onRefresh 置位，消费后清除）。
        // 已有可见提示时后台静默刷新（不闪「正在分析…」），仅首次/无提示时才显示思考态。
        const s = settingsRef.current;
        const now = Date.now();
        const forceAi = !!forceAiRefreshRef.current;
        forceAiRefreshRef.current = false; // 消费掉本次强制刷新标记
        if (s && s.llm_base_url && s.llm_api_key && !aiBusyRef.current && (dataChanged || forceAi)) {
          aiBusyRef.current = true;
          lastAiTryRef.current = now;
          const silent = !!aiTipRef.current;
          if (!silent) setAiThinking(true);
          const tip = await genAiTip(parsed, s, parsed.rolling_averages);
          aiBusyRef.current = false;
          if (!silent) setAiThinking(false);
          if (tip) { aiTipRef.current = tip; setAiTip(tip); }
        } else if (!s || !s.llm_base_url) {
          setAiThinking(false);
          setAiTip(null);
        }
        // 勿扰检测（仅久坐时查）
        if (tauriAvailable() && today.sedentary && s && s.respect_dnd) {
          try { setDndActive(await invoke("is_dnd_active")); } catch (e) {}
        } else {
          setDndActive(false);
        }
        // 久坐提醒弹窗：Python 触发提醒时会在 data.json 写 remind_event（ms 时间戳），
        // 检测到新事件 → 在菜单栏图标下方弹出提醒面板（样式/文案与小组件弹窗一致）；
        // 勿扰模式下只亮小组件不弹
        const remindEvent = today.remind_event || 0;
        if (remindEvent > 0 && remindEvent !== lastRemindRef.current) {
          lastRemindRef.current = remindEvent;
          if (tauriAvailable()) {
            setForceWidgetPop(true);
            let dnd = false;
            if (s && s.respect_dnd) { try { dnd = await invoke("is_dnd_active"); } catch (e) {} }
            if (!dnd) {
              try { await invoke("show_sed_popover"); } catch (e) {}
            }
          }
        }
      }
    } catch (e) {
      console.warn("load failed", e);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    document.body.classList.add("hd-refreshing");
    forceAiRefreshRef.current = true; // 手动刷新强制重调 AI tip（每次点刷新都出新提示）
    // 记住当前数据签名，等 Python 采集真正写完（数据变化）再读新数据
    const beforeSig = data && data.today
      ? [data.today.steps, data.today.distance, data.today.calories, data.today.updated_at].join("|")
      : null;
    if (tauriAvailable()) {
      try { await invoke("refresh_now"); } catch (e) {}
    }
    // 轮询等待采集完成（数据签名变化），最多等 120 秒
    const startMs = Date.now();
    const poll = () => {
      if (Date.now() - startMs >= 120000) { document.body.classList.remove("hd-refreshing"); return; }
      if (tauriAvailable()) {
        invoke("read_data").then(s => {
          if (s) {
            const d = JSON.parse(s);
            if (d && d.today) {
              const sig = [d.today.steps, d.today.distance, d.today.calories, d.today.updated_at].join("|");
              if (beforeSig === null || sig !== beforeSig) {
                load();
                document.body.classList.remove("hd-refreshing");
                return;
              }
            }
          }
        }).catch(() => {});
      }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  }, [load, data]);

  const onReset = useCallback(async () => {
    setJustResetAt(Date.now());
    if (tauriAvailable()) {
      try { await invoke("reset_sedentary"); } catch (e) {}
    }
    setTimeout(load, 1500);
    setTimeout(() => setJustResetAt(0), 90000);
  }, [load]);





  // 打开/关闭设置
  const openSettings = useCallback(() => {
    if (settingsRef.current) {
      setDraft({ ...settingsRef.current, useCurrent: false });
      setSettingsOpen(true);
    }
  }, []);

  const onSave = useCallback(async () => {
    if (!draft) return;
    setSaveBusy(true);
    const s = { ...draft };
    delete s.useCurrent;
    // 语言立即生效
    setLang(s.language || "zh-CN");
    const dark = s.theme === "dark" ? true : s.theme === "light" ? false : systemDark;
    C = dark ? C_DARK : C_LIGHT;
    rerender();
    try {
      await invoke("save_settings", { json: JSON.stringify(s) });
      settingsRef.current = s;
      setSettings(s);
      // 位置固定为默认（与 macOS 小组件对齐），不再运行时拖拽/多屏定位
      setSettingsOpen(false);
    } catch (e) { console.warn("save failed", e); }
    setSaveBusy(false);
  }, [draft, systemDark, rerender]);

  // 点击菜单栏图标 → 弹出/关闭设置面板
  useEffect(() => {
    if (!tauriAvailable()) return;
    let unlisten1 = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("toggle-settings", () => {
        setSettingsOpen(prev => !prev);
      }).then(u => { unlisten1 = u; });

    });
    return () => { if (unlisten1) unlisten1(); };
  }, []);

  // 系统外观事件
  useEffect(() => {
    if (!tauriAvailable()) return;
    let unlisten = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("appearance-changed", (e) => {
        const dark = e.payload === "dark";
        setSystemDark(dark);
        const s = settingsRef.current;
        const eff = !s ? dark : s.theme === "dark" ? true : s.theme === "light" ? false : dark;
        C = eff ? C_DARK : C_LIGHT;
        rerender();
      }).then((u) => { unlisten = u; });
    });
    return () => { if (unlisten) unlisten(); };
  }, [rerender]);

  // 菜单/命令修改设置后实时应用（主题 / 语言 / 屏幕选择等）
  useEffect(() => {
    if (!tauriAvailable()) return;
    let unlisten = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("settings-changed", async (e) => {
        try {
          const s = JSON.parse(e.payload);
          settingsRef.current = s;
          setSettings(s);
          setLang(s.language || "zh-CN");
          const dark = s.theme === "dark" ? true : s.theme === "light" ? false : systemDark;
          C = dark ? C_DARK : C_LIGHT;
          rerender();
          // 设置变了（尤其是 LLM）：若配了 LLM 且有数据，立即重新生成 AI 建议
          if (s.llm_base_url && s.llm_api_key && !aiBusyRef.current && data) {
            // 强制重置签名 + 重调 AI
            dataSigRef.current = "";
            aiBusyRef.current = true;
            lastAiTryRef.current = Date.now();
            setAiThinking(true);
            const tip = await genAiTip(data, s, data.rolling_averages);
            aiBusyRef.current = false;
            setAiThinking(false);
            if (tip) { aiTipRef.current = tip; setAiTip(tip); }
          } else if (!s.llm_base_url || !s.llm_api_key) {
            setAiThinking(false);
            aiTipRef.current = null;
            setAiTip(null);
          }
        } catch (err) {}
      }).then((u) => { unlisten = u; });
    });
    return () => { if (unlisten) unlisten(); };
  }, [systemDark, rerender]);

  useEffect(() => {
    // 关键：先等设置从磁盘读回（含 llm_base_url/key），再首次拉数据。
    // 否则 load() 里 settingsRef 还是空，AI 调用被跳过且签名已消费，之后轮询永不再调（蓝点根因）
    (async () => {
      await loadSettings();
      await load();
    })();
    const id = setInterval(load, 5000); // 轻量轮询，数据变化即重渲染
    return () => clearInterval(id);
  }, [loadSettings, load]);

  const bottomTip = aiThinking ? T("aiThinking") : (aiTip || null);

  return (
    <div onContextMenuCapture={(e) => e.preventDefault()} style={{ width: "100%", height: "100%", position: "relative", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none", WebkitUserDrag: "none" }}>
      {data ? (
        <Widget
          data={data}
          settings={settings || {}}
          onRefresh={onRefresh}
          onReset={onReset}
          justResetAt={justResetAt}
          sedPopRef={sedPopRef}
          dndActive={dndActive}
          bottomTip={bottomTip}
          forceWidgetPop={forceWidgetPop}
          setForceWidgetPop={setForceWidgetPop}
        />
      ) : (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.5)", fontSize: 12 }}>
          {T("loading")}
        </div>
      )}
      {settingsOpen && draft && (
                <SettingsPanel
          draft={draft}
          setDraft={setDraft}
          onSave={onSave}
          onCancel={() => setSettingsOpen(false)}
          busy={saveBusy}
          rerender={rerender}
          systemDark={systemDark}
          onTestApi={handleTestApi}
          testStatus={testAiStatus}
        />
      )}
    </div>
  );
}