// ─────────────────────────────────────────────────────────────────────────────
// App.jsx —— 健康仪表盘（Tauri 跨平台版）
// 由 Übersicht 版 index.jsx 移植：去掉 command/refreshFrequency/render 全局，
// 改为 React 组件 + Tauri IPC。情绪球 JS 内联进 iframe（无 HTTP 服务）。
// 新增：多语言 / 明暗主题 / 设置面板 / 拖拽定位 / 勿扰抑制 / 大模型底部提示。
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

// 云宝 / 亮亮（aora-bot mood-mates 引擎，纯前端 SVG 角色，无 HTTP 依赖）
import mmGeometry from "./mood-mates/geometry.js?raw";
import mmRender from "./mood-mates/render.js?raw";
import mmFeatures from "./mood-mates/features.js?raw";
import mmFx from "./mood-mates/fx.js?raw";
import mmEmotions from "./mood-mates/emotions.js?raw";
import mmEngine from "./mood-mates/engine.js?raw";
import mmNimbo from "./mood-mates/nimbo.js?raw";
import mmTwinkle from "./mood-mates/twinkle.js?raw";
// pixel Claw（clawd-pet，148 个纯 SVG 状态，经 src/claw/index.js 以 glob 读入）
import { CLAW, CLAW_ORDER } from "./claw/index.js";

const EB_LIBS = [ringsJs, emotionsJs, ballJs, engineJs]
  .map((s) => s.replace(/<\/script>/gi, "<\\/script>"))
  .join("</script>\n<script>");

const MM_LIBS = [mmGeometry, mmRender, mmFeatures, mmFx, mmEmotions, mmEngine]
  .map((s) => s.replace(/<\/script>/gi, "<\\/script>"))
  .join("</script>\n<script>");

// ── 自动换表情 ───────────────────────────────────────────────────────────────
// 每 5 秒自己换一个表情。原先只有球球有 4.5s 定时器（久坐时还不启动），云宝/亮亮/claw
// 全程静止；且闲置 60s→待机、180s→睡眠后卡死不再变（「垂头丧气」就是这么来的）。
// 现统一走引擎自带的 startTour —— 它会置 _touring，让 idle 降级整段跳过，所以不会再趴下。
const ROTATE_MS = 5000;

// 活动池：有活力 / 中性 / 正向，刻意避开 00-09 生命周期（睡眠/休眠）与错误类
const EASE_IDS = ["10", "19", "03", "13", "14", "16", "30", "11", "20", "33", "31", "35", "36", "04", "02", "18"];
// 久坐池：生气 · 失落 · 疲惫 · 无奈（愤怒 + 低情绪）
const SED_IDS = ["21", "12", "15", "18"];

// claw 版安全池（从 148 个 clawd-* 里挑出来的，排除 HTTP 状态码 / 节日 / error / 低电量）
const EASE_SLUGS = ["clawd-happy", "clawd-smile", "clawd-laughing", "clawd-cool", "clawd-hopeful", "clawd-love", "clawd-celebrating", "clawd-waving", "clawd-music", "clawd-coffee", "clawd-dancing", "clawd-reading", "clawd-idea", "clawd-star", "clawd-rainbow", "clawd-peeking", "clawd-singing", "clawd-flexing"];
const SED_SLUGS = ["clawd-angry", "clawd-grumpy", "clawd-sad", "clawd-yawning", "clawd-shrug", "clawd-facepalm"];
// 睡眠态不轮换（免得凌晨三点还在笑）
const SLEEP_SLUGS = ["clawd-sleeping"];

// 把健康派生表情 id 映射成 clawd-pet 的某个状态 slug（仅做粗略情绪分流）
function clawSlugFor(eid, sed) {
  if (sed) return "clawd-angry"; // 久坐 → 生气（随后在 SED_SLUGS 池内轮换）
  if (eid === "00") return "clawd-sleeping";
  if (eid === "33" || eid === "10") return "clawd-celebrating";
  if (eid === "19" || eid === "03" || eid === "13") return "clawd-happy";
  if (eid === "21") return "clawd-angry";
  if (eid === "34" || eid === "39" || eid === "40") return "clawd-error";
  if (eid === "15") return "clawd-sick";
  if (eid === "02") return "clawd-idle-living";
  return "clawd-idle-living";
}

// 按当前角色生成 iframe 文档（完全离线自包含，无 HTTP 服务）
function buildWidgetDoc(character, eid, sed) {
  // 省电休眠闸门：当 Mac 锁屏、小组件隐藏或收到父窗口 {type:'hd-power', paused:true} 时，
  // 挂起 requestAnimationFrame 与巡演定时器，使后台 CPU/GPU 占用降为 0.0%。
  const POWER_GATE =
    "(function(){" +
      "var _raf=window.requestAnimationFrame.bind(window);" +
      "var _q=[];window.__hdPaused=false;" +
      "window.requestAnimationFrame=function(cb){" +
        "if(window.__hdPaused||document.hidden){if(_q.length<8)_q.push(cb);return 0;}" +
        "return _raf(cb);" +
      "};" +
      "function setPaused(p){" +
        "var next=!!p;if(window.__hdPaused===next)return;window.__hdPaused=next;" +
        "if(!next){var q=_q.splice(0,_q.length);for(var i=0;i<q.length;i++)_raf(q[i]);}" +
      "}" +
      "window.addEventListener('message',function(e){if(e&&e.data&&e.data.type==='hd-power')setPaused(e.data.paused);});" +
      "document.addEventListener('visibilitychange',function(){setPaused(document.hidden);});" +
    "})();";

  const HEAD = "<!doctype html><html><head><meta charset='utf-8'>" +
    "<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%;-webkit-user-select:none;user-select:none}" +
    "#bot{width:100%;height:100%;display:flex;align-items:center;justify-content:center}#bot svg{display:block;width:100%;height:100%}</style></head><body><div id='bot'></div>" +
    "<script>" + POWER_GATE + "document.addEventListener('contextmenu',function(e){e.preventDefault();});document.addEventListener('selectstart',function(e){e.preventDefault();});document.addEventListener('click',function(){try{if(window.__cycleEmotion)window.__cycleEmotion();}catch(e){}try{window.parent.postMessage({type:'hd-pet-click'},'*');}catch(e){}});</script>";
  const esc = (s) => s.replace(/<\/script>/gi, "<\\/script>");
  const SED = sed ? "true" : "false";
  const ROT = String(ROTATE_MS);

  // 引擎角色（球球 / 云宝 / 亮亮）共用的自动换表情脚本：
  // 先显示健康数据派生的 base 表情（尊重数据），随后每 ROT 毫秒在池内轮换；
  // 点击立即换一个并重新计时；睡眠态（00）不轮换，保持睡着。
  const ENGINE_ROT =
    "var EASE_IDS=" + JSON.stringify(EASE_IDS) + ",SED_IDS=" + JSON.stringify(SED_IDS) + ";" +
    "var base='" + eid + "';var pool=" + SED + "?SED_IDS:EASE_IDS;" +
    "var arr=[base].concat(pool.filter(function(x){return x!==base;}));" +
    "window.__cycleEmotion=function(){" +
      "var n;do{n=pool[Math.floor(Math.random()*pool.length)];}while(n===base&&pool.length>1);base=n;" +
      "try{window.__char.startTour([n].concat(pool.filter(function(x){return x!==n;}))," + ROT + ");}" +
      "catch(e){try{window.__char.setEmotion(n);}catch(e2){}}};" +
    "if(base!=='00'){try{window.__char.startTour(arr," + ROT + ");}catch(e){}}";

  if (character === "nimbo" || character === "twinkle") {
    const charId = character === "nimbo" ? "nimbo" : "twinkle";
    const charFile = charId === "nimbo" ? esc(mmNimbo) : esc(mmTwinkle);
    return HEAD +
      "<script>" + MM_LIBS + "</script>" +
      "<script>" + charFile + "</script>" +
      "<script>(function(){try{" +
        "var m=MoodMates.create(document.getElementById('bot'),{character:'" + charId + "',emotion:'" + eid + "',idle:true,eyeScale:1.5});" +
        "window.__char=m;window.__charReady=true;" +
        ENGINE_ROT +
      "}catch(e){document.title='ERR:'+(e.message||e).slice(0,80)}})()</script>" +
      "</body></html>";
  }

  if (character === "claw") {
    const st = clawSlugFor(eid, sed);
    // 全量状态：{ slug: '<svg...>', ... } + 有序 slug 列表，全部内联进 iframe
    const json = JSON.stringify(CLAW);
    const order = JSON.stringify(CLAW_ORDER);
    return HEAD +
      "<script>(function(){try{" +
        "var svgs=" + json + ";var order=" + order + ";var el=document.getElementById('bot');" +
        "function show(k){try{el.innerHTML=svgs[k]||svgs[order[0]];}catch(e){}}" +
        "var base=" + JSON.stringify(st) + ";show(base);" +
        "window.__char={setGaze:function(){},clearGaze:function(){}};window.__charReady=true;" +
        // 只在安全池内轮换（原先是从全部 148 个里随机 → 会抽到 clawd-404 / 500 / 圣诞装）；
        // 顺序巡演 + base 回归，行为与引擎角色的 startTour 对齐
        "var pool=" + SED + "?" + JSON.stringify(SED_SLUGS) + ":" + JSON.stringify(EASE_SLUGS) + ";" +
        "var arr=[base].concat(pool.filter(function(x){return x!==base;}));" +
        "var asleep=" + JSON.stringify(SLEEP_SLUGS) + ".indexOf(base)>=0;var t=0,ai=0;" +
        "function tick(){ai=(ai+1)%arr.length;base=arr[ai];show(base);}" +
        "window.__cycleEmotion=function(){var n;do{n=pool[Math.floor(Math.random()*pool.length)];}while(n===base&&pool.length>1);" +
          "base=n;arr=[n].concat(pool.filter(function(x){return x!==n;}));ai=0;show(n);" +
          "if(t)clearInterval(t);t=setInterval(tick," + ROT + ");};" +
        "if(!asleep){t=setInterval(tick," + ROT + ");}" +
      "}catch(e){document.title='ERR:'+(e.message||e).slice(0,80)}})()</script>" +
      "</body></html>";
  }

  // 默认：球球（emotion-ball）
  return HEAD +
    "<script>" + EB_LIBS + "</script>" +
    "<script>(function(){try{" +
      "var b=EmotionBall.create(document.getElementById('bot')," +
      "{emotion:'" + eid + "',shape:'blob',eyeScale:1.7,idle:true,lite:true,autostart:true});" +
      "window.__char=b;window.__charReady=true;" +
      ENGINE_ROT +
    "}catch(e){document.title='ERR:'+(e.message||e).slice(0,80)}})()</script>" +
    "</body></html>";
}

// ── Apple system palette ─────────────────────────────────────────────────────
const C_DARK = {
  // 保持文字纯白高不透明度 + 亮色系数值，背景恢复极通透液态玻璃，靠光学阴影拉高对比度
  label: "rgba(255,255,255,1)",
  second: "rgba(255,255,255,0.96)",
  third: "rgba(255,255,255,0.88)",
  bg: "rgba(0,0,0,0.06)",
  card: "rgba(255,255,255,0.11)",
  hairline: "rgba(255,255,255,0.14)",
  rim: "rgba(255,255,255,0.34)",
  rimSoft: "rgba(255,255,255,0.15)",
  glassCtl: "rgba(255,255,255,0.12)",
  green: "#3EE068",
  red: "#FF5C7C",
  blue: "#409CFF",
  teal: "#56D8F0",
  indigo: "#8F8DFF",
  amber: "#FFB340",
  alert: "#FF5A4F",
};
const C_LIGHT = {
  label: "rgba(0,0,0,0.98)",
  second: "rgba(18,18,24,0.95)",
  third: "rgba(30,30,38,0.88)",
  bg: "transparent",
  card: "rgba(0,0,0,0.04)",
  hairline: "rgba(0,0,0,0.09)",
  rim: "rgba(255,255,255,0.62)",
  rimSoft: "rgba(255,255,255,0.25)",
  glassCtl: "rgba(255,255,255,0.18)",
  green: "#157A2E",
  red: "#C80014",
  blue: "#005EC4",
  teal: "#006B80",
  indigo: "#4338CA",
  amber: "#A84800",
  alert: "#C80014",
};
// 本地提示兜底池：LLM 未配置 / 失败时启用（蓝点），按分钟轮换保证「久不更新」也能变
const SEDENTARY_TIPS = [
  "已经坐了快一小时，起身活动两分钟吧，腰背和颈椎都会舒服很多。",
  "离开椅子到窗边走走吧，舒展筋骨看看远处，让眼睛也放松一下吧。",
  "久坐让身体变得紧绷了，起身倒杯水伸个懒腰吧，真的会舒服很多。",
  "坐久了脖子和腰都很疲劳，起身拉伸两分钟，身体会重新充满活力。",
];
const FALLBACK_TIPS = [
  "喝杯温水润润喉，起身活动两分钟，让身体从工位中短暂抽离出来。",
  "深呼吸几次放松肩膀，舒展一下手腕脖子，让久坐的身体缓口气吧。",
  "休息一下看看远方，活动颈椎和手腕，眨眨眼让眼睛也放松一下吧。",
  "保持节奏张弛有度，工作和休息都要兼顾，状态才会更稳定更持久。",
  "今天的目标已经很接近，深呼吸继续坚持吧，加油，你一定可以的。",
  "保持好心情很重要，深呼吸给自己一个微笑，状态一定会慢慢变好。",
  "工作再忙也要记得喝水，起身倒杯水走两步吧，身体会很感谢你的。",
  "午后容易困倦没精神，深呼吸提提神，起身走动两分钟真的会清醒。",
];
// 当前生效调色板（唯一液态玻璃，随系统/设置切换深浅）
let C = C_DARK;
function pickPalette(_style, dark) {
  return dark ? C_DARK : C_LIGHT;
}
const isPixel = () => false;
const isBrutal = () => false;
const isTerm = () => false;

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

function computeBallEmotion(t, sedOverride, stepGoal) {
  if (!t) return "02";
  const isSed = sedOverride !== undefined ? sedOverride : t.sedentary;
  // 久坐 → 生气。这里必须返回确定值：每次 render 随机会让 srcDoc 字符串变化，
  // 父组件轮询时若重建 iframe，里面的轮换定时器会被清零。
  if (isSed) return "21";
  const tip = t.tip_level;
  const sleep = t.sleep_asleep_min || 0;
  const steps = t.steps || 0;
  const liveHr = t.heart_rate || 0;
  const goal = stepGoal || 8000;
  const hr = new Date().getHours();
  if (tip === "alert" || liveHr >= 115) return "17";
  if (tip === "warn") return sleep < 300 ? "15" : "11";
  if (hr >= 23 || hr < 6) return "00";
  if (sleep > 0 && sleep < 240) return "00";
  if (sleep > 0 && sleep < 360) return "15";
  if (steps >= goal) return "33";
  if (steps > 0 && steps < 2000) return "12";
  return "19";
}

// 只清洗 emoji / 不可见符号，保留中文标点（早期版本为配合「无标点」提示词会删标点，现不需要）
function cleanTip(s) {
  if (!s) return "";
  let t = s
    .replace(/[🀀-🿿﻿‍]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  // 兜底：模型偶尔仍会漏掉句末标点
  if (t && !/[。！？!?…]$/.test(t)) t += "。";
  return t;
}

// ── Settings panel（覆盖在小组件之上的滚动设置层）────────────────────────────
function SettingsPanel({ draft, setDraft, onSave, onCancel, busy, rerender, systemDark, onTestApi, testStatus, onTestDataApi, testDataStatus }) {
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

  // API 测试行：内嵌在「对应 API 的设置卡片」里（数据 API → Google 卡片，LLM → AI 卡片），
  // 避免测试入口被挤出可视区、需要长距离滚动才找得到。
  const apiTestRow = (onTest, status) => {
    const st = status?.status;
    const btnBg = st === "testing" ? C.amber : st === "ok" ? C.green : st === "error" ? C.alert : C.blue;
    const btnText = st === "testing" ? "测试中…" : st === "ok" ? "测试成功" : st === "error" ? "重新测试" : "测试延迟";
    return (
      <div style={{ marginTop: 7 }}>
        <div onClick={st === "testing" ? undefined : onTest}
          style={{ ...guideBtn, marginTop: 0, background: btnBg, opacity: st === "testing" ? 0.7 : 1 }}>
          {btnText}
        </div >
        {status && status.message && (
          <div style={{ fontSize: 8.5, color: st === "error" ? C.alert : C.second, marginTop: 4, lineHeight: 1.35, fontVariantNumeric: "tabular-nums" }}>
            {status.message}
          </div >
        )}
      </div >
    );
  };
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
        padding: "12px 14px 16px", borderRadius: 24,
        background: C.bg,
        border: "1px solid " + C.hairline, boxSizing: "border-box",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: C.label, marginBottom: 6 }}>{T("settingsTitle")}</div>

      {/* ── 久坐提醒（置顶高亮卡片：自定义阈值 + 提醒时段）── */}
      <div style={sedCard}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.amber, marginBottom: 7 }}>
          {ICO.chair}{" 久坐提醒"}
        </div>
        <label style={sedLabel}>{T("sedThreshold")}</label>
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
        <label style={sedLabel}>{T("notifyWindow")}</label>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 2 }}>
          {[[10, 19, "10:00–19:00"], [9, 22, "09:00–22:00"], [8, 23, "08:00–23:00"]].map(([sh, eh, lbl]) => {
            const curS = draft.notify_start_hour != null ? draft.notify_start_hour : 9;
            const curE = draft.notify_end_hour != null ? draft.notify_end_hour : 22;
            const active = curS === sh && curE === eh;
            return (
              <div key={lbl} onClick={() => { set("notify_start_hour", sh); set("notify_end_hour", eh); }}
                style={{ flex: 1, textAlign: "center", fontSize: 9.5, fontWeight: 600, padding: "4px 0", borderRadius: 8, cursor: "pointer",
                  background: active ? C.amber : "rgba(128,128,128,0.14)",
                  color: active ? "#fff" : C.second }}>
                {lbl}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 10, color: C.second }}>
            <input type="checkbox" checked={draft.lunch_break_mute !== false} onChange={(e) => set("lunch_break_mute", e.target.checked)} style={{ accentColor: C.amber }} />
            <span>{T("lunchBreakMute")}</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 10, color: C.second }}>
            <input type="checkbox" checked={draft.workdays_only !== false} onChange={(e) => set("workdays_only", e.target.checked)} style={{ accentColor: C.amber }} />
            <span>{T("workdaysOnly")}</span>
          </label>
        </div>
      </div>

      {/* ── 每日步数目标 ── */}
      <label style={labelStyle}>{T("stepGoal")}</label>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 3 }}>
        {[6000, 8000, 10000, 12000].map((g) => {
          const active = (draft.step_goal || 8000) === g;
          return (
            <div key={g} onClick={() => set("step_goal", g)}
              style={{ flex: 1, textAlign: "center", fontSize: 10, fontWeight: 600, padding: "4px 0", borderRadius: 8, cursor: "pointer",
                background: active ? C.green : "rgba(128,128,128,0.14)",
                color: active ? "#fff" : C.second }}>
              {g.toLocaleString()}
            </div>
          );
        })}
      </div>

      {/* ── 跟随系统勿扰开关 ── */}
      <div style={rowStyle}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: C.label }}>{"跟随系统勿扰"}</div>
        <div onClick={() => set("dnd_follow", !(draft.dnd_follow !== false))} style={checkStyle(draft.dnd_follow !== false)}>
          {(draft.dnd_follow !== false) && <div style={{ width: 8, height: 8, borderRadius: 2, background: "#fff" }} />}
        </div>
      </div>
      <div style={{ fontSize: 8.5, color: C.third, marginTop: 2, lineHeight: 1.35 }}>
        {"开启后，系统专注模式（勿扰）开启时不会弹久坐提醒；关闭则始终提醒。"}
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
            C = pickPalette(draft.style, dark);
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

      <div style={{ height: 1, background: C.hairline, margin: "10px 0 4px" }} />

      {/* ── Google 健康（浏览器引导 + 数据 API 延迟测试）── */}
      <div style={guideCard}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.label }}>Google 健康数据</div >
        <div style={{ fontSize: 9.5, color: C.third, marginTop: 3, lineHeight: 1.35 }}>配置 Google 授权与 AI 模型（Base URL / Key / 模型）。点击在浏览器打开本地设置页，可在页内直接测延迟。</div >
        <div onClick={() => { tauriAvailable() ? invoke("open_setup_wizard_cmd").catch(() => {}) : openExternal(GOOGLE_SETUP_URL); }} style={guideBtn}>在浏览器中设置 →</div >
        {apiTestRow(onTestDataApi, testDataStatus)}
      </div >

      {/* ── AI 模型（浏览器引导 + LLM API 延迟测试）── */}
      <div style={guideCard}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.label }}>AI 提示语</div >
        <div style={{ fontSize: 9.5, color: C.third, marginTop: 3, lineHeight: 1.35 }}>AI 模型在设置页的「AI 健康建议」段配置，可在页内直接测延迟。</div >
        <div onClick={() => { tauriAvailable() ? invoke("open_setup_wizard_cmd").catch(() => {}) : openExternal(AI_SETUP_URL); }} style={guideBtn}>在浏览器中设置 →</div >
        {apiTestRow(onTestApi, testStatus)}
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
function Widget({ data, settings, appIdentity, character, onRefresh, onReset, onCycleTip, justResetAt, sedPopRef, dndActive, bottomTip, forceWidgetPop, setForceWidgetPop, powerPaused, musicPlaying, snapEdges }) {
  const [trendMetric, setTrendMetric] = useState(null);
  const [hoverTrendIdx, setHoverTrendIdx] = useState(null);
  const [petBounce, setPetBounce] = useState(false);
  const [ripples, setRipples] = useState([]);
  const glassRef = useRef(null);
  const spawnRipple = useCallback((e) => {
    const el = glassRef.current;
    if (!el || e.button !== 0) return;
    const r = el.getBoundingClientRect();
    const id = Date.now() + Math.random();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    setRipples((prev) => [...prev.slice(-3), { id, x, y }]);
    setTimeout(() => {
      setRipples((prev) => prev.filter((item) => item.id !== id));
    }, 600);
  }, []);
  const styleId = settings && settings.style;
  const brutal = isBrutal(styleId);
  const term = isTerm(styleId);
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
  const lastSyncTime = t.last_sync_time || updated;
  const syncAgeMin = t.sync_age_min;
  const syncStale = !!t.sync_stale;
  const offWrist = !!t.off_wrist;
  const deviceName = t.device_name || "Fitbit";
  const deviceBattery = t.device_battery != null ? Number(t.device_battery) : null;
  const deviceBatteryStatus = t.device_battery_status || "";
  const sedentary = !!t.sedentary;
  const idleMin = t.idle_min != null ? t.idle_min : null;
  const stepGoal = (settings && settings.step_goal) ? Number(settings.step_goal) : 8000;

  const now = new Date();

  const justReset = (Date.now() - justResetAt) < 90000;
  const effSed = justReset ? false : sedentary;
  const effIdle = justReset ? 0 : idleMin;
  const eid = computeBallEmotion(t, effSed, stepGoal);

  // memo：buildWidgetDoc 内含 148 个 SVG 的 JSON.stringify，且字符串一旦变化 iframe 就会
  // 整个重载（内部轮换定时器归零）。eid 已改成确定值，这里再兜一层。
  const ballDoc = useMemo(() => buildWidgetDoc(character, eid, effSed), [character, eid, effSed]);

  const ballIframeRef = useRef(null);
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  const powerPausedRef = useRef(powerPaused);
  powerPausedRef.current = powerPaused;

  // 锁屏 / 隐藏时向萌宠 iframe 发送休眠指令，唤醒时恢复动画
  useEffect(() => {
    try {
      const el = ballIframeRef.current;
      const w = el && el.contentWindow;
      if (w) w.postMessage({ type: "hd-power", paused: !!powerPaused }, "*");
    } catch (e) {}
  }, [powerPaused, ballDoc]);

  // 点击萌宠 iframe 时触发弹性微交互（无声）
  useEffect(() => {
    let timer = null;
    const onMsg = (e) => {
      if (e && e.data && e.data.type === "hd-pet-click") {
        setPetBounce(false);
        requestAnimationFrame(() => {
          setPetBounce(true);
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => setPetBounce(false), 460);
        });
      }
    };
    window.addEventListener("message", onMsg);
    return () => {
      window.removeEventListener("message", onMsg);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 父窗口级的「眼睛跟随鼠标」gaze（带 Mac 省电优化）：
  // 1) 30fps 时间戳节流（避免高回报率鼠标每秒触发数百次跨 iframe 调用）；
  // 2) getBoundingClientRect 坐标缓存 2 秒（消除每次 mousemove 的同步布局重排）；
  // 3) 鼠标距离萌宠超过 320px 时自动进入距离休眠态（clearGaze 后零开销直接跳过）。
  useEffect(() => {
    const clampN = (v, a, b) => (v < a ? a : (v > b ? b : v));
    let lastTick = 0;
    let cachedCenter = null;
    let cachedAt = 0;
    let gazeIdle = true;

    const onMove = (e) => {
      if (powerPausedRef.current || document.hidden) return;
      const nowMs = performance.now();
      if (nowMs - lastTick < 33) return; // 30fps 节流
      lastTick = nowMs;
      try {
        const el = ballIframeRef.current;
        const w = el && el.contentWindow;
        if (!w || !w.__char) return;
        if (!cachedCenter || nowMs - cachedAt > 2000) {
          const rect = el.getBoundingClientRect();
          cachedCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          cachedAt = nowMs;
        }
        const dx = e.clientX - cachedCenter.x;
        const dy = e.clientY - cachedCenter.y;
        const distSq = dx * dx + dy * dy;
        // 距离超过 320px：进入静息态，不再高频跨 iframe 调用
        if (distSq > 320 * 320) {
          if (!gazeIdle) {
            gazeIdle = true;
            w.__char.clearGaze();
          }
          return;
        }
        gazeIdle = false;
        const s = latestSettingsRef.current;
        const R = (s && s.gaze_radius) ? s.gaze_radius : 80;
        const TH = (s && s.gaze_threshold) ? s.gaze_threshold : 1.0;
        let nx = clampN(dx / R, -1, 1);
        let ny = clampN(dy / R, -1, 1);
        nx = clampN(nx, -TH, TH);
        ny = clampN(ny, -TH, TH);
        w.__char.setGaze(nx, ny);
      } catch (err) {}
    };
    const onLeave = () => {
      try {
        gazeIdle = true;
        const el = ballIframeRef.current;
        const w = el && el.contentWindow;
        if (w && w.__char) w.__char.clearGaze();
      } catch (err) {}
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, []);

  const ballIframe = (
    <iframe
      ref={ballIframeRef}
      srcDoc={ballDoc}
      style={{ width: 52, height: 52, border: "none", background: "transparent", display: "block", flexShrink: 0, borderRadius: "50%", cursor: "pointer", overflow: "hidden" }}
      title="mood-ball"
    />
  );

  // 久坐弹窗（勿扰模式下按设置抑制）
  const SED_POP_KEY = "health-widget-sed-pop-v1";
  let popDismissed = false;
  try {
    const rec = JSON.parse(localStorage.getItem(SED_POP_KEY) || "null");
    popDismissed = !!(rec && rec.date === t.date && rec.idle === idleMin);
  } catch (e) {}
  const dndBlock = dndActive && (settings ? settings.dnd_follow !== false : true);
  const snoozeUntil = Number(t.snooze_until || 0);
  const snoozed = snoozeUntil > Date.now();
  const showSedPop = (effSed || forceWidgetPop) && effIdle != null && !popDismissed && !dndBlock && !snoozed;

  const dismissSedPop = function () {
    try { localStorage.setItem(SED_POP_KEY, JSON.stringify({ date: t.date, idle: idleMin })); } catch (e) {}
    setForceWidgetPop(false);
  };

  const grooving = !!(musicPlaying && !effSed && !powerPaused);
  const ballWrap = (
    <div data-tauri-drag-region="false" className={petBounce ? "hd-pet-bouncing" : grooving ? "hd-pet-grooving" : undefined} style={{ position: "relative", width: 52, height: 52, flexShrink: 0, zIndex: 10 }}>
      {ballIframe}
      {grooving && (
        <>
          <span className="hd-music-note" style={{ right: 2, top: 4, color: C.teal, animationDelay: "0s" }}>♪</span>
          <span className="hd-music-note" style={{ right: -4, top: 14, color: C.green, animationDelay: "0.95s" }}>♫</span>
        </>
      )}
    </div>
  );

  // 久坐弹窗四态样式集：像素（金黑 NES）/ 粗野（黑白硬边衬线）/ 终端（荧光绿细边等宽）/ 玻璃（磨砂）
  const sedS = (function () {
    if (isPixel(styleId)) {
      return {
        c: { position: "absolute", top: "calc(100% + 18px)", left: "50%", marginLeft: -93, width: 186, boxSizing: "border-box", zIndex: 50, borderRadius: 0, padding: "9px 11px 8px", background: C.amber, border: "2px solid #1a1040", boxShadow: "4px 4px 0 #1a1040", fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, monospace", display: showSedPop ? "block" : "none", animation: "sed-pop .15s steps(4)" },
        a: { position: "absolute", top: -5, left: "50%", marginLeft: -5, width: 10, height: 10, background: C.amber, border: "2px solid #1a1040", borderRight: "none", borderBottom: "none" },
        t: { fontSize: 10.5, fontWeight: 700, color: "#1a1040", fontFamily: "ui-monospace, monospace", textTransform: "uppercase", letterSpacing: 0.5, display: "flex", alignItems: "center", gap: 5 },
        h: { fontSize: 8.5, color: "#1a1040", fontFamily: "ui-monospace, monospace", marginTop: 2 },
        l: { flex: 1, textAlign: "center", fontSize: 9, fontWeight: 700, color: "#1a1040", fontFamily: "ui-monospace, monospace", textTransform: "uppercase", border: "2px solid #1a1040", padding: "3px 0", borderRadius: 0, cursor: "pointer" },
        o: { flex: 1, textAlign: "center", fontSize: 9, fontWeight: 700, color: "#fff", fontFamily: "ui-monospace, monospace", textTransform: "uppercase", background: "#1a1040", border: "2px solid #1a1040", padding: "3px 0", borderRadius: 0, cursor: "pointer" },
      };
    }
    if (brutal) {
      const ink = C.hairline;
      return {
        c: { position: "absolute", top: "calc(100% + 18px)", left: "50%", marginLeft: -93, width: 186, boxSizing: "border-box", zIndex: 50, borderRadius: 0, padding: "9px 11px 8px", background: C.card, border: "2px solid " + ink, boxShadow: "4px 4px 0 " + C.rim, fontFamily: "'Courier New', Courier, monospace", display: showSedPop ? "block" : "none", animation: "sed-pop .15s ease" },
        a: { position: "absolute", top: -6, left: "50%", marginLeft: -6, width: 10, height: 10, background: C.card, border: "2px solid " + ink, borderRight: "none", borderBottom: "none" },
        t: { fontSize: 10.5, fontWeight: 700, color: C.label, fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: 0.2, display: "flex", alignItems: "center", gap: 5 },
        h: { fontSize: 8.5, color: C.second, fontFamily: "'Courier New', Courier, monospace", marginTop: 2 },
        l: { flex: 1, textAlign: "center", fontSize: 9, fontWeight: 700, color: C.label, fontFamily: "'Courier New', Courier, monospace", border: "2px solid " + ink, padding: "3px 0", borderRadius: 0, cursor: "pointer", background: C.bg },
        o: { flex: 1, textAlign: "center", fontSize: 9, fontWeight: 700, color: C.bg, fontFamily: "'Courier New', Courier, monospace", background: C.label, border: "2px solid " + ink, padding: "3px 0", borderRadius: 0, cursor: "pointer" },
      };
    }
    if (term) {
      return {
        c: { position: "absolute", top: "calc(100% + 18px)", left: "50%", marginLeft: -93, width: 186, boxSizing: "border-box", zIndex: 50, borderRadius: 3, padding: "9px 11px 8px", background: C.card, border: "1px solid " + C.hairline, boxShadow: "none", fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, monospace", display: showSedPop ? "block" : "none", animation: "sed-pop .15s ease" },
        a: { position: "absolute", top: -5, left: "50%", marginLeft: -5, width: 10, height: 10, background: C.card, border: "1px solid " + C.hairline, borderRight: "none", borderBottom: "none" },
        t: { fontSize: 10.5, fontWeight: 700, color: C.green, fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, monospace", letterSpacing: 0.2, display: "flex", alignItems: "center", gap: 5 },
        h: { fontSize: 8.5, color: C.second, fontFamily: "ui-monospace, monospace", marginTop: 2 },
        l: { flex: 1, textAlign: "center", fontSize: 9, fontWeight: 700, color: C.second, fontFamily: "ui-monospace, monospace", border: "1px solid " + C.hairline, padding: "3px 0", borderRadius: 3, cursor: "pointer", background: "transparent" },
        o: { flex: 1, textAlign: "center", fontSize: 9, fontWeight: 700, color: C.bg, fontFamily: "ui-monospace, monospace", background: C.green, border: "1px solid " + C.green, padding: "3px 0", borderRadius: 3, cursor: "pointer" },
      };
    }
    return {
      c: { position: "absolute", top: "calc(100% + 18px)", left: "50%", marginLeft: -93, width: 186, boxSizing: "border-box", zIndex: 50, borderRadius: 12, padding: "9px 11px 8px", background: "rgba(38,30,18,0.92)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: "1px solid rgba(255,159,10,0.45)", display: showSedPop ? "block" : "none", animation: "sed-pop .4s cubic-bezier(.2,.9,.3,1.15)" },
      a: { position: "absolute", top: -4.5, left: "50%", marginLeft: -4.5, width: 9, height: 9, background: "rgba(38,30,18,0.92)", borderLeft: "1px solid rgba(255,159,10,0.45)", borderTop: "1px solid rgba(255,159,10,0.45)", transform: "rotate(45deg)" },
      t: { fontSize: 10.5, fontWeight: 700, color: "#FF9F0A", letterSpacing: 0.2, display: "flex", alignItems: "center", gap: 5 },
      h: { fontSize: 8.5, color: "rgba(255,159,10,0.65)", marginTop: 2 },
      l: { flex: 1, textAlign: "center", fontSize: 9, fontWeight: 600, color: "rgba(255,159,10,0.65)", border: "1px solid rgba(255,159,10,0.35)", padding: "3px 0", borderRadius: 99, cursor: "pointer" },
      o: { flex: 1, textAlign: "center", fontSize: 9, fontWeight: 600, color: "#0a0a0c", background: "#FF9F0A", padding: "4px 0", borderRadius: 99, cursor: "pointer" },
    };
  })();

  const microPool = T("microHabits");
  const standHintText = Array.isArray(microPool) && microPool.length
    ? microPool[(effIdle || 0) % microPool.length]
    : T("standHint");

  const idleChipWithPop = offWrist ? (
    <div
      data-tauri-drag-region="false"
      title={T("offWristTip")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        height: 19,
        padding: "0 8px 0 6px",
        borderRadius: brutal ? 0 : term ? 3 : 99,
        flexShrink: 0,
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: 0.2,
        background: C.card,
        color: C.third,
        cursor: "default",
      }}
    >
      <span style={{ fontSize: 9.5, lineHeight: 1 }}>⌚</span>
      <span>{T("offWrist")}</span>
    </div>
  ) : effIdle != null ? (
    <div style={{ position: "relative" }}>
      <div data-tauri-drag-region="false" title={T("sedThreshold")} onMouseDown={function (e) { e.preventDefault(); e.stopPropagation(); if (!effSed || !sedPopRef.current) return; const vis = sedPopRef.current.style.display !== "none"; sedPopRef.current.style.display = vis ? "none" : "block"; if (vis) dismissSedPop(); else { try { localStorage.removeItem(SED_POP_KEY); } catch (err) {} } }} style={{ display: "flex", alignItems: "center", gap: 5, height: 19, padding: "0 8px 0 6px", borderRadius: brutal ? 0 : term ? 3 : 99, flexShrink: 0, fontSize: 9, fontWeight: 600, letterSpacing: 0.2, fontVariantNumeric: "tabular-nums", cursor: effSed ? "pointer" : "default", ...(effSed ? { background: "rgba(255,159,10,0.16)", color: C.amber, animation: "sed-pulse 2.2s ease-in-out infinite" } : { background: C.card, color: C.third }) }}>
        {ICO.chair}<span>{effIdle} min</span>
      </div>
      {effSed && effIdle != null && (
        <div ref={function (el) { sedPopRef.current = el; }} style={sedS.c}>
          <div style={sedS.a} />
          <div style={sedS.t}>
            {term ? "[!]" : null}
            {ICO.chair}<span>{T("sedentaryMin", { m: idleMin })}</span>
          </div>
          <div style={sedS.h}>{standHintText}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
            <div onMouseDown={function (e) { e.stopPropagation(); if (sedPopRef.current) sedPopRef.current.style.display = "none"; dismissSedPop(); try { invoke("snooze_sedentary", { minutes: 30 }); invoke("hide_sed_popover"); } catch (e) {} }} style={sedS.l}>{T("later")}</div>
            <div onMouseDown={function (e) { e.stopPropagation(); if (sedPopRef.current) sedPopRef.current.style.display = "none"; dismissSedPop(); try { onReset(); invoke("hide_sed_popover"); } catch (e) {} }} style={sedS.o}>{T("stoodUp")}</div>
          </div>
        </div>
      )}
    </div>
  ) : null;

  // 手环电量胶囊（与久坐胶囊同高 19px，横排并列在久坐胶囊旁边）
  const isBatLow = deviceBattery != null && (deviceBattery <= 25 || deviceBatteryStatus === "Low" || deviceBatteryStatus === "Empty");
  const batColor = deviceBattery == null ? C.third : isBatLow ? C.amber : deviceBattery <= 50 ? C.second : C.green;
  const batFillW = deviceBattery != null ? Math.max(1.2, Math.min(8.4, (deviceBattery / 100) * 8.4)) : 0;
  const batteryChip = deviceBattery != null ? (
    <div
      data-tauri-drag-region="false"
      title={`${deviceName} · ${deviceBattery}%${deviceBatteryStatus ? " (" + deviceBatteryStatus + ")" : ""}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        height: 19,
        padding: "0 7px 0 6px",
        borderRadius: brutal ? 0 : term ? 3 : 99,
        flexShrink: 0,
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: 0.1,
        fontVariantNumeric: "tabular-nums",
        cursor: "default",
        ...(isBatLow
          ? { background: "rgba(255,159,10,0.16)", color: C.amber }
          : { background: C.card, color: C.third }),
      }}
    >
      <svg width="13" height="9" viewBox="0 0 14 9" fill="none" style={{ display: "block", flexShrink: 0 }}>
        <rect x="0.7" y="1" width="10.6" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
        <path d="M12.3 3.1v2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <rect x="1.8" y="2.1" width={batFillW} height="4.8" rx="0.8" fill={batColor} />
      </svg>
      <span>{deviceBattery}%</span>
    </div>
  ) : null;

  const header = (
    <div
      onMouseDown={function (e) {
        if (e.button !== 0) return; // 仅左键触发拖动
        const t = e.target;
        // 排除可交互子控件（情绪球 iframe / 刷新按钮 / 久坐芯片），这些要响应自身点击
        if (t && t.closest && (t.closest('[data-tauri-drag-region="false"]') || t.closest("iframe"))) return;
        if (tauriAvailable()) {
          getCurrentWindow().startDragging().catch(function () {});
        }
      }}
      style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 2px", cursor: "grab" }}
    >
      <svg width="20" height="20" viewBox="0 0 100 100" style={{ display: "block", flexShrink: 0 }}>
        <defs>
          <linearGradient id="hd-fb-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0E222A" />
            <stop offset="100%" stopColor="#071218" />
          </linearGradient>
          <linearGradient id="hd-fb-dot" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#48F7E8" />
            <stop offset="100%" stopColor="#00B0B9" />
          </linearGradient>
        </defs>
        <rect x="4" y="4" width="92" height="92" rx={brutal || isPixel(styleId) ? "0" : term ? "12" : "22"} fill="url(#hd-fb-bg)" stroke="rgba(72,247,232,0.28)" strokeWidth="2.5" />
        {/* Fitbit Air 经典点阵菱形 */}
        <g fill="url(#hd-fb-dot)">
          <circle cx="50" cy="24" r="4.8" />
          <circle cx="38" cy="37" r="4.8" />
          <circle cx="50" cy="37" r="5.2" />
          <circle cx="62" cy="37" r="4.8" />
          <circle cx="26" cy="50" r="4.6" />
          <circle cx="38" cy="50" r="5.2" />
          <circle cx="50" cy="50" r="5.8" />
          <circle cx="62" cy="50" r="5.2" />
          <circle cx="74" cy="50" r="4.6" />
          <circle cx="38" cy="63" r="4.8" />
          <circle cx="50" cy="63" r="5.2" />
          <circle cx="62" cy="63" r="4.8" />
          <circle cx="50" cy="76" r="4.8" />
        </g>
      </svg>
      <span style={{ fontSize: 11, fontWeight: 700, color: C.label, letterSpacing: 0.1, ...(brutal ? { fontFamily: "Georgia, 'Times New Roman', serif" } : {}) }}>
        {T("appTitle")}
      </span>
      {term && <span className="hd-cursor" style={{ display: "inline-block", width: 7, height: 12, background: C.label, verticalAlign: "text-bottom", flexShrink: 0 }} />}
      <div style={{ flex: 1 }} />
      {ballWrap}
      {idleChipWithPop}
      {batteryChip}
      {syncStale && (
        <span
          title={T("staleSyncTip", { dev: deviceName, m: syncAgeMin != null ? syncAgeMin : "120+" })}
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: C.amber,
            fontVariantNumeric: "tabular-nums",
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            cursor: "default",
          }}
        >
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: C.amber, display: "inline-block" }} />
          {lastSyncTime || fmtTime(now)}
        </span>
      )}
      {/* 设置入口已移至菜单栏 */}
      <div data-tauri-drag-region="false" className="hd-refresh-btn" onMouseDown={function (e) { e.preventDefault(); e.stopPropagation(); if (e.button !== 0) return; onRefresh(); }} title={`${T("refreshTitle")} · ${T("lastSyncTip", { dev: deviceName, t: lastSyncTime || fmtTime(now) })}`} style={{ width: 20, height: 20, borderRadius: brutal ? 0 : term ? 3 : "50%", background: brutal ? C.glassCtl : term ? "transparent" : C.glassCtl, border: brutal ? "2px solid " + C.hairline : term ? "1px solid " + C.hairline : "none", boxShadow: brutal || term || isPixel(styleId) ? "none" : "inset 0 0.5px 0 " + C.rim, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, color: C.second }}>
        {ICO.refresh}
      </div>
    </div>
  );

  const glassStyle = (function () {
    if (styleId === "pixel-anime") {
      return {
        width: "100%", height: "100%", boxSizing: "border-box", padding: "10px 12px",
        // 像素动漫风：0 圆角、实底深紫/浅紫青、2px 硬边深角线、硬边像素阴影（4px 4px 0）
        borderRadius: 0, background: C.bg, border: "2px solid #1a1040",
        boxShadow: "4px 4px 0 #1a1040",
        fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
        display: "flex", flexDirection: "column", overflow: "hidden", position: "relative",
        imageRendering: "pixelated",
      };
    }
    if (styleId === "brutalist-web") {
      return {
        width: "100%", height: "100%", boxSizing: "border-box", padding: "10px 12px",
        // 粗野主义：0 圆角、实底纯白/纯黑、2px 硬边、硬边投影（无模糊，右下 6px 会被窗口裁掉仅作点缀）
        borderRadius: 0, background: C.bg, border: "2px solid " + C.hairline,
        boxShadow: "6px 6px 0 " + C.rim,
        fontFamily: "'Courier New', Courier, monospace",
        display: "flex", flexDirection: "column", overflow: "hidden", position: "relative",
      };
    }
    if (styleId === "developer-terminal") {
      return {
        width: "100%", height: "100%", boxSizing: "border-box", padding: "10px 12px",
        // 终端：实底近黑/纸白、1px 细边、小圆角、零阴影（全等宽字体）
        borderRadius: 4, background: C.bg, border: "1px solid " + C.hairline,
        fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
        display: "flex", flexDirection: "column", overflow: "hidden", position: "relative",
      };
    }
    return {
      width: "100%", height: "100%", boxSizing: "border-box", padding: "12px 14px",
      // 圆角统一 24px（对齐 macOS 原生小组件规范）：与系统 NSVisualEffectView / NSGlassEffectView 一致
      borderRadius: "24px",
      display: "flex", flexDirection: "column",
      // 内部保持极清澈透明（不叠白雾，让系统底层磨砂与壁纸质感透出来）
      background: C.bg,
      // 仅在边缘做极细折光棱线，无任何阴影
      boxShadow:
        "inset 0 1px 0 " + C.rim +
        ", inset 1px 0 0 " + C.rimSoft +
        ", inset -0.5px -0.5px 0 " + C.rimSoft,
      overflow: "hidden", position: "relative",
    };
  })();

  // ── 极简数字风（唯一布局）──
  {
    const stepPct = Math.min(100, Math.round((steps / Math.max(1, stepGoal)) * 100));
    const goalDone = steps >= stepGoal;
    const avg = t.rolling_averages || data.rolling_averages || {};
    const dailySeries = useMemo(() => {
      if (Array.isArray(t.daily_history) && t.daily_history.length > 0) return t.daily_history.slice(-7);
      const hist = Array.isArray(data.history) ? data.history : [];
      const map = {};
      for (const h of hist) {
        if (h && h.date && h.steps != null) map[h.date] = h;
      }
      if (t.date) map[t.date] = { ...map[t.date], ...t };
      const dates = Object.keys(map).sort().slice(-7);
      return dates.map((d) => ({
        ...map[d],
        date: d,
        steps: map[d].steps || 0,
        sleep_asleep_min: map[d].sleep_asleep_min || 0,
      }));
    }, [t, data.history]);

    const hasNightMetrics = (hrv != null || spo2 != null || resp != null || sleep > 0);
    const hrRangeVal = (t.hr_min != null && t.hr_max != null) ? `${t.hr_min}–${t.hr_max}` : null;
    const totSedMin = t.total_sedentary_min != null ? Number(t.total_sedentary_min) : null;
    const totSitVal = totSedMin != null ? (totSedMin >= 60 ? (totSedMin / 60).toFixed(1) : totSedMin) : null;
    const totSitUnit = totSedMin != null && totSedMin >= 60 ? "h" : T("minUnit");
    const exMin = t.exercise_min != null ? Number(t.exercise_min) : 0;
    const dayCol4 = exMin > 0
      ? { key: "exercise", label: T("workout"), value: exMin, unit: t.exercise_name || T("minUnit"), color: C.green }
      : { key: "calories", label: T("kcal").toUpperCase(), value: calories, unit: T("kcal"), color: C.amber };

    const metrics = hasNightMetrics ? [
      { key: "hr", label: hrLabel, value: hrVal, unit: T("bpm"), color: C.red },
      { key: "hrv", label: T("hrv"), value: hrv, unit: T("ms"), color: C.blue },
      { key: "spo2", label: T("spo2"), value: spo2, unit: T("pct"), color: C.teal },
      { key: "resp", label: T("resp"), value: resp, unit: T("perMin"), color: C.indigo },
    ] : [
      { key: "hr", label: hrLabel, value: hrVal, unit: T("bpm"), color: C.red },
      { key: "total_sed", label: T("totalSitting"), value: totSitVal, unit: totSitUnit, color: C.indigo },
      dayCol4,
    ];
    const sleepStages = [
      { k: "awake", v: t.sleep_awake_min || 0, c: "rgba(152,152,157,0.55)" },
      { k: "rem", v: t.sleep_rem_min || 0, c: C.amber },
      { k: "light", v: t.sleep_light_min || 0, c: C.teal },
      { k: "deep", v: t.sleep_deep_min || 0, c: C.indigo },
    ];
    const sleepTotal = sleepStages.reduce(function (a, p) { return a + (p.v || 0); }, 0);
    const useHrZoneBar = false;
    // 圆点指示提示来源：绿色 = LLM 生效（AI tip / 正在分析），蓝色 = LLM 未配置或失败、回落到本地静态提示池
    const tipDot = bottomTip ? C.green : C.blue;
    const fallbackPool = effSed ? SEDENTARY_TIPS : FALLBACK_TIPS;
    const fallbackTip = fallbackPool[Math.floor(Date.now() / 60000) % fallbackPool.length];
    const tipText = cleanTip(bottomTip) || fallbackTip;
    const distStr = distance != null ? distance.toFixed(1) + " km" : "—";
    const calStr = calories != null ? calories + " " + T("kcal") : "";
    const midLine = distStr + (calStr ? " · " + calStr : "");

    // 7 日均值差值格式化
    const fmtDelta = (cur, avgVal, unit = "") => {
      if (cur == null || avgVal == null || avgVal === 0) return "—";
      const d = Math.round((cur - avgVal) * 10) / 10;
      const sign = d > 0 ? "+" : "";
      return `${sign}${d}${unit}`;
    };

    const trendCfgMap = {
      steps: {
        title: T("stepsUnit"),
        color: C.green,
        val: (x) => (x.steps != null ? Number(x.steps) : null),
        fmt: (v) => (v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v))),
        minMax: stepGoal,
      },
      hr: {
        title: hrLabel,
        color: C.red,
        val: (x) => (x.hr_avg ?? x.resting_hr ?? x.heart_rate ?? null),
        fmt: (v) => (v == null ? "—" : String(Math.round(v))),
      },
      hr_range: {
        title: T("hrRange"),
        color: C.blue,
        val: (x) => (x.hr_max ?? x.hr_avg ?? x.heart_rate ?? null),
        fmt: (v, x) => (x && x.hr_min != null && x.hr_max != null ? `${x.hr_min}-${x.hr_max}` : v == null ? "—" : String(Math.round(v))),
      },
      hrv: {
        title: T("hrv"),
        color: C.blue,
        val: (x) => (x.hrv != null ? Number(x.hrv) : null),
        fmt: (v) => (v == null ? "—" : String(Math.round(v))),
      },
      spo2: {
        title: T("spo2"),
        color: C.teal,
        val: (x) => (x.spo2 != null ? Number(x.spo2) : null),
        fmt: (v) => (v == null ? "—" : v + "%"),
      },
      resp: {
        title: T("resp"),
        color: C.indigo,
        val: (x) => (x.respiratory_rate != null ? Number(x.respiratory_rate) : null),
        fmt: (v) => (v == null ? "—" : String(v)),
      },
      total_sed: {
        title: T("totalSitting"),
        color: C.indigo,
        val: (x) => (x.total_sedentary_min != null ? Number(x.total_sedentary_min) : null),
        fmt: (v) => (v == null ? "—" : v >= 60 ? (v / 60).toFixed(1) + "h" : v + "m"),
      },
      exercise: {
        title: useHrZoneBar ? T("hrZones") : T("workout"),
        color: C.green,
        val: (x) => (x.exercise_min != null && x.exercise_min > 0 ? Number(x.exercise_min) : (x.active_minutes != null ? Number(x.active_minutes) : null)),
        fmt: (v) => (v == null ? "—" : Math.round(v) + "m"),
      },
      calories: {
        title: T("kcal").toUpperCase(),
        color: C.amber,
        val: (x) => (x.calories != null ? Number(x.calories) : null),
        fmt: (v) => (v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v))),
      },
      sleep: {
        title: T("sleep"),
        color: C.indigo,
        val: (x) => (x.sleep_asleep_min != null && x.sleep_asleep_min > 0 ? Number(x.sleep_asleep_min) : null),
        fmt: (v) => (v == null ? "—" : (v / 60).toFixed(1) + "h"),
      },
    };
    const activeTrend = trendMetric ? (trendCfgMap[trendMetric] || trendCfgMap.steps) : null;
    const trendSeries = dailySeries.length ? dailySeries : [{ ...t, date: t.date || "—", steps }];
    const trendMaxVal = activeTrend
      ? Math.max(activeTrend.minMax || 1, ...trendSeries.map((x) => Number(activeTrend.val(x) || 0)))
      : 1;
    const trendSwitchKeys = ["steps", ...metrics.map((m) => m.key), ...(sleepTotal > 0 ? ["sleep"] : [])].filter(
      (k, idx, arr) => trendCfgMap[k] && arr.indexOf(k) === idx
    );

    const isLiquidGlass = !brutal && !term && !isPixel(styleId);
    return (
      <div
        ref={glassRef}
        className={isLiquidGlass ? "hd-glass-host" : undefined}
        onMouseDownCapture={isLiquidGlass ? spawnRipple : undefined}
        onMouseMove={isLiquidGlass ? (e) => {
          const el = glassRef.current;
          if (!el) return;
          const r = el.getBoundingClientRect();
          el.style.setProperty("--mx", (e.clientX - r.left) + "px");
          el.style.setProperty("--my", (e.clientY - r.top) + "px");
        } : undefined}
        style={Object.assign({}, glassStyle, { display: "flex", flexDirection: "column", gap: sleepTotal > 0 ? 8 : 10 })}
      >
        {isLiquidGlass && <div className="hd-glass-caustics" />}
        {isLiquidGlass && <div className="hd-glass-rim" />}
        {isLiquidGlass && ripples.map((rp) => (
          <div key={rp.id} className="hd-liquid-ripple" style={{ left: rp.x, top: rp.y }} />
        ))}
        {Array.isArray(snapEdges) && snapEdges.map((edge, idx) => {
          const posStyle =
            edge === "left"   ? { left: 0, top: 18, bottom: 18, width: 2, background: `linear-gradient(180deg, transparent, ${C.teal}, transparent)` } :
            edge === "right"  ? { right: 0, top: 18, bottom: 18, width: 2, background: `linear-gradient(180deg, transparent, ${C.teal}, transparent)` } :
            edge === "top"    ? { top: 0, left: 18, right: 18, height: 2, background: `linear-gradient(90deg, transparent, ${C.teal}, transparent)` } :
                                { bottom: 0, left: 18, right: 18, height: 2, background: `linear-gradient(90deg, transparent, ${C.teal}, transparent)` };
          return <div key={edge + idx} className="hd-snap-edge" style={posStyle} />;
        })}
        {header}
        {activeTrend ? (
          <div
            key={"trend-" + trendMetric}
            className="hd-view-enter hd-click-area"
            onClick={() => setTrendMetric(null)}
            title={T("trendHint")}
            style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "2px 4px", cursor: "pointer" }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "nowrap", overflow: "hidden" }}>
                {trendSwitchKeys.map((k) => {
                  const cfg = trendCfgMap[k];
                  const act = k === trendMetric;
                  return (
                    <span
                      key={k}
                      onClick={(e) => { e.stopPropagation(); setTrendMetric(k); }}
                      style={{
                        fontSize: 10,
                        fontWeight: act ? 700 : 500,
                        padding: "4px 7px",
                        color: act ? cfg.color : C.third,
                        opacity: act ? 1 : 0.78,
                        borderBottom: act ? `2px solid ${cfg.color}` : "2px solid transparent",
                        transition: "color 0.2s ease, opacity 0.2s ease",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {cfg.title}
                    </span>
                  );
                })}
              </div>
              <span
                onClick={(e) => { e.stopPropagation(); setTrendMetric(null); }}
                style={{ fontSize: 11, color: C.third, padding: "4px 6px", cursor: "pointer", flexShrink: 0 }}
              >✕</span>
            </div>
            {/* 7 日顺滑曲线（单调防过冲 + 缺失日虚线连接 + 底部渐隐） */}
            {(() => {
              const W = 280, H = 62;
              const n = trendSeries.length || 1;
              const vals = trendSeries.map((it, idx, arr) => {
                const v = activeTrend.val(it);
                if (v == null) return null;
                if (idx < arr.length - 1 && Number(v) === 0 && (trendMetric === "steps" || trendMetric === "hr" || trendMetric === "total_sed")) {
                  return null;
                }
                return v;
              });
              const nums = vals.filter((v) => v != null).map(Number);
              const vMax = nums.length ? Math.max(...nums, activeTrend.minMax || 0) : 1;
              const vMin = nums.length ? Math.min(...nums) : 0;
              const span = Math.max(1e-6, vMax - vMin);
              const padMin = nums.length > 1 && vMax > vMin ? vMin - span * 0.14 : vMin * 0.85;
              const padMax = nums.length > 1 && vMax > vMin ? vMax + span * 0.16 : Math.max(1, vMax * 1.15);
              const padSpan = Math.max(1e-6, padMax - padMin);

              const pts = vals.map((v, i) => {
                const x = ((i + 0.5) / n) * W;
                if (v == null) return null;
                const ratio = (Number(v) - padMin) / padSpan;
                const y = H - 7 - Math.max(0, Math.min(1, ratio)) * (H - 16);
                return { x, y, i };
              });

              const buildSmoothPath = (seg) => {
                if (seg.length < 2) return "";
                let d = `M ${seg[0].x.toFixed(1)} ${seg[0].y.toFixed(1)}`;
                const t = 0.14; // 克制曲率 + 上下界夹紧，防止过冲
                for (let k = 0; k < seg.length - 1; k++) {
                  const p0 = seg[Math.max(0, k - 1)];
                  const p1 = seg[k];
                  const p2 = seg[k + 1];
                  const p3 = seg[Math.min(seg.length - 1, k + 2)];
                  const minY = Math.min(p1.y, p2.y);
                  const maxY = Math.max(p1.y, p2.y);
                  const cp1x = p1.x + (p2.x - p0.x) * t;
                  const cp1y = Math.max(minY, Math.min(maxY, p1.y + (p2.y - p0.y) * t));
                  const cp2x = p2.x - (p3.x - p1.x) * t;
                  const cp2y = Math.max(minY, Math.min(maxY, p2.y - (p3.y - p1.y) * t));
                  d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
                }
                return d;
              };

              const segments = [];
              let curSeg = [];
              for (let i = 0; i < pts.length; i++) {
                if (pts[i]) {
                  curSeg.push(pts[i]);
                } else if (curSeg.length) {
                  segments.push(curSeg);
                  curSeg = [];
                }
              }
              if (curSeg.length) segments.push(curSeg);

              const gapLines = [];
              for (let s = 0; s < segments.length - 1; s++) {
                const a = segments[s][segments[s].length - 1];
                const b = segments[s + 1][0];
                gapLines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
              }

              const valid = pts.filter(Boolean);
              const gradId = `hd-line-grad-${trendMetric || "s"}`;
              const focusIdx = (hoverTrendIdx != null && hoverTrendIdx >= 0 && hoverTrendIdx < trendSeries.length)
                ? hoverTrendIdx
                : (trendSeries.length - 1);
              const focusItem = trendSeries[focusIdx] || {};
              const focusVal = activeTrend.fmt(vals[focusIdx], focusItem);
              const firstPt = valid[0];
              const lastPt = valid[valid.length - 1];

              return (
                <div
                  onMouseLeave={() => setHoverTrendIdx(null)}
                  style={{ display: "flex", flexDirection: "column", gap: 3, padding: "2px 2px 4px", position: "relative", ...(isLiquidGlass ? {} : { borderBottom: "1px solid " + C.hairline }) }}
                >
                  {isLiquidGlass && (
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg, transparent 4%, ${C.hairline} 50%, transparent 96%)`, pointerEvents: "none" }} />
                  )}
                  <div style={{ position: "relative", height: 64 }}>
                    {/* 左上角主数值（悬浮任意列实时显示当日数值） */}
                    <div style={{ position: "absolute", left: 4, top: 0, zIndex: 2, pointerEvents: "none", display: "flex", alignItems: "baseline", gap: 5 }}>
                      <span style={{ fontSize: 20, fontWeight: 700, lineHeight: 1, letterSpacing: -0.6, color: C.label, fontVariantNumeric: "tabular-nums" }}>{focusVal}</span>
                      {hoverTrendIdx != null && (
                        <span style={{ fontSize: 8.5, color: activeTrend.color, fontWeight: 600 }}>{(focusItem.date || "").slice(5)}</span>
                      )}
                    </div>
                    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%", overflow: "visible", display: "block" }}>
                      <defs>
                        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={activeTrend.color} stopOpacity="0.34" />
                          <stop offset="60%" stopColor={activeTrend.color} stopOpacity="0.10" />
                          <stop offset="100%" stopColor={activeTrend.color} stopOpacity="0.0" />
                        </linearGradient>
                      </defs>
                      {segments.map((seg, si) => {
                        if (seg.length >= 2) {
                          const ld = buildSmoothPath(seg);
                          const ad = `${ld} L ${seg[seg.length - 1].x.toFixed(1)} ${H} L ${seg[0].x.toFixed(1)} ${H} Z`;
                          return (
                            <g key={"seg" + si}>
                              <path d={ad} fill={`url(#${gradId})`} />
                              <path d={ld} fill="none" stroke={activeTrend.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
                            </g>
                          );
                        }
                        const p = seg[0];
                        return (
                          <line key={"seg" + si} x1={Math.max(4, p.x - 8)} y1={p.y} x2={Math.min(W - 4, p.x + 8)} y2={p.y} stroke={activeTrend.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
                        );
                      })}
                      {/* 缺失日（如周六日）用克制直虚线连接 */}
                      {gapLines.map((g, gi) => (
                        <line key={"gap" + gi} x1={g.x1.toFixed(1)} y1={g.y1.toFixed(1)} x2={g.x2.toFixed(1)} y2={g.y2.toFixed(1)} stroke={activeTrend.color} strokeOpacity="0.45" strokeWidth="1.1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                      ))}
                      {firstPt && valid.length >= 2 && (
                        <circle cx={firstPt.x} cy={firstPt.y} r="2.6" fill={activeTrend.color} />
                      )}
                      {lastPt && (
                        <circle cx={lastPt.x} cy={lastPt.y} r="2.8" fill={activeTrend.color} />
                      )}
                      {hoverTrendIdx != null && pts[hoverTrendIdx] && hoverTrendIdx !== 0 && hoverTrendIdx !== pts.length - 1 && (
                        <circle cx={pts[hoverTrendIdx].x} cy={pts[hoverTrendIdx].y} r="2.4" fill={activeTrend.color} />
                      )}
                    </svg>
                    {/* 透明悬浮感应列 */}
                    <div style={{ position: "absolute", inset: 0, display: "flex", zIndex: 3 }}>
                      {trendSeries.map((_, idx) => (
                        <div key={idx} onMouseEnter={() => setHoverTrendIdx(idx)} style={{ flex: 1, height: "100%" }} />
                      ))}
                    </div>
                  </div>
                  {/* 底部极简星期 + 日期号（如 周二 / 24） */}
                  <div style={{ display: "flex", paddingTop: 2 }}>
                    {trendSeries.map((item, idx, arr) => {
                      const isToday = idx === arr.length - 1;
                      const dayNum = (item.date || "").slice(8);
                      let wkLbl = "";
                      let isWeekend = false;
                      if (item.date && /^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
                        const [yy, mm, dd] = item.date.split("-").map(Number);
                        const wd = new Date(yy, mm - 1, dd).getDay();
                        isWeekend = (wd === 0 || wd === 6);
                        const isEn = settings && settings.language === "en";
                        wkLbl = isEn
                          ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][wd]
                          : ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][wd];
                      }
                      return (
                        <div key={item.date || idx} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.2 }}>
                          <span style={{ fontSize: 9, color: isToday ? activeTrend.color : isWeekend ? C.amber : C.second, fontWeight: isToday ? 700 : 600 }}>{wkLbl || "—"}</span>
                          <span style={{ fontSize: 8, color: isToday ? C.label : C.third, opacity: 0.85, fontVariantNumeric: "tabular-nums" }}>{dayNum}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
            {/* 今日 vs 7日均值 4格对比 */}
            <div style={{ display: "flex", padding: "4px 0" }}>
              {[
                { label: T("stepsUnit"), cur: steps, delta: fmtDelta(steps, avg.steps ? Math.round(avg.steps) : null), color: C.green },
                { label: T("sleep"), cur: fmtSleep(sleep) || "—", delta: fmtDelta(sleep, avg.sleep_asleep_min ? Math.round(avg.sleep_asleep_min) : null, "m"), color: C.indigo },
                { label: hrLabel, cur: resting != null ? resting : "—", delta: fmtDelta(resting, avg.resting_hr), color: C.red },
                { label: T("hrv"), cur: hrv != null ? hrv : "—", delta: fmtDelta(hrv, avg.hrv), color: C.blue },
              ].map((m, i) => (
                <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, ...(i > 0 ? { borderLeft: "1px solid " + C.hairline } : {}) }}>
                  <span style={{ fontSize: 7.5, color: C.third }}>{m.label} · {T("vs7dAvg")}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: m.delta === "—" ? C.third : m.color, opacity: m.delta === "—" ? 0.35 : 1, fontVariantNumeric: "tabular-nums" }}>{m.delta}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="hd-view-enter" style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: sleepTotal > 0 ? "space-between" : "space-evenly", gap: sleepTotal > 0 ? 6 : 8 }}>
            <div
              className={isLiquidGlass ? "hd-click-area hd-steps-cell" : "hd-click-area"}
              onClick={() => setTrendMetric("steps")}
              title={T("trendHint")}
              style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", padding: "0 4px", position: "relative", cursor: "pointer", borderRadius: 12 }}
            >
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                  <span style={{ fontSize: 46, fontWeight: 700, lineHeight: 1, letterSpacing: -2, color: C.label, fontVariantNumeric: "tabular-nums", opacity: steps ? 1 : 0.32 }}>{steps ? steps.toLocaleString() : "—"}</span>
                  {goalDone && (
                    <span title={T("goalReached")} style={{ fontSize: 9, fontWeight: 700, color: C.green, background: "rgba(48,209,88,0.14)", padding: "1.5px 6px", borderRadius: brutal || isPixel(styleId) ? 0 : 99, border: "1px solid " + C.green }}>
                      ★ {stepPct}%
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 11.5, fontWeight: 500, color: C.second, marginTop: 4, letterSpacing: 0.3 }}>
                  {midLine}
                </span>
              </div>
              <div style={{ textAlign: "right" }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: C.green, fontVariantNumeric: "tabular-nums" }}>{active != null ? active : "—"}<span style={{ fontSize: 9, color: C.third, fontWeight: 500 }}> {T("minActive")}</span></span>
              </div>
            </div>
            <div style={{ height: 4.5, borderRadius: brutal || isPixel(styleId) ? 0 : 99, background: C.card, boxShadow: brutal || term || isPixel(styleId) ? "none" : "inset 0 0.5px 1px rgba(0,0,0,0.16)", overflow: "hidden", position: "relative" }}>
              <div className={goalDone && isLiquidGlass ? "hd-goal-bar-shimmer" : undefined} style={{ height: "100%", borderRadius: brutal || isPixel(styleId) ? 0 : 99, width: stepPct + "%", background: "linear-gradient(90deg, #5CE68B 0%, #30D158 60%, #9EFFB8 100%)", boxShadow: brutal || term || isPixel(styleId) ? "none" : "0 0 8px rgba(48,209,88,0.38)", transition: "width .45s cubic-bezier(.2,.8,.2,1)" }} />
            </div>
            <div
              style={{
                display: "flex",
                padding: sleepTotal > 0 ? "7px 0" : "9px 0",
                ...(isLiquidGlass
                  ? {}
                  : { borderTop: "1px solid " + C.hairline, borderBottom: "1px solid " + C.hairline }),
                position: "relative",
              }}
            >
              {isLiquidGlass && (
                <>
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg, transparent 4%, ${C.hairline} 50%, transparent 96%)`, pointerEvents: "none" }} />
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 1, background: `linear-gradient(90deg, transparent 4%, ${C.hairline} 50%, transparent 96%)`, pointerEvents: "none" }} />
                </>
              )}
              {metrics.map(function (m, i) {
                const empty = m.value == null;
                const softDivider = !brutal && !term && !isPixel(styleId);
                return (
                  <div
                    key={m.key || i}
                    className={isLiquidGlass ? "hd-click-area hd-metric-cell" : "hd-click-area"}
                    onClick={() => setTrendMetric(m.key)}
                    title={`${m.label} · ${T("trendHint")}`}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 2,
                      position: "relative",
                      cursor: "pointer",
                      ...(i > 0 && !softDivider ? { borderLeft: "1px solid " + C.hairline } : {}),
                    }}
                  >
                    {i > 0 && softDivider && (
                      <div style={{ position: "absolute", left: 0, top: "12%", bottom: "12%", width: 1, background: "linear-gradient(180deg, transparent, " + C.hairline + ", transparent)" }} />
                    )}
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, color: C.third, fontWeight: 500, letterSpacing: 0.2 }}>
                      <span style={{ width: 4.5, height: 4.5, borderRadius: "50%", background: empty ? C.third : m.color, opacity: empty ? 0.3 : 0.9 }} />
                      {m.label}
                    </span>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 2.5 }}>
                      <span style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.1, color: empty ? C.third : C.label, opacity: empty ? 0.3 : 1, letterSpacing: -0.5, fontVariantNumeric: "tabular-nums" }}>{empty ? "—" : m.value}</span>
                      {!empty && <span style={{ fontSize: 9, color: C.third, fontWeight: 500 }}>{m.unit}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            {sleepTotal > 0 && (
              <div
                className="hd-click-area"
                onClick={() => setTrendMetric("sleep")}
                title={T("trendHint")}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 2px", position: "relative", cursor: "pointer" }}
              >
                <span style={{ fontSize: 9, color: C.third, fontWeight: 500, flexShrink: 0 }}>{T("sleep")}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.label, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{fmtSleep(sleep) || "—"}</span>
                <div style={{ flex: 1, height: 4.5, borderRadius: brutal || isPixel(styleId) ? 0 : 99, overflow: "hidden", display: "flex", gap: !brutal && !isPixel(styleId) ? 2 : 0 }}>
                  {sleepStages.filter((p) => p.v > 0).map(function (p) {
                    return <div key={p.k} style={{ flex: Math.max(p.v, 0.001), background: p.c, height: "100%", borderRadius: brutal || isPixel(styleId) ? 0 : 99 }} />;
                  })}
                </div>
                <span style={{ fontSize: 8.5, color: C.third, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{t.sleep_deep_min ? T("deepShort") + t.sleep_deep_min + "·REM" + (t.sleep_rem_min || 0) : ""}</span>
              </div>
            )}
          </div>
        )}
        {tipText && (
          isPixel(styleId) ? (
            // RPG 对话框：2px 黑边 + 四角金色角块装饰（绝对定位伪元素）+ 等宽字体 + 0 圆角；点击即换一句
            <div
              onClick={onCycleTip}
              title={T("clickNextTip")}
              style={{ position: "relative", padding: "5px 8px 5px 12px", background: C.card, border: "2px solid #1a1040", borderRadius: 0, marginTop: 4, cursor: "pointer" }}
            >
              <div style={{ position: "absolute", left: 4, top: 4, width: 4, height: 4, background: C.rim }} />
              <div style={{ position: "absolute", right: 4, top: 4, width: 4, height: 4, background: C.rim }} />
              <div style={{ position: "absolute", left: 4, bottom: 4, width: 4, height: 4, background: C.rim }} />
              <div style={{ position: "absolute", right: 4, bottom: 4, width: 4, height: 4, background: C.rim }} />
              <span style={{ fontSize: 9, color: C.label, fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, monospace", fontWeight: 700, lineHeight: 1.35, flex: 1, display: "block" }}>{tipText}</span>
            </div>
          ) : (
            <div
              onClick={onCycleTip}
              title={T("clickNextTip")}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 2px", position: "relative", cursor: "pointer" }}
            >
              {term ? <span style={{ color: C.green, fontWeight: 700, fontSize: 9, flexShrink: 0 }}>#</span> : <span style={{ width: 4, height: 4, borderRadius: brutal ? 0 : "50%", background: tipDot, opacity: 0.9, flexShrink: 0, boxShadow: brutal ? "none" : "0 0 6px " + tipDot }} />}
              <span style={{ fontSize: 9.5, color: C.second, fontWeight: 500, lineHeight: 1.3, flex: 1, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{tipText}</span>
            </div>
          )
        )}
      </div>
    );
  }
}

// ── App：数据加载 + 轮询 + Tauri IPC + 设置 ────────────────────────────────────
function tauriAvailable() {
  return typeof window !== "undefined" && (window.__TAURI_INTERNALS__ || window.__TAURI__);
}

// AI 提示去重记忆（记住最近 6 条，防止每次都说差不多的话）
const RECENT_TIPS_KEY = "hd-recent-ai-tips-v1";
let LAST_FOCUS_IDX = -1;
let LAST_TONE_IDX = -1;

function loadRecentTips() {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENT_TIPS_KEY) || "[]");
    return Array.isArray(arr) ? arr.slice(-6) : [];
  } catch (e) {
    return [];
  }
}
function pushRecentTip(tip) {
  if (!tip) return;
  try {
    const arr = loadRecentTips().filter((x) => x !== tip);
    arr.push(tip);
    localStorage.setItem(RECENT_TIPS_KEY, JSON.stringify(arr.slice(-6)));
  } catch (e) {}
}

function pickAvoidLast(list, lastIdx) {
  if (list.length <= 1) return { item: list[0], idx: 0 };
  let idx = Math.floor(Math.random() * list.length);
  if (idx === lastIdx) idx = (idx + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
  return { item: list[idx], idx };
}

const CHAR_PERSONAS = {
  qiuqiu: "你的名字叫「球球」，性格软萌粘人、元气好奇，像一颗蹲在桌角陪着主人的小团子，说话带一点俏皮亲昵感",
  nimbo: "你的名字叫「云宝」，性格温柔松弛、佛系治愈，像一朵慢悠悠飘在桌角的云，说话轻柔舒缓、不催不躁",
  twinkle: "你的名字叫「亮亮」，性格轻快机灵、像清晨的一束小阳光，说话利落阳光、给人充满电的感觉",
  claw: "你的名字叫「钳钳」，性格是冷幽默的极客损友，一针见血带点小毒舌但内心很关心对方，说话酷且好玩",
};

// 大模型实时底部提示
async function genAiTip(data, settings, rolling_averages, character) {
  if (!settings.llm_base_url || !settings.llm_api_key) return null;
  const td = data && data.today ? data.today : {};
  const hist = (data && Array.isArray(data.history)) ? data.history : [];

  // --- 同比匹配算法 (Sameday Matching) ---
  let yd = null;
  const now = new Date();
  const hr = now.getHours();
  if (hist.length > 0) {
    const now_minutes = hr * 60 + now.getMinutes();
    let minDiff = Infinity;
    for (const h of hist) {
      if (h.date === td.date) continue;
      const h_time = h.time || "00:00";
      const [h_h, h_m] = h_time.split(":").map(Number);
      const h_minutes = h_h * 60 + h_m;
      let diff = Math.abs(now_minutes - h_minutes);
      if (diff > 720) diff = 1440 - diff;
      if (diff <= 30 && diff < minDiff) {
        minDiff = diff;
        yd = h;
      }
    }
  }

  const g = (v) => (v === null || v === undefined ? null : v);
  const today_ = {
    steps: g(td.steps),
    active: g(td.active_minutes),
    sleep_min: g(td.sleep_asleep_min),
    heart_rate: g(td.heart_rate),
    resting_hr: g(td.resting_hr),
    hrv: g(td.hrv),
    spo2: g(td.spo2),
    device_battery_pct: g(td.device_battery),
    sedentary: !!td.sedentary,
    idle_min: g(td.idle_min),
    device_sync_stale: !!td.sync_stale,
  };
  const yd_ = yd ? {
    steps: g(yd.steps),
    active: g(yd.active_minutes),
    sleep_min: g(yd.sleep_asleep_min),
    resting_hr: g(yd.resting_hr),
    hrv: g(yd.hrv),
    spo2: g(yd.spo2),
  } : null;

  const period =
    hr < 6 ? "深夜" : hr < 10 ? "清晨" : hr < 12 ? "上午" :
    hr < 14 ? "午间" : hr < 18 ? "下午" : hr < 22 ? "傍晚" : "睡前";
  const timeStr = `${String(hr).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} (${period})`;

  // 按当前有效数据动态生成切入点池，避免每次都只聊步数
  const focusPool = [];
  if (today_.device_sync_stale) {
    focusPool.push("手环好久没同步：顺口提醒对方看看手环是不是没电了或忘了戴");
  }
  if (today_.device_battery_pct != null && today_.device_battery_pct <= 25) {
    focusPool.push(`手环电量低(${today_.device_battery_pct}%)：顺口提醒对方手环快没电了，洗澡或休息时记得充个电`);
  }
  if (today_.sedentary && (today_.idle_min || 0) >= 30) {
    focusPool.push("久坐提醒：抓住坐太久这件事轻推一把，催对方起身走两步或伸个懒腰");
  }
  const minsNow = hr * 60 + now.getMinutes();
  const goal = (settings && settings.step_goal) ? Number(settings.step_goal) : 8000;
  if (minsNow >= 18 * 60 + 30 && minsNow <= 19 * 60 + 10 && today_.steps != null) {
    const rem = goal - Number(today_.steps || 0);
    if (rem > 0) {
      focusPool.unshift(`临近下班收尾：今日还差 ${rem} 步达标(${goal})，温柔提醒下班顺路走一走就能凑齐`);
    } else {
      focusPool.unshift(`临近下班收尾：今日步数已达标(${today_.steps}步)，给一句轻松的下班肯定`);
    }
  }
  if (today_.sleep_min && hr < 15) {
    focusPool.push("睡眠感受：结合昨晚睡眠时长顺口关心精力状态");
  }
  if (today_.steps != null || today_.active != null) {
    focusPool.push("活动节奏：顺着当前步数或活跃分钟随口夸一句或逗一句");
  }
  if (today_.heart_rate != null || today_.resting_hr != null || today_.hrv != null) {
    focusPool.push("身体状态：从心率或 HRV 感受对方今天是松弛还是有点累，不报枯燥术语");
  }
  if (hr >= 19) {
    focusPool.push("今日晚间小结：结合今天走的步数和身体节奏，给一句温暖的今日收尾或睡前放松提醒");
  }
  focusPool.push(`此刻时段(${period})：结合现在的时间点和整体状态，给一句接地气的生活小提醒`);

  const tones = [
    "像熟人发微信，轻松带点小调侃，别端着",
    "温柔松弛，像朋友递来一杯水的口吻",
    "极简短句，利落直接，不说废话",
    "带一点日常画面感（比如窗边、伸懒腰、倒水、散步）",
    "轻快打气，让人看了一眼心情变好",
  ];
  const pickedFocus = pickAvoidLast(focusPool, LAST_FOCUS_IDX);
  LAST_FOCUS_IDX = pickedFocus.idx;
  const pickedTone = pickAvoidLast(tones, LAST_TONE_IDX);
  LAST_TONE_IDX = pickedTone.idx;

  const persona = CHAR_PERSONAS[character] || CHAR_PERSONAS.qiuqiu;
  const lang = settings.language || "zh-CN";
  const langRule =
    lang === "en"
      ? "Reply in natural, casual English within 60 characters (no emojis, no quotes)."
      : lang === "ja"
      ? "自然な日本語（です/ます過ぎない親しい口調）で30文字以内（句読点含む、絵文字・鍵括弧禁止）。"
      : "使用自然口语中文，30字以内（含标点），不加引号和表情符号。";

  const recentTips = loadRecentTips();
  const base = settings.llm_base_url.replace(/\/+$/, "");
  const url  = base + "/chat/completions";
  // 方舟 coding 端点不认 "auto"，UI 若选 auto 需兜底到具体模型，否则 404
  const model = (settings.llm_model && settings.llm_model !== "auto")
    ? settings.llm_model : "deepseek-v4-flash";

  const sys = `你是蹲在用户电脑桌角的小搭子（${persona}），根据健康数据随口说一句人话。
核心要求：
1. 像真人朋友聊天，绝不说官腔和播报腔。严禁使用「处于常规水平」「异常波动」「建议您」「请注意」「今日数据」「较昨日增多/减少」这类死板模板词。
2. 数据只是参考，不要机械报数或把所有指标念一遍，抓住一个有意思的细节就行；没数据时绝不编造。
3. 本次切入点：${pickedFocus.item}
4. 本次语气：${pickedTone.item}
5. ${langRule}
只输出最终这一句话，不要前缀、解释或换行。`;

  const payload = {
    时间: timeStr,
    今日: today_,
    昨日同期: yd_,
    七日平均: rolling_averages || null,
  };
  let user = JSON.stringify(payload);
  if (recentTips.length > 0) {
    user += "\n最近说过（必须换完全不同的说法、句式和角度，严禁雷同）：\n- " + recentTips.join("\n- ");
  }
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
        body: JSON.stringify({ model, messages, temperature: 1.0, max_tokens: 1024 }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) return null;
      raw = await r.text();
    }
    const j = JSON.parse(raw);
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    // 去掉模型的思考/推理过程：DeepSeek 等会用 <think>…</think> 包裹，或放在 reasoning_content 字段
    let c = msg && msg.content;
    if (c) {
      c = c
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
        .replace(/<\/?think>/gi, "")
        .trim();
    }
    // 思考过程(reasoning_content)绝不展示给用户；content 剥离思考后为空则回退静态提示，不拿推理当答案
    if (!c) return null;
    c = c.replace(/\*+/g, "").replace(/^[「"“'『]+|[」"”'』]+$/g, "").split(/\r?\n/)[0].trim();
    // 长度兜底：中文/日文 30 字，英文 65 字符
    const maxLen = lang === "en" ? 65 : 30;
    const chars = Array.from(c);
    if (chars.length > maxLen) {
      let cut = chars.slice(0, maxLen);
      for (let i = cut.length - 1; i >= Math.max(0, cut.length - 4); i--) {
        if (/[。！？!?….]/.test(cut[i])) { cut = cut.slice(0, i + 1); break; }
      }
      c = cut.join("");
    }
    pushRecentTip(c);
    return c;
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

  // 自定义 App 标识：{ name, icon(dataURL) }，用于小组件左上角图标/标题
  const [appIdentity, setAppIdentity] = useState(null);

  const [dndActive, setDndActive] = useState(false);

  // 桌面伙伴角色：actualChar 为当前实际渲染的角色；characterPref 来自菜单设置
  // （'random' 时每 3 分钟在四个角色间轮换，其余直接锁定该角色）
  const [activeChar, setActiveChar] = useState("qiuqiu");
  const activeCharRef = useRef("qiuqiu");
  activeCharRef.current = activeChar;
  const [characterPref, setCharacterPref] = useState(null); // null = 尚未读回设置

  // 系统勿扰（Focus）实时同步：后端监听 Control Center 广播后推送，无需等下次轮询
  useEffect(() => {
    if (!tauriAvailable()) return;
    let unlisten = null;
    let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("dnd-changed", (e) => setDndActive(!!e.payload)))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  // 音乐播放状态监听：检测到系统音频输出时让萌宠跟着律动
  const [musicPlaying, setMusicPlaying] = useState(false);
  useEffect(() => {
    if (!tauriAvailable()) return;
    let unlisten = null;
    let disposed = false;
    invoke("is_audio_playing_cmd").then((p) => { if (!disposed) setMusicPlaying(!!p); }).catch(() => {});
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("music-state", (e) => setMusicPlaying(!!e.payload)))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  // 磁吸对齐边缘闪光提示
  const [snapEdges, setSnapEdges] = useState([]);
  useEffect(() => {
    if (!tauriAvailable()) return;
    let unlisten = null;
    let disposed = false;
    let timer = null;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("snap-aligned", (e) => {
        const edges = (e && e.payload && Array.isArray(e.payload.edges)) ? e.payload.edges : [];
        if (!edges.length) return;
        setSnapEdges(edges);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => setSnapEdges([]), 500);
      }))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (unlisten) unlisten();
    };
  }, []);

  const [forceWidgetPop, setForceWidgetPop] = useState(false);
  const [aiTip, setAiTip] = useState(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [systemDark, setSystemDark] = useState(true);
  const [testAiStatus, setTestAiStatus] = useState(null); // { status: 'idle'|'testing'|'ok'|'error', message: string }
  const [testDataStatus, setTestDataStatus] = useState(null); // 数据 API（Google 健康）测试状态
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
    C = pickPalette(settingsRef.current.style, dark);
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

  // 数据 API（Google 健康）延迟测试：走 Rust test_data_api → python --ping
  const handleTestDataApi = useCallback(async () => {
    setTestDataStatus({ status: 'testing', message: T("testDataTesting") });
    try {
      const raw = await invoke("test_data_api");
      const r = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (r && r.ok) {
        setTestDataStatus({ status: 'ok', message: T("testDataOk", { ms: r.ms }) + (r.detail ? " · " + r.detail : "") });
      } else {
        setTestDataStatus({ status: 'error', message: T("testDataFail", { e: (r && r.detail) || "unknown" }) });
      }
    } catch (e) {
      setTestDataStatus({ status: 'error', message: T("testDataFail", { e: e.message || "unknown" }) });
    }
  }, []);

  // 加载设置 + 应用语言/主题
  const loadSettings = useCallback(async () => {
    if (!tauriAvailable()) return;
    try {
      const s = JSON.parse(await invoke("get_settings"));
      settingsRef.current = s;
      setSettings(s);
      // 读取自定义名称 + 图标预览（dataURL）
      try {
        const id = JSON.parse(await invoke("get_app_identity"));
        setAppIdentity({ name: id.name || "", icon: id.icon || "" });
      } catch (e) {}
      setCharacterPref(s.character || "qiuqiu");
      const lang = s.language || "zh-CN";
      setLang(lang);
      // 主动查询系统外观：启动时的 appearance-changed 事件可能早于监听器注册而丢失，
      // 不查的话 systemDark 卡在初始值 true，导致「跟随系统」永远走深色
      let sysDark = systemDark;
      try { sysDark = (await invoke("get_appearance")) === "dark"; } catch (e) {}
      setSystemDark(sysDark);
      const dark = s.theme === "dark" ? true : s.theme === "light" ? false : sysDark;
      C = pickPalette(settingsRef.current.style, dark);
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
          let tip = null;
          try {
            tip = await genAiTip(parsed, s, parsed.rolling_averages, activeCharRef.current);
          } catch (e) {
            console.warn("ai tip failed", e);
          } finally {
            aiBusyRef.current = false;
            if (!silent) setAiThinking(false);
          }
          if (tip) { aiTipRef.current = tip; setAiTip(tip); }
        } else if (!s || !s.llm_base_url) {
          setAiThinking(false);
          setAiTip(null);
        }
        // 勿扰检测（仅久坐时查）：始终跟随系统专注模式（已移除用户开关）
        if (tauriAvailable() && today.sedentary && s) {
          try { setDndActive(await invoke("is_dnd_active_cmd")); } catch (e) {}
        } else {
          setDndActive(false);
        }
        // 久坐提醒弹窗：Python 触发提醒时会在 data.json 写 remind_event（ms 时间戳），
        // 检测到新事件 → 在菜单栏图标下方弹出提醒面板（样式/文案与小组件弹窗一致）；
        // 勿扰模式 / 用户已点"稍后"（snooze_until 未过期）则只亮小组件不弹
        const remindEvent = today.remind_event || 0;
        const snoozeUntil2 = Number(today.snooze_until || 0);
        const snoozed2 = snoozeUntil2 > Date.now();
        if (remindEvent > 0 && remindEvent !== lastRemindRef.current) {
          lastRemindRef.current = remindEvent;
          if (tauriAvailable()) {
            setForceWidgetPop(true);
            let dnd = false;
            if (s) { try { dnd = await invoke("is_dnd_active_cmd"); } catch (e) {} }
            if (!dnd && !snoozed2) {
              try { await invoke("show_sed_popover"); } catch (e) {}
            }
          }
        }
        // 手环低电量静默系统通知（≤ 20%，对齐工作时段与午休/工作日设置，每天最多一次，不发声）
        const devBat = today.device_battery != null ? Number(today.device_battery) : null;
        const nowObj = new Date();
        const hrNow = nowObj.getHours();
        const minNow = nowObj.getMinutes();
        const dayNow = nowObj.getDay(); // 0=Sun, 6=Sat
        const startH = (s && s.notify_start_hour != null) ? Number(s.notify_start_hour) : 10;
        const endH = (s && s.notify_end_hour != null) ? Number(s.notify_end_hour) : 19;
        const workdaysOnly = !s || s.workdays_only !== false;
        const lunchMute = !s || s.lunch_break_mute !== false;
        const inWorkday = !workdaysOnly || (dayNow >= 1 && dayNow <= 5);
        const inLunch = lunchMute && (hrNow === 12 || (hrNow === 13 && minNow < 30));
        const afterStart = startH === 10 ? (hrNow > 10 || (hrNow === 10 && minNow >= 10)) : (hrNow >= startH);
        const inBatWindow = inWorkday && !inLunch && afterStart && hrNow < endH;
        if (tauriAvailable() && devBat != null && devBat <= 20 && inBatWindow) {
          const BAT_KEY = "health-widget-bat-notify-v1";
          let notifiedToday = false;
          try {
            const rec = JSON.parse(localStorage.getItem(BAT_KEY) || "null");
            notifiedToday = !!(rec && rec.date === today.date);
          } catch (e) {}
          if (!notifiedToday) {
            let dnd = false;
            if (s) { try { dnd = await invoke("is_dnd_active_cmd"); } catch (e) {} }
            if (!dnd) {
              try { localStorage.setItem(BAT_KEY, JSON.stringify({ date: today.date, battery: devBat })); } catch (e) {}
              try {
                await invoke("show_battery_notification", {
                  deviceName: today.device_name || "Fitbit",
                  battery: devBat,
                  lang: (s && s.language) || "zh-CN",
                });
              } catch (e) {}
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
    if (tauriAvailable()) {
      try { await invoke("refresh_now"); } catch (e) {}
    }
    // 即时反馈：3s 后撤掉旋转动画（refresh_now 是非阻塞的，UI 不该再"假死"；
    // 真正的数据更新由后台 5s 自动轮询接管，不再阻塞 UI 等到 Python 写完）
    setTimeout(() => document.body.classList.remove("hd-refreshing"), 3000);
  }, []);

  // 点击底部 AI 提示语 → 立即换一句（无需重拉 Google Health API）
  const onCycleTip = useCallback(async () => {
    const s = settingsRef.current;
    if (!s || !s.llm_base_url || !s.llm_api_key || !data || aiBusyRef.current) return;
    aiBusyRef.current = true;
    setAiThinking(true);
    try {
      const tip = await genAiTip(data, s, data.rolling_averages, activeCharRef.current);
      if (tip) {
        aiTipRef.current = tip;
        setAiTip(tip);
      }
    } catch (e) {
      console.warn("cycle ai tip failed", e);
    } finally {
      aiBusyRef.current = false;
      setAiThinking(false);
    }
  }, [data]);

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
    C = pickPalette(settingsRef.current.style, dark);
    rerender();
    try {
      const prev = settingsRef.current || {};
      const identityChanged = (s.app_name || "") !== (prev.app_name || "") ||
                              (s.custom_icon || "") !== (prev.custom_icon || "");
      await invoke("save_settings", { json: JSON.stringify(s) });
      settingsRef.current = s;
      setSettings(s);
      // 自定义名称/图标有改动 → 热更新菜单栏图标 + 刷新左上角
      if (identityChanged) {
        try {
          await invoke("set_app_identity", { name: s.app_name || "", icon: s.custom_icon || "" });
          const id = JSON.parse(await invoke("get_app_identity"));
          setAppIdentity({ name: id.name || "", icon: id.icon || "" });
        } catch (e) {}
      }
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
        setSettingsOpen((prev) => {
          if (!prev && settingsRef.current) {
            setDraft({ ...settingsRef.current, useCurrent: false });
          }
          return !prev;
        });
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
        C = pickPalette(s ? s.style : "liquid-glass", eff);
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
          setCharacterPref(s.character || "qiuqiu");
          setLang(s.language || "zh-CN");
          const dark = s.theme === "dark" ? true : s.theme === "light" ? false : systemDark;
          C = pickPalette(settingsRef.current.style, dark);
          rerender();
          // 设置变了（尤其是 LLM）：若配了 LLM 且有数据，立即重新生成 AI 建议
          if (s.llm_base_url && s.llm_api_key && !aiBusyRef.current && data) {
            // 强制重置签名 + 重调 AI
            dataSigRef.current = "";
            aiBusyRef.current = true;
            lastAiTryRef.current = Date.now();
            setAiThinking(true);
            const tip = await genAiTip(data, s, data.rolling_averages, activeCharRef.current);
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

  const [powerPaused, setPowerPaused] = useState(false);
  const powerPausedRef = useRef(false);
  powerPausedRef.current = powerPaused;

  // 锁屏 / 隐藏窗口省电休眠同步：收到后端 power-paused 或页面不可见时冻结动画与轮询
  useEffect(() => {
    const onVis = () => setPowerPaused(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    let unlisten = null;
    let disposed = false;
    if (tauriAvailable()) {
      import("@tauri-apps/api/event")
        .then(({ listen }) =>
          listen("power-paused", (e) => {
            const paused = !!e.payload;
            setPowerPaused(paused);
            if (!paused) load();
          })
        )
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    }
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVis);
      if (unlisten) unlisten();
    };
  }, [load]);

  // 角色选择 / 随机轮换：菜单设置 character='random' 时在四个角色间随机轮换
  useEffect(() => {
    if (characterPref !== "random") {
      setActiveChar(characterPref || "qiuqiu");
      return;
    }
    const pool = ["qiuqiu", "nimbo", "twinkle", "claw"];
    const pick = () => {
      if (powerPausedRef.current) return;
      let next = pool[Math.floor(Math.random() * pool.length)];
      if (next === activeCharRef.current && pool.length > 1) {
        next = pool[(pool.indexOf(next) + 1) % pool.length];
      }
      setActiveChar(next);
    };
    pick();
    const id = setInterval(pick, 3 * 60 * 1000);
    return () => clearInterval(id);
  }, [characterPref]);

  useEffect(() => {
    // 关键：先等设置从磁盘读回（含 llm_base_url/key），再首次拉数据。
    // 否则 load() 里 settingsRef 还是空，AI 调用被跳过且签名已消费，之后轮询永不再调（蓝点根因）
    (async () => {
      await loadSettings();
      await load();
    })();
    // 监听后端采集/重置完成推送的 data-updated 事件，立即刷新；
    // 定时器降为 30 秒低频兜底（锁屏/隐藏休眠期间跳过）
    let unlisten = null;
    let disposed = false;
    if (tauriAvailable()) {
      import("@tauri-apps/api/event")
        .then(({ listen }) => listen("data-updated", () => { if (!powerPausedRef.current) load(); }))
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    }
    const id = setInterval(() => {
      if (!powerPausedRef.current && !document.hidden) load();
    }, 30000);
    return () => {
      disposed = true;
      if (unlisten) unlisten();
      clearInterval(id);
    };
  }, [loadSettings, load]);

  const bottomTip = aiThinking ? T("aiThinking") : (aiTip || null);

  return (
    <div onContextMenuCapture={(e) => e.preventDefault()} style={{ width: "100%", height: "100%", position: "relative", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none", WebkitUserDrag: "none" }}>
      {data ? (
        <Widget
          data={data}
          settings={settings || {}}
          appIdentity={appIdentity}
          character={activeChar}
          onRefresh={onRefresh}
          onReset={onReset}
          onCycleTip={onCycleTip}
          justResetAt={justResetAt}
          sedPopRef={sedPopRef}
          dndActive={dndActive}
          bottomTip={bottomTip}
          forceWidgetPop={forceWidgetPop}
          setForceWidgetPop={setForceWidgetPop}
          powerPaused={powerPaused}
          musicPlaying={musicPlaying}
          snapEdges={snapEdges}
        />
      ) : (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: C.third, fontSize: 12 }}>
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
          onTestDataApi={handleTestDataApi}
          testDataStatus={testDataStatus}
        />
      )}
    </div>
  );
}