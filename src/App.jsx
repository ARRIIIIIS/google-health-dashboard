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
    "<script>" + POWER_GATE + "document.addEventListener('contextmenu',function(e){e.preventDefault();});document.addEventListener('selectstart',function(e){e.preventDefault();});document.addEventListener('click',function(){try{if(window.__cycleEmotion)window.__cycleEmotion();}catch(e){}});</script>";
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
  // 三级文字：玻璃通透后背景会透上来，alpha 太低会被背景吃掉 → 全面提高不透明度
  label: "rgba(255,255,255,1)",
  second: "rgba(255,255,255,0.96)",
  third: "rgba(255,255,255,0.85)",
  // 冷调玻璃：蓝灰 tint（R<B 且 G 居中）透出系统磨砂，贴近 Apple 深色系统色
  bg: "linear-gradient(160deg, rgba(44,46,54,0.32) 0%, rgba(24,26,32,0.24) 100%)",
  card: "rgba(255,255,255,0.10)",
  hairline: "rgba(255,255,255,0.12)",
  // 玻璃顶棱（受光），深色下提亮才能看清面板边界
  rim: "rgba(255,255,255,0.24)",
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
  // 浅色下反向操作：文字压到近纯黑并保持高不透明度，才能从透光的玻璃上「咬」出来
  label: "rgba(0,0,0,0.98)",
  second: "rgba(24,24,28,0.96)",
  third: "rgba(35,35,42,0.86)",
  // 系统 NSVisualEffectView 提供真实液态玻璃模糊，前端只叠极薄白色 tint 提亮。
  // 0.74 太重盖住玻璃 → 0.22 透出系统模糊；再降到 0.10/0.05（用户「很透」偏好）
  bg: "linear-gradient(160deg, rgba(236,238,248,0.10) 0%, rgba(228,230,242,0.05) 100%)",
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
// ── Pixel Anime palette ──────────────────────────────────────────────────────
// 深紫实底 + NES 配色 + 等宽字体；零渐变零圆角零模糊，硬边像素阴影 4px_4px_0px。
const C_PIXEL_DARK = {
  label: "#e0e0ff",
  second: "rgba(224,224,255,0.85)",
  third: "rgba(224,224,255,0.55)",
  // 实底深紫 + 8x 像素网格（CSS gradient 模拟）；前端不让任何模糊透出
  bg: "#2d1b69",
  card: "#1a1040",
  hairline: "#1a1040",
  // NES 调色板
  rim: "#ffd93d",   // 金色边框/角块
  rimSoft: "#4a90d9",
  glassCtl: "#1a1040",
  green: "#50c878",
  red: "#ff6b6b",
  blue: "#4a90d9",
  teal: "#4a90d9",
  indigo: "#4a90d9",
  amber: "#ffd93d",
  alert: "#ff6b6b",
};
const C_PIXEL_LIGHT = {
  label: "#1a1040",
  second: "rgba(26,16,64,0.85)",
  third: "rgba(26,16,64,0.55)",
  // 浅紫青实底（pixel-anime 浅色仍保持实底 + 零模糊）
  bg: "#c5cae9",
  card: "#e8eaf6",
  hairline: "#1a1040",
  rim: "#ffd93d",
  rimSoft: "#4a90d9",
  glassCtl: "#e8eaf6",
  green: "#50c878",
  red: "#ff6b6b",
  blue: "#4a90d9",
  teal: "#4a90d9",
  indigo: "#4a90d9",
  amber: "#ffd93d",
  alert: "#ff6b6b",
};
// ── Brutalist Web palette（网页粗野主义）────────────────────────────────────────
// 纯白/纯黑实底 + 1px 硬边 + 零圆角零阴影零渐变；等宽正文 + 衬线标题，功能色受限。
const C_BRUTAL_DARK = {
  label: "#ffffff",
  second: "#d9d9d9",
  third: "#9a9a9a",
  bg: "#000000",
  card: "#101010",
  hairline: "#ffffff",
  rim: "#ffffff",
  rimSoft: "#ffffff",
  glassCtl: "#1a1a1a",
  green: "#33cc33",
  red: "#ff5555",
  blue: "#6699ff",
  teal: "#33cc33",
  indigo: "#6699ff",
  amber: "#ffd54a",
  alert: "#ff5555",
};
const C_BRUTAL_LIGHT = {
  label: "#000000",
  second: "#333333",
  third: "#6b6b6b",
  bg: "#ffffff",
  card: "#f4f4f4",
  hairline: "#000000",
  rim: "#000000",
  rimSoft: "#000000",
  glassCtl: "#dfdfdf",
  green: "#008000",
  red: "#ff0000",
  blue: "#0000ff",
  teal: "#008000",
  indigo: "#0000ff",
  amber: "#b8860b",
  alert: "#ff0000",
};
// ── Developer Terminal palette（开发者终端）─────────────────────────────────────
// 近黑/纸白实底 + 等宽字体 + 荧光绿；青/品红/琥珀为终端强调色，零阴影零渐变。
const C_TERM_DARK = {
  label: "#4AF626",
  second: "#8BE9FD",
  third: "#6272A4",
  bg: "#0A0E12",
  card: "#0D141B",
  hairline: "#1F2937",
  rim: "#1F2937",
  rimSoft: "#1F2937",
  glassCtl: "#0D141B",
  green: "#4AF626",
  red: "#FF79C6",
  blue: "#8BE9FD",
  teal: "#4AF626",
  indigo: "#FF79C6",
  amber: "#FFB86C",
  alert: "#FF79C6",
};
const C_TERM_LIGHT = {
  label: "#1D3B1D",
  second: "#0E7C8A",
  third: "#8899AA",
  bg: "#FAFAF4",
  card: "#FFFFFF",
  hairline: "#E4E4DA",
  rim: "#E4E4DA",
  rimSoft: "#E4E4DA",
  glassCtl: "#FFFFFF",
  green: "#2F9E2F",
  red: "#C2257A",
  blue: "#0E7C8A",
  teal: "#2F9E2F",
  indigo: "#C2257A",
  amber: "#9A6A00",
  alert: "#C2257A",
};
// 当前生效调色板（随系统/设置切换）
let C = C_DARK;
// 按 (style, dark) 选调色板：液态玻璃走 Apple 调色板，其余走各自实底调色板
function pickPalette(style, dark) {
  if (style === "pixel-anime") return dark ? C_PIXEL_DARK : C_PIXEL_LIGHT;
  if (style === "brutalist-web") return dark ? C_BRUTAL_DARK : C_BRUTAL_LIGHT;
  if (style === "developer-terminal") return dark ? C_TERM_DARK : C_TERM_LIGHT;
  return dark ? C_DARK : C_LIGHT;
}
// 像素动漫风开关（按 style 判定，不再依赖组件内 settingsRef）
function isPixel(style) {
  return style === "pixel-anime";
}
// 网页粗野主义 / 开发者终端 风格开关
function isBrutal(style) {
  return style === "brutalist-web";
}
function isTerm(style) {
  return style === "developer-terminal";
}

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

  // 把 custom_icon 设置渲染成左上角预览（预设→色块，上传→img）
  const iconPreview = (ci) => {
    if (!ci) return null;
    if (ci.startsWith("base64:")) {
      return <img src={"data:image/png;base64," + ci.slice(7)} width="22" height="22" style={{ objectFit: "cover", borderRadius: 4 }} alt="" />;
    }
    const map = { "preset:teal":[48,209,88], "preset:blue":[10,132,255], "preset:orange":[255,159,10], "preset:purple":[175,82,222], "preset:red":[255,69,58] };
    const c = map[ci];
    if (c) return <div style={{ width: 22, height: 22, borderRadius: "50%", background: `rgb(${c[0]},${c[1]},${c[2]})`, boxShadow: "inset 0 0 0 2px rgba(255,255,255,0.7)" }} />;
    return null;
  };

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
        padding: "12px 14px 16px", borderRadius: 36,
        background: C.bg,
        border: "1px solid " + C.hairline, boxSizing: "border-box",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: C.label, marginBottom: 6 }}>{T("settingsTitle")}</div>

      {/* ── App 名称与图标（自定义，置顶）── */}
      <div style={{ padding: "10px 12px", borderRadius: 14, border: "1px solid " + C.hairline, background: "rgba(128,128,128,0.06)" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.label, marginBottom: 7 }}>{"App 名称与图标"}</div>
        <label style={labelStyle}>{"App 名称"}</label>
        <input
          type="text"
          value={draft.app_name || ""}
          onChange={(e) => set("app_name", e.target.value)}
          placeholder={T("appTitle")}
          style={inputStyle}
        />
        <label style={labelStyle}>{"图标"}</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {/* 当前图标预览 */}
          <div style={{ width: 26, height: 26, borderRadius: 6, border: "1px solid " + C.hairline, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(128,128,128,0.12)", flexShrink: 0 }}>
            {iconPreview(draft.custom_icon)}
          </div>
          {/* 预设图标 */}
          {[["preset:teal","48,209,88"],["preset:blue","10,132,255"],["preset:orange","255,159,10"],["preset:purple","175,82,222"],["preset:red","255,69,58"]].map(([pid, rgb]) => {
            const c = rgb.split(",").map(Number);
            const active = draft.custom_icon === pid;
            return (
              <div key={pid} onClick={() => set("custom_icon", pid)}
                style={{ width: 26, height: 26, borderRadius: 6, cursor: "pointer", border: active ? "2px solid " + C.blue : "1px solid " + C.hairline, boxSizing: "border-box",
                  background: `rgb(${c[0]},${c[1]},${c[2]})`, position: "relative", flexShrink: 0 }}>
                <div style={{ position: "absolute", inset: 7, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.85)" }} />
              </div>
            );
          })}
          {/* 上传 */}
          <label style={{ width: 26, height: 26, borderRadius: 6, border: "1px dashed " + C.hairline, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.second, fontSize: 16, flexShrink: 0, background: "rgba(128,128,128,0.1)" }}>
            +
            <input
              type="file"
              accept="image/png,image/jpeg"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                const rd = new FileReader();
                rd.onload = () => {
                  const dataUrl = rd.result;
                  const b64 = String(dataUrl).split(",")[1] || "";
                  set("custom_icon", "base64:" + b64);
                };
                rd.readAsDataURL(f);
                e.target.value = "";
              }}
            />
          </label>
          {/* 重置 */}
          <div onClick={() => { set("app_name", ""); set("custom_icon", ""); }}
            style={{ fontSize: 9.5, fontWeight: 600, color: C.alert, border: "1px solid " + C.alert, borderRadius: 7, padding: "3px 9px", cursor: "pointer", marginLeft: "auto" }}>
            {"重置"}
          </div>
        </div>
        <div style={{ fontSize: 8.5, color: C.third, marginTop: 6, lineHeight: 1.35 }}>
          {"图标应用到小组件左上角 + 菜单栏，保存后立即生效。"}
        </div>
      </div>

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
function Widget({ data, settings, appIdentity, character, onRefresh, onReset, onCycleTip, justResetAt, sedPopRef, dndActive, bottomTip, forceWidgetPop, setForceWidgetPop, powerPaused }) {
  const [showTrend, setShowTrend] = useState(false);
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

  const ballWrap = (
    <div data-tauri-drag-region="false" style={{ position: "relative", width: 52, height: 52, flexShrink: 0, zIndex: 10 }}>
      {ballIframe}
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

  const idleChipWithPop = effIdle != null ? (
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
      {appIdentity && appIdentity.icon ? (
        <img src={appIdentity.icon} width="20" height="20" style={{ display: "block", flexShrink: 0, borderRadius: brutal ? 0 : term ? 3 : 5, objectFit: "cover", boxShadow: brutal || term ? "none" : "0 1px 3px rgba(0,0,0,0.22)" }} alt="" />
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" style={{ display: "block", flexShrink: 0 }}>
          <defs>
            <linearGradient id="hd-bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#1D2642" />
              <stop offset="100%" stopColor="#0A0D18" />
            </linearGradient>
            <linearGradient id="hd-r1" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#FF2D69" />
              <stop offset="100%" stopColor="#FF8C42" />
            </linearGradient>
            <linearGradient id="hd-r2" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#20D670" />
              <stop offset="100%" stopColor="#86F866" />
            </linearGradient>
            <linearGradient id="hd-r3" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#0A84FF" />
              <stop offset="100%" stopColor="#56E2FF" />
            </linearGradient>
          </defs>
          <rect x="1" y="1" width="22" height="22" rx={brutal || isPixel(styleId) ? "0" : term ? "3" : "6"} fill="url(#hd-bg)" stroke="rgba(255,255,255,0.28)" strokeWidth="0.8" />
          <g transform="translate(12,12) rotate(-90)" fill="none" strokeLinecap="round">
            <circle r="7.6" stroke="rgba(255,55,95,0.18)" strokeWidth="1.9" />
            <circle r="5.1" stroke="rgba(48,209,88,0.18)" strokeWidth="1.9" />
            <circle r="2.6" stroke="rgba(10,132,255,0.18)" strokeWidth="1.9" />
            <circle r="7.6" stroke="url(#hd-r1)" strokeWidth="1.9" strokeDasharray="47.75" strokeDashoffset="8.5" />
            <circle r="5.1" stroke="url(#hd-r2)" strokeWidth="1.9" strokeDasharray="32.04" strokeDashoffset="7.2" />
            <circle r="2.6" stroke="url(#hd-r3)" strokeWidth="1.9" strokeDasharray="16.34" strokeDashoffset="4.5" />
          </g>
        </svg>
      )}
      <span style={{ fontSize: 11, fontWeight: 700, color: C.label, letterSpacing: 0.1, ...(brutal ? { fontFamily: "Georgia, 'Times New Roman', serif" } : {}) }}>
        {(appIdentity && appIdentity.name) || (settings && settings.app_name) || T("appTitle")}
      </span>
      {term && <span className="hd-cursor" style={{ display: "inline-block", width: 7, height: 12, background: C.label, verticalAlign: "text-bottom", flexShrink: 0 }} />}
      <div style={{ flex: 1 }} />
      {ballWrap}
      {idleChipWithPop}
      {batteryChip}
      <span
        title={
          syncStale
            ? T("staleSyncTip", { dev: deviceName, m: syncAgeMin != null ? syncAgeMin : "120+" })
            : T("lastSyncTip", { dev: deviceName, t: lastSyncTime || fmtTime(now) })
        }
        style={{
          fontSize: 9,
          fontWeight: syncStale ? 700 : 500,
          color: syncStale ? C.amber : C.third,
          fontVariantNumeric: "tabular-nums",
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          cursor: "default",
        }}
      >
        {syncStale && <span style={{ width: 5, height: 5, borderRadius: "50%", background: C.amber, display: "inline-block" }} />}
        {lastSyncTime || fmtTime(now)}
      </span>
      {/* 设置入口已移至菜单栏 */}
      <div data-tauri-drag-region="false" className="hd-refresh-btn" onMouseDown={function (e) { e.preventDefault(); e.stopPropagation(); if (e.button !== 0) return; onRefresh(); }} title={T("refreshTitle")} style={{ width: 20, height: 20, borderRadius: brutal ? 0 : term ? 3 : "50%", background: brutal ? C.glassCtl : term ? "transparent" : C.glassCtl, border: brutal ? "2px solid " + C.hairline : term ? "1px solid " + C.hairline : "none", boxShadow: brutal || term || isPixel(styleId) ? "none" : "inset 0 0.5px 0 " + C.rim, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, color: C.second }}>
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
      // 圆角统一 36px：与系统 NSVisualEffectView / NSGlassEffectView 的 setCornerRadius(36) 完全一致
      borderRadius: "36px",
      display: "flex", flexDirection: "column",
      // 玻璃模糊由系统底层提供；前端叠加左上 135° 镜面受光柔光晕（不调用 backdrop-filter，零闪烁风险）
      background: "radial-gradient(125% 80% at 16% 0%, " + C.rimSoft + " 0%, rgba(255,255,255,0) 58%), " + C.bg,
      // 135° 斜向液态玻璃折射内棱：左上受光顶棱 + 左侧微亮棱 + 右下背光微反光 + 底部暗收口
      boxShadow:
        "inset 0 1px 0 " + C.rim +
        ", inset 1px 0 0 " + C.rimSoft +
        ", inset -0.5px -0.5px 0 " + C.rimSoft +
        ", inset 0 -1px 0 rgba(0,0,0,0.14)",
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
        date: d,
        steps: map[d].steps || 0,
        sleep_asleep_min: map[d].sleep_asleep_min || 0,
      }));
    }, [t, data.history]);

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
    const fallbackPool = effSed ? SEDENTARY_TIPS : FALLBACK_TIPS;
    const fallbackTip = fallbackPool[Math.floor(Date.now() / 60000) % fallbackPool.length];
    const tipText = cleanTip(bottomTip) || fallbackTip;
    const distStr = distance != null ? distance.toFixed(1) + "km" : "—";
    const calStr = calories != null ? calories + " " + T("kcal") : "";
    const midLine = T("stepsUnit") + " · " + T("distance") + " " + distStr + (calStr ? " · " + calStr : "");

    // 7 日均值差值格式化
    const fmtDelta = (cur, avgVal, unit = "") => {
      if (cur == null || avgVal == null || avgVal === 0) return "—";
      const d = Math.round((cur - avgVal) * 10) / 10;
      const sign = d > 0 ? "+" : "";
      return `${sign}${d}${unit}`;
    };

    const maxBarSteps = Math.max(
      stepGoal,
      ...dailySeries.map((x) => Number(x.steps || 0))
    );

    return (
      <div style={Object.assign({}, glassStyle, { display: "flex", flexDirection: "column", gap: 8 })}>
        {header}
        {showTrend ? (
          <div
            className="hd-view-enter hd-click-area"
            onClick={() => setShowTrend(false)}
            title={T("trendHint")}
            style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "2px 4px", cursor: "pointer" }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: C.label }}>{T("trendTitle")}</span>
              <span style={{ fontSize: 9, color: C.third }}>✕</span>
            </div>
            {/* 7 日步数迷你柱状图 */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 68, padding: "6px 4px 2px", borderBottom: "1px solid " + C.hairline }}>
              {(dailySeries.length ? dailySeries : [{ date: t.date || "—", steps }]).map((item, idx, arr) => {
                const sVal = Number(item.steps || 0);
                const hPct = Math.max(8, Math.round((sVal / Math.max(1, maxBarSteps)) * 100));
                const isToday = idx === arr.length - 1;
                const hit = sVal >= stepGoal;
                const barColor = isToday ? C.green : hit ? C.teal : C.third;
                const dayLbl = (item.date || "").slice(5);
                return (
                  <div key={item.date || idx} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, height: "100%", justifyContent: "flex-end" }}>
                    <span style={{ fontSize: 7.5, color: isToday ? C.label : C.third, fontVariantNumeric: "tabular-nums" }}>
                      {sVal >= 1000 ? (sVal / 1000).toFixed(1) + "k" : (sVal || "0")}
                    </span>
                    <div style={{ width: "100%", maxWidth: 22, height: `${hPct}%`, borderRadius: brutal || isPixel(styleId) ? 0 : 4, background: barColor, opacity: isToday ? 1 : 0.72, boxShadow: isToday && !brutal && !term && !isPixel(styleId) ? "0 0 8px rgba(48,209,88,0.35)" : "none" }} />
                    <span style={{ fontSize: 7.5, color: isToday ? C.label : C.third, fontWeight: isToday ? 700 : 500, fontVariantNumeric: "tabular-nums" }}>{dayLbl}</span>
                  </div>
                );
              })}
            </div>
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
          <div className="hd-view-enter" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div
              className="hd-click-area"
              onClick={() => setShowTrend(true)}
              title={T("trendHint")}
              style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", padding: "0 4px", position: "relative", cursor: "pointer", borderRadius: 8 }}
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
              <div style={{ height: "100%", borderRadius: brutal || isPixel(styleId) ? 0 : 99, width: stepPct + "%", background: "linear-gradient(90deg, #5CE68B 0%, #30D158 60%, #9EFFB8 100%)", boxShadow: brutal || term || isPixel(styleId) ? "none" : "0 0 8px rgba(48,209,88,0.38)", transition: "width .45s cubic-bezier(.2,.8,.2,1)" }} />
            </div>
            <div
              className="hd-click-area"
              onClick={() => setShowTrend(true)}
              title={T("trendHint")}
              style={{
                display: "flex",
                padding: "7px 0",
                borderTop: "1px solid " + C.hairline,
                borderBottom: "1px solid " + C.hairline,
                position: "relative",
                cursor: "pointer",
              }}
            >
              {metrics.map(function (m, i) {
                const empty = m.value == null;
                const softDivider = !brutal && !term && !isPixel(styleId);
                return (
                  <div
                    key={i}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 2,
                      position: "relative",
                      ...(i > 0 && !softDivider ? { borderLeft: "1px solid " + C.hairline } : {}),
                    }}
                  >
                    {i > 0 && softDivider && (
                      <div style={{ position: "absolute", left: 0, top: "12%", bottom: "12%", width: 1, background: "linear-gradient(180deg, transparent, " + C.hairline + ", transparent)" }} />
                    )}
                    <span style={{ fontSize: 8, color: C.third, fontWeight: 500, letterSpacing: 0.3 }}>{m.label}</span>
                    <span style={{ fontSize: 15, fontWeight: 600, color: empty ? C.third : m.color, opacity: empty ? 0.28 : 1, letterSpacing: -0.3, fontVariantNumeric: "tabular-nums" }}>{empty ? "—" : m.value}</span>
                    <span style={{ fontSize: 7.5, color: C.third, fontWeight: 500, opacity: empty ? 0.45 : 0.85 }}>{m.unit}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 2px", position: "relative" }}>
              <span style={{ fontSize: 9, color: C.third, fontWeight: 500, flexShrink: 0 }}>{T("sleep")}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.label, opacity: sleep ? 1 : 0.32, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{fmtSleep(sleep) || "—"}</span>
              <div style={{ flex: 1, height: 4.5, borderRadius: brutal || isPixel(styleId) ? 0 : 99, overflow: "hidden", display: "flex", gap: sleepTotal && !brutal && !isPixel(styleId) ? 2 : 0 }}>
                {(sleepTotal ? sleepStages.filter((p) => p.v > 0) : [{ k: "x", v: 1, c: C.card }]).map(function (p) {
                  return <div key={p.k} style={{ flex: Math.max(p.v, 0.001), background: p.c, height: "100%", borderRadius: brutal || isPixel(styleId) ? 0 : 99 }} />;
                })}
              </div>
              <span style={{ fontSize: 8.5, color: C.third, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{t.sleep_deep_min ? T("deepShort") + t.sleep_deep_min + "·REM" + (t.sleep_rem_min || 0) : ""}</span>
            </div>
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