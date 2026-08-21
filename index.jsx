export const command = "/usr/bin/python3 /Users/dfrobot/google-health-dashboard/fetch_standalone.py >/dev/null 2>&1; cat /Users/dfrobot/google-health-dashboard/data.js 2>/dev/null | sed '1s/^const HEALTH_DATA = //' | sed 's/;$//'"

export const showOnMainScreen = true
export const refreshFrequency = 300000

export const className = `
  top: 8px;
  left: 16px;
  width: 344px;
  height: 272px;
  border-radius: 22px;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', sans-serif;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  @keyframes sed-pulse { 0%,100%{ background:rgba(255,159,10,0.16);} 50%{ background:rgba(255,159,10,0.30);} }
  @keyframes sed-pop { from{ opacity:0; transform:translateY(-8px) scale(0.92);} to{ opacity:1; transform:none;} }
`

// ── Apple system palette (dark) ──────────────────────────────────────────────
const C = {
  label:    'rgba(255,255,255,0.95)',
  second:   'rgba(250,250,252,0.86)',
  third:    'rgba(245,245,250,0.66)',

  bg:       'linear-gradient(160deg, rgba(58,58,64,0.46) 0%, rgba(26,26,30,0.34) 100%)',
  card:     'rgba(255,255,255,0.07)',
  hairline: 'rgba(255,255,255,0.08)',

  green:  '#30D158',
  red:    '#FF375F',
  blue:   '#0A84FF',
  teal:   '#40C8E0',
  indigo: '#5E5CE6',
  amber:  '#FF9F0A',
  alert:  '#FF453A',
}

// ── Line icons ──────────────────────────────────────────────────────────────
const SW = 2
const ICO = {
  heart: (
    <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor'
         strokeWidth={SW} strokeLinecap='round' strokeLinejoin='round'>
      <path d='M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.7a5.5 5.5 0 0 0 0-7.9z'/>
    </svg>
  ),
  pulse: (
    <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor'
         strokeWidth={SW} strokeLinecap='round' strokeLinejoin='round'>
      <polyline points='2 12 6.5 12 9.5 4.5 14.5 19.5 17.5 12 22 12'/>
    </svg>
  ),
  drop: (
    <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor'
         strokeWidth={SW} strokeLinecap='round' strokeLinejoin='round'>
      <path d='M12 2.8s6.4 6.9 6.4 11.1a6.4 6.4 0 0 1-12.8 0C5.6 9.7 12 2.8 12 2.8z'/>
    </svg>
  ),
  wind: (
    <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor'
         strokeWidth={SW} strokeLinecap='round' strokeLinejoin='round'>
      <path d='M9.6 4.6A2 2 0 1 1 11 8H2'/>
      <path d='M12.6 19.4A2 2 0 1 0 14 16H2'/>
      <path d='M17.3 7.3a2.5 2.5 0 1 1 2 4.2H2'/>
    </svg>
  ),
  refresh: (
    <svg width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='currentColor'
         strokeWidth={SW} strokeLinecap='round' strokeLinejoin='round'>
      <path d='M21 12a9 9 0 1 1-2.6-6.4'/>
      <polyline points='21 3 21 9 15 9'/>
    </svg>
  ),
  chair: (
    <svg width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='currentColor'
         strokeWidth={SW} strokeLinecap='round' strokeLinejoin='round'>
      <path d='M6 3v8'/><path d='M18 3v8'/><path d='M6 5h12'/><path d='M6 11h12'/>
      <path d='M8 11v7a2 2 0 0 1-2 2'/><path d='M18 11v7a2 2 0 0 0 2 2'/><path d='M8 14h8'/>
    </svg>
  ),
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtTime(d) {
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0')
}
function fmtSleep(min) {
  if (!min) return null
  return Math.floor(min/60) + 'h' + (min%60 ? min%60+'m' : '')
}

// Map health state to emotion-ball emotionId.
function computeBallEmotion(t, sedOverride) {
  if (!t) return '02'
  // 久坐 → 随机愤怒(21)/出错(34)：这两个负面表情只在久坐提醒时出现
  const isSed = (sedOverride !== undefined) ? sedOverride : t.sedentary
  if (isSed) return Math.random() < 0.5 ? '21' : '34'
  const tip  = t.tip_level
  const sleep = t.sleep_asleep_min || 0
  const steps = t.steps || 0
  const hr = new Date().getHours()
  if (tip === 'alert') return '17'
  if (tip === 'warn')  return sleep < 300 ? '15' : '11'
  if (hr >= 23 || hr < 6) return '00'          // 深夜 → 睡眠
  if (sleep > 0 && sleep < 240) return '00'
  if (sleep > 0 && sleep < 360) return '15'
  if (steps > 10000) return '10'
  if (steps > 0 && steps < 2000) return '12'
  return '19'
}

function cleanTip(s) {
  if (!s) return ''
  return s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
          .replace(/\s{2,}/g, ' ').trim()
}

// 久坐弹窗元素引用（render 每次重建后由 ref 刷新；供胶囊点击开/关用）
let __sedPopEl = null
// 点击「起来了」后的本地重置窗口（ms）：90s 内前端强制显示 0/灰/快乐球，
// 期间后台 sed_reset_server 已把 data.js 重置，下个 fetch 周期数据自然归 0。
let __sedJustReset = 0

// ── Steps ring: Apple Activity style (A 版 · 圆环+卡片) ──────────────────────
function Ring({ value, max, sz }) {
  sz = sz || 88
  const sw   = 8
  const r    = (sz - sw) / 2
  const circ = 2 * Math.PI * r
  const pct  = Math.min(100, (value || 0) / max * 100)
  const dash = pct / 100 * circ
  return (
    <div style={{position:'relative',width:sz,height:sz,flexShrink:0}}>
      <svg width={sz} height={sz} style={{transform:'rotate(-90deg)',display:'block'}}>
        <defs>
          <linearGradient id='ring-g' x1='0%' y1='0%' x2='100%' y2='100%'>
            <stop offset='0%' stopColor='#8BF2A8'/>
            <stop offset='100%' stopColor='#30D158'/>
          </linearGradient>
        </defs>
        <circle cx={sz/2} cy={sz/2} r={r} fill='none'
                stroke='rgba(255,255,255,0.10)' strokeWidth={sw}/>
        {value != null && (
          <circle cx={sz/2} cy={sz/2} r={r} fill='none'
                  stroke='url(#ring-g)' strokeWidth={sw}
                  strokeDasharray={dash + ' ' + (circ - dash)}
                  strokeLinecap='round'/>
        )}
      </svg>
      <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column',
                   alignItems:'center',justifyContent:'center',gap:2}}>
        <span style={{fontSize:22,fontWeight:600,color:C.label,lineHeight:1,
                      letterSpacing:-0.5,fontVariantNumeric:'tabular-nums'}}>
          {value != null ? value : '—'}
        </span>
        <span style={{fontSize:9,fontWeight:500,color:C.second,lineHeight:1}}>步</span>
      </div>
    </div>
  )
}

// ── Background trend (A 版 · 圆环+卡片) ──────────────────────────────────────
function TrendBg({ data, color, id }) {
  const pts = (data || []).map(function(v, i){ return v == null ? null : { i, v } })
  const vals = pts.filter(function(p){ return p })
  if (vals.length < 2) return null
  const W = 100, H = 30
  const min = Math.min.apply(null, vals.map(function(p){ return p.v }))
  const max = Math.max.apply(null, vals.map(function(p){ return p.v }))
  const range = (max - min) || 1
  const x = function(i){ return i / (pts.length - 1 || 1) * W }
  const y = function(v){ return H - 3 - (v - min) / range * (H - 6) }

  let segs = [], cur = []
  pts.forEach(function(p){
    if (p) cur.push(p)
    else { if (cur.length > 1) segs.push(cur); cur = [] }
  })
  if (cur.length > 1) segs.push(cur)

  return (
    <svg width='100%' height='100%' viewBox={'0 0 ' + W + ' ' + H} preserveAspectRatio='none'
         style={{position:'absolute',inset:0,display:'block',pointerEvents:'none'}}>
      <defs>
        <linearGradient id={id} x1='0' y1='0' x2='0' y2='1'>
          <stop offset='0%' stopColor={color} stopOpacity={0.16}/>
          <stop offset='100%' stopColor={color} stopOpacity={0}/>
        </linearGradient>
      </defs>
      {segs.map(function(s, si){
        const line = s.map(function(p){ return x(p.i).toFixed(1) + ',' + y(p.v).toFixed(1) }).join(' ')
        const area = 'M' + line +
                     ' L' + x(s[s.length-1].i).toFixed(1) + ',' + H +
                     ' L' + x(s[0].i).toFixed(1) + ',' + H + ' Z'
        return (
          <g key={si}>
            <path d={area} fill={'url(#' + id + ')'}/>
            <polyline points={line} fill='none' stroke={color} strokeWidth={1.2}
                      strokeLinecap='round' strokeLinejoin='round'
                      vectorEffect='non-scaling-stroke' opacity={0.55}/>
          </g>
        )
      })}
    </svg>
  )
}

// ── Metric card (A 版 · 圆环+卡片) ───────────────────────────────────────────
function Card({ accent, icon, value, unit, label, trend, id }) {
  return (
    <div style={{position:'relative',background:C.card,
                 borderRadius:12,overflow:'hidden',
                 display:'flex',alignItems:'center',gap:8,
                 padding:'8px 9px',flex:1,minWidth:0,
                 backdropFilter:'blur(6px)', WebkitBackdropFilter:'blur(6px)'}}>
      <div style={{position:'absolute',left:0,right:0,bottom:0,height:'70%',
                   overflow:'hidden',pointerEvents:'none'}}>
        <TrendBg data={trend} color={accent} id={id}/>
      </div>
      <div style={{position:'relative',zIndex:1,width:23,height:23,borderRadius:6,
                   background:accent+'22',
                   display:'flex',alignItems:'center',justifyContent:'center',
                   flexShrink:0,color:accent}}>
        {icon}
      </div>
      <div style={{position:'relative',zIndex:1,flex:1,minWidth:0,overflow:'hidden'}}>
        <div style={{fontSize:14,fontWeight:600,color:C.label,lineHeight:1.1,
                     whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',
                     letterSpacing:-0.2,fontVariantNumeric:'tabular-nums'}}>
          {value != null ? value : '—'}
          <span style={{fontSize:8.5,fontWeight:500,color:C.second,marginLeft:2.5}}>{unit}</span>
        </div>
        <div style={{fontSize:9,color:C.second,marginTop:2,fontWeight:500,lineHeight:1}}>
          {label}
        </div>
      </div>
    </div>
  )
}

// ── Sleep row (A 版 · 圆环+卡片) ─────────────────────────────────────────────
function SleepRow({ asleep, awake, light, deep, rem }) {
  const stages = [
    {k:'awake', v:awake||0, c:'rgba(152,152,157,0.55)'},
    {k:'rem',   v:rem||0,   c:C.amber},
    {k:'light', v:light||0, c:C.teal},
    {k:'deep',  v:deep||0,  c:C.indigo},
  ]
  const total = stages.reduce(function(a,p){return a + (p.v||0)}, 0)
  const h = function(min){ return min ? Math.round(min/60*10)/10 + 'h' : null }
  const marks = [
    {n:'深', v:deep}, {n:'REM', v:rem}, {n:'浅', v:light},
  ].filter(function(p){ return p.v })
  return (
    <div>
      <div style={{height:4,borderRadius:2,overflow:'hidden',
                   display:'flex',opacity: asleep ? 0.85 : 0.25}}>
        {(total ? stages : [{k:'x',v:1,c:'rgba(255,255,255,0.10)'}]).map(function(p){return(
          <div key={p.k} style={{flex:Math.max(p.v, 0.001),background:p.c,height:'100%'}}/>
        )})}
      </div>
      <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',
                   marginTop:7,padding:'0 2px',gap:8}}>
        <span style={{display:'flex',alignItems:'baseline',gap:6,flexShrink:0}}>
          <span style={{fontSize:10,fontWeight:500,color:C.third}}>睡眠</span>
          <span style={{fontSize:12,fontWeight:600,color:C.second,lineHeight:1,
                        letterSpacing:-0.2,fontVariantNumeric:'tabular-nums'}}>
            {fmtSleep(asleep) || '—'}
          </span>
        </span>
        <span style={{fontSize:10,color:C.third,fontWeight:500,lineHeight:1.2,
                      whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',
                      textAlign:'right',fontVariantNumeric:'tabular-nums',
                      minWidth:0}}>
          {marks.length
            ? marks.map(function(p){return p.n + ' ' + h(p.v)}).join(' · ')
            : '暂无阶段数据'}
        </span>
      </div>
    </div>
  )
}

// ── Tip ─────────────────────────────────────────────────────────────────────
function Tip({ tip, level }) {
  const dot = level==='alert' ? C.alert : level==='warn' ? C.amber : C.green
  const text = cleanTip(tip)
  return (
    <div style={{display:'flex',alignItems:'center',gap:6,padding:'0 2px'}}>
      <span style={{width:4,height:4,borderRadius:'50%',
                    background:dot,opacity:0.9,flexShrink:0}}/>
      <span style={{fontSize:10,color:C.second,fontWeight:500,lineHeight:1.25,
                    flex:1,overflow:'hidden',display:'-webkit-box',
                    WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{text}</span>
    </div>
  )
}

// ── Render ──────────────────────────────────────────────────────────────────
export const render = function({ output, refresh }) {
  let data = {}
  try { data = JSON.parse(output || '{}') } catch(e) {}

  const t = data.today || {}
  const steps    = t.steps || 0
  const active   = t.active_minutes || 0
  const resting  = t.resting_hr
  // 实时心率（最新样本）；无实时数据时回退静息心率
  const liveHr   = t.heart_rate
  const hrVal    = liveHr != null ? liveHr : resting
  const hrLabel  = '心率'
  const hrv      = t.hrv
  const spo2     = t.spo2
  const resp     = t.respiratory_rate
  const distance = t.distance
  const calories = t.calories
  const sleep    = t.sleep_asleep_min || 0
  const tip      = t.tip
  const level    = t.tip_level || 'good'
  const updated  = t.updated_at
  const sedentary = !!t.sedentary
  const idleMin  = (t.idle_min != null) ? t.idle_min : null

  const now = new Date()
  const hist = Array.isArray(data.history) ? data.history : []

  const rhrSeries = hist.map(function(e){ return e.resting_hr })
  if (resting != null) rhrSeries.push(resting)
  const hrvSeries = hist.map(function(e){ return e.hrv })
  if (hrv != null) hrvSeries.push(hrv)
  const spo2Series = hist.map(function(e){ return e.spo2 })
  if (spo2 != null) spo2Series.push(spo2)
  const respSeries = hist.map(function(e){ return e.respiratory_rate })
  if (resp != null) respSeries.push(resp)

  // ── layout mode: 'a' = A 版(圆环+卡片) · 'b' = B 版(极简数字) ──
  let mode = 'b'
  try { mode = localStorage.getItem('health-widget-layout-v3') || 'b' } catch(e) {}

  // ── emotion-ball iframe ──
  const justReset = (Date.now() - __sedJustReset) < 90000
  const effSed    = justReset ? false : sedentary   // 点击后 90s 内强制显示"未久坐"
  const effIdle   = justReset ? 0 : idleMin
  const eid = computeBallEmotion(t, effSed)
  const ballDoc = '<!doctype html><html><head><meta charset="utf-8">'
    + '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%}'
    + '#bot{width:100%;height:100%}#bot svg{display:block;width:100%;height:100%}</style></head>'
    + '<body><div id="bot"></div>'
    + '<scr' + 'ipt src="http://localhost:9283/rings.js"></scr' + 'ipt>'
    + '<scr' + 'ipt src="http://localhost:9283/emotions.js"></scr' + 'ipt>'
    + '<scr' + 'ipt src="http://localhost:9283/ball.js"></scr' + 'ipt>'
    + '<scr' + 'ipt src="http://localhost:9283/engine.js"></scr' + 'ipt>'
    + '<scr' + 'ipt>(function(){try{'
    + 'var b=EmotionBall.create(document.getElementById("bot"),'
    + '{emotion:"' + eid + '",shape:"blob",eyeScale:1.7,idle:true,lite:true,autostart:true});'
    + 'b.setGaze(0,0);window.__ball=b;window.__ballReady=true;'
    + 'var SED=' + (effSed ? 'true' : 'false') + ';'
    + 'var ac=["10","19","03","13","14","16","30","11","18","33","02","15","12","04","20","35","36","31","39","40"];'
    + 'var ai=0;'
    + 'window.__cycleEmotion=function(){var arr=SED?["21","34"]:ac;ai=(ai+1)%arr.length;b.setEmotion(arr[ai]);};'
    + 'if(!SED){window.__autoTimer=setInterval(window.__cycleEmotion,4500);}'
    + '}catch(e){document.title="ERR:"+(e.message||e).slice(0,80)}})()</scr' + 'ipt>'
    + '</body></html>'

  const ballIframe = (
    <iframe
      srcDoc={ballDoc}
      style={{width:52,height:52,border:'none',background:'transparent',
              display:'block',flexShrink:0,borderRadius:'50%',
              cursor:'pointer',overflow:'hidden'}}
      title="mood-ball"
      ref={function(el){
        if (!el) return
        if (el.__ballWired) return
        el.__ballWired = true
        let tries = 0
        const setup = function(){
          const w = el.contentWindow
          if (!w || !w.__ballReady){ if (tries++ < 50) setTimeout(setup, 100); return }
          try {
            w.document.addEventListener('click', function(){
              try { w.__cycleEmotion() } catch(e){}
            })
          } catch(e){}
        }
        setup()
      }}/>
  )

  // ── 久坐提醒：胶囊 + 球正下方弹窗（浮层，不占布局，球位不动）──
  const SED_POP_KEY = 'health-widget-sed-pop-v1'
  let popDismissed = false
  try {
    const rec = JSON.parse(localStorage.getItem(SED_POP_KEY) || 'null')
    popDismissed = !!(rec && rec.date === t.date && rec.idle === idleMin)
  } catch(e) {}
  const showSedPop = effSed && effIdle != null && !popDismissed

  const dismissSedPop = function(){
    try { localStorage.setItem(SED_POP_KEY, JSON.stringify({date: t.date, idle: idleMin})) } catch(e) {}
  }

  const ballWrap = (
    <div style={{position:'relative',width:52,height:52,flexShrink:0,zIndex:10}}>
      {ballIframe}
      {effSed && effIdle != null && (
        <div ref={function(el){ __sedPopEl = el }}
             style={{position:'absolute', top:'calc(100% + 8px)', left:'50%', marginLeft:-93,
                      width:186, zIndex:50, borderRadius:12, padding:'9px 11px 8px',
                      background:'rgba(38,30,18,0.92)',
                      backdropFilter:'blur(20px)', WebkitBackdropFilter:'blur(20px)',
                      border:'1px solid rgba(255,159,10,0.45)',
                      boxShadow:'0 12px 32px rgba(0,0,0,0.55), 0 0 24px rgba(255,159,10,0.10)',
                      display: showSedPop ? 'block' : 'none',
                      animation:'sed-pop .4s cubic-bezier(.2,.9,.3,1.15)'}}>
          <div style={{position:'absolute', top:-4.5, left:'50%', marginLeft:-4.5,
                       width:9, height:9, background:'rgba(38,30,18,0.92)',
                       borderLeft:'1px solid rgba(255,159,10,0.45)',
                       borderTop:'1px solid rgba(255,159,10,0.45)',
                       transform:'rotate(45deg)'}}/>
          <div style={{fontSize:10.5, fontWeight:700, color:C.amber, letterSpacing:0.2,
                       display:'flex', alignItems:'center', gap:5}}>
            {ICO.chair}<span>已静坐 {idleMin} 分钟</span>
          </div>
          <div style={{fontSize:8.5, color:'rgba(255,159,10,0.65)', marginTop:2}}>
            起来走 3 分钟即可重置计时
          </div>
          <div style={{display:'flex', gap:6, marginTop:7}}>
            <div onMouseDown={function(e){ e.preventDefault(); e.stopPropagation()
                 if (__sedPopEl) __sedPopEl.style.display = 'none'; dismissSedPop() }}
                 style={{flex:1, textAlign:'center', fontSize:9, fontWeight:600,
                         color:'rgba(255,159,10,0.65)',
                         border:'1px solid rgba(255,159,10,0.35)',
                         padding:'3px 0', borderRadius:99, cursor:'pointer'}}>稍后</div>
            <div onMouseDown={function(e){ e.preventDefault(); e.stopPropagation()
                 if (__sedPopEl) __sedPopEl.style.display = 'none'; dismissSedPop()
                 __sedJustReset = Date.now()
                 try { fetch('http://127.0.0.1:9293/reset_sedentary').catch(function(){}) } catch(err){} }}
                 style={{flex:1, textAlign:'center', fontSize:9, fontWeight:600,
                         color:'#0a0a0c', background:C.amber, padding:'4px 0',
                         borderRadius:99, cursor:'pointer'}}>起来了</div>
          </div>
        </div>
      )}
    </div>
  )

  // 静坐计时胶囊（时间左侧；正常灰 / 久坐琥珀呼吸，点击开/关弹窗）
  const idleChip = effIdle != null ? (
    <div
      title={effSed ? '久坐中 · 点击开/关提醒' : '静坐计时'}
      onMouseDown={function(e){
        e.preventDefault()
        if (!effSed || !__sedPopEl) return
        const vis = __sedPopEl.style.display !== 'none'
        __sedPopEl.style.display = vis ? 'none' : 'block'
        if (vis) dismissSedPop()
        else { try { localStorage.removeItem(SED_POP_KEY) } catch(err){} }
      }}
      style={{display:'flex', alignItems:'center', gap:5, height:19,
              padding:'0 8px 0 6px', borderRadius:99, flexShrink:0,
              fontSize:9, fontWeight:600, letterSpacing:0.2,
              fontVariantNumeric:'tabular-nums',
              cursor: effSed ? 'pointer' : 'default',
              ...(effSed
                ? {background:'rgba(255,159,10,0.16)', color:C.amber,
                   animation:'sed-pulse 2.2s ease-in-out infinite'}
                : {background:'rgba(255,255,255,0.07)', color:'rgba(235,235,245,0.45)'})}}>
      {ICO.chair}<span>{effIdle} min</span>
    </div>
  ) : null

  // ── shared header (logo + title + ball + idle chip + time + refresh) ──
  const header = (
    <div style={{display:'flex',alignItems:'center',gap:7,padding:'0 2px'}}>
      <div style={{width:18,height:18,borderRadius:'5.5px',flexShrink:0,
                   background:'linear-gradient(135deg,#FF6482 0%,#FF2D55 60%,#E5245B 100%)',
                   display:'flex',alignItems:'center',justifyContent:'center',
                   boxShadow:'0 1px 5px rgba(255,45,85,0.35)'}}>
        <svg width='12' height='12' viewBox='0 0 24 24' fill='#fff'>
          <path d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'/>
        </svg>
      </div>
      <span style={{fontSize:11,fontWeight:600,color:C.label,letterSpacing:0.2}}>健康</span>
      <div style={{flex:1}}/>
      {ballWrap}
      {idleChip}
      <span style={{fontSize:9,fontWeight:500,color:C.third,
                    fontVariantNumeric:'tabular-nums'}}>{updated || fmtTime(now)}</span>
      <div onMouseDown={function(e){ e.preventDefault(); refresh() }} title="刷新"
           style={{width:19,height:19,borderRadius:'50%',
                   background:'rgba(255,255,255,0.08)',
                   display:'flex',alignItems:'center',justifyContent:'center',
                   cursor:'pointer',flexShrink:0,color:C.second}}>
        {ICO.refresh}
      </div>
    </div>
  )

  const glassStyle = {
    width:'100%', height:'100%',
    boxSizing:'border-box', padding:'12px 14px',
    borderRadius:'22px',
    display:'flex', flexDirection:'column',
    background:C.bg,
    backdropFilter:'blur(54px) saturate(1.9) brightness(1.06)',
    WebkitBackdropFilter:'blur(54px) saturate(1.9) brightness(1.06)',
    border:'1px solid rgba(255,255,255,0.14)',
    boxShadow:'0 10px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.22)',
    overflow:'hidden', position:'relative',
  }

  // ══════════════════════════════════════════════════════════════════════════
  // B 版 · 极简数字风
  // ══════════════════════════════════════════════════════════════════════════
  if (mode === 'b') {
    const stepGoal = 8000
    const stepPct = Math.min(100, Math.round(steps / stepGoal * 100))

    const metrics = [
      {label:hrLabel, value:hrVal, unit:'bpm',  color:C.red},
      {label:'HRV',  value:hrv,     unit:'ms',   color:C.blue},
      {label:'血氧', value:spo2,    unit:'%',    color:C.teal},
      {label:'呼吸', value:resp,    unit:'/min', color:C.indigo},
    ]

    const sleepStages = [
      {k:'awake', v:t.sleep_awake_min||0, c:'rgba(152,152,157,0.55)'},
      {k:'rem',   v:t.sleep_rem_min||0,   c:C.amber},
      {k:'light', v:t.sleep_light_min||0, c:C.teal},
      {k:'deep',  v:t.sleep_deep_min||0,  c:C.indigo},
    ]
    const sleepTotal = sleepStages.reduce(function(a,p){return a + (p.v||0)}, 0)
    const tipDot = level==='alert' ? C.alert : level==='warn' ? C.amber : C.green
    const tipText = cleanTip(tip)

    return (
      <div style={glassStyle}>
        {/* glow */}
        <div style={{position:'absolute',inset:0,pointerEvents:'none',
                     background:'radial-gradient(circle at 0% 0%, rgba(255,45,85,0.10), transparent 40%), radial-gradient(circle at 100% 100%, rgba(10,132,255,0.10), transparent 40%)'}}/>
        {header}

        {/* Hero: big steps number */}
        <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',
                     marginTop:10,padding:'0 4px',position:'relative'}}>
          <div style={{display:'flex',flexDirection:'column'}}>
            <span style={{fontSize:46,fontWeight:700,lineHeight:1,letterSpacing:-2,
                          color:C.label,fontVariantNumeric:'tabular-nums'}}>
              {steps ? steps.toLocaleString() : '—'}
            </span>
            <span style={{fontSize:11.5,fontWeight:500,color:C.second,marginTop:4,letterSpacing:0.3}}>
              {'步 · 距离 ' + (distance != null ? distance.toFixed(1) + 'km' : '—') +
               ' · ' + (calories != null ? calories + ' 千卡' : '')}
            </span>
          </div>
          <div style={{textAlign:'right'}}>
            <span style={{fontSize:14,fontWeight:600,color:C.green,fontVariantNumeric:'tabular-nums'}}>
              {active != null ? active : '—'}
              <span style={{fontSize:9,color:C.third,fontWeight:500}}> min</span>
            </span>
            <div style={{fontSize:9,color:C.third,marginTop:1}}>活跃</div>
          </div>
        </div>

        {/* Progress bar */}
        <div style={{marginTop:9,height:3,borderRadius:1.5,
                     background:'rgba(255,255,255,0.06)',overflow:'hidden',position:'relative'}}>
          <div style={{height:'100%',borderRadius:1.5,width:stepPct + '%',
                       background:'linear-gradient(90deg,#8BF2A8,#30D158)'}}/>
        </div>

        {/* 4 metrics grid */}
        <div style={{display:'flex',marginTop:12,padding:'9px 0',
                     borderTop:'1px solid ' + C.hairline,borderBottom:'1px solid ' + C.hairline,
                     position:'relative'}}>
          {metrics.map(function(m, i){
            return (
              <div key={i} style={{flex:1,display:'flex',flexDirection:'column',
                                   alignItems:'center',gap:2,position:'relative',
                                   ...(i > 0 ? {borderLeft:'1px solid ' + C.hairline} : {})}}>
                <span style={{fontSize:8,color:C.third,fontWeight:500,letterSpacing:0.3}}>{m.label}</span>
                <span style={{fontSize:15,fontWeight:600,color:m.color,
                              letterSpacing:-0.3,fontVariantNumeric:'tabular-nums'}}>
                  {m.value != null ? m.value : '—'}
                </span>
                <span style={{fontSize:7.5,color:C.third,fontWeight:500}}>{m.unit}</span>
              </div>
            )
          })}
        </div>

        {/* Sleep row */}
        <div style={{display:'flex',alignItems:'center',gap:8,marginTop:9,padding:'0 2px',
                     position:'relative'}}>
          <span style={{fontSize:9,color:C.third,fontWeight:500,flexShrink:0}}>睡眠</span>
          <span style={{fontSize:12,fontWeight:600,color:C.label,
                        fontVariantNumeric:'tabular-nums',flexShrink:0}}>
            {fmtSleep(sleep) || '—'}
          </span>
          <div style={{flex:1,height:4,borderRadius:2,overflow:'hidden',display:'flex'}}>
            {(sleepTotal ? sleepStages : [{k:'x',v:1,c:'rgba(255,255,255,0.10)'}]).map(function(p){
              return <div key={p.k} style={{flex:Math.max(p.v,0.001),background:p.c,height:'100%'}}/>
            })}
          </div>
          <span style={{fontSize:8.5,color:C.third,flexShrink:0,fontVariantNumeric:'tabular-nums'}}>
            {t.sleep_deep_min ? '深' + t.sleep_deep_min + '·REM' + (t.sleep_rem_min||0) : ''}
          </span>
        </div>

        {/* Tip */}
        {tipText && (
          <div style={{marginTop:7,display:'flex',alignItems:'center',gap:6,padding:'0 2px',
                       position:'relative'}}>
            <span style={{width:4,height:4,borderRadius:'50%',background:tipDot,
                          opacity:0.9,flexShrink:0,boxShadow:'0 0 6px ' + tipDot}}/>
            <span style={{fontSize:9.5,color:C.second,fontWeight:500,lineHeight:1.3,
                          flex:1,overflow:'hidden',display:'-webkit-box',
                          WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{tipText}</span>
          </div>
        )}
      </div>
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 原版布局（圆环 + 卡片矩阵）
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div style={Object.assign({}, glassStyle, {gap:8})}>
      {header}

      {/* Body */}
      <div style={{display:'flex',gap:12,flex:1,minHeight:0,alignItems:'center'}}>

        <div style={{display:'flex',flexDirection:'column',alignItems:'center',
                     justifyContent:'center',gap:6,flexShrink:0}}>
          <Ring value={steps > 0 ? String(steps) : null} max={8000}/>
          <span style={{fontSize:9,fontWeight:500,color:C.second,
                        fontVariantNumeric:'tabular-nums'}}>
            {active != null ? active : '—'}<span style={{color:C.third}}> 分钟活跃</span>
          </span>
        </div>

        <div style={{display:'flex',flexDirection:'column',gap:7,flex:1,minWidth:0,
                     justifyContent:'center'}}>
          <div style={{display:'flex',gap:7}}>
            <Card accent={C.red}    icon={ICO.heart}
                  value={hrVal} label={hrLabel} unit="bpm" id="tr-rhr" trend={rhrSeries}/>
            <Card accent={C.blue}   icon={ICO.pulse}
                  value={hrv}     label="HRV"  unit="ms"  id="tr-hrv" trend={hrvSeries}/>
          </div>
          <div style={{display:'flex',gap:7}}>
            <Card accent={C.teal}   icon={ICO.drop}
                  value={spo2}    label="血氧" unit="%"   id="tr-spo2" trend={spo2Series}/>
            <Card accent={C.indigo} icon={ICO.wind}
                  value={resp}    label="呼吸" unit="/min" id="tr-resp" trend={respSeries}/>
          </div>
        </div>
      </div>

      {/* Bottom: sleep + tip */}
      <div style={{display:'flex',flexDirection:'column',marginTop:-2}}>
        <SleepRow asleep={sleep} awake={t.sleep_awake_min}
                  light={t.sleep_light_min} deep={t.sleep_deep_min} rem={t.sleep_rem_min}/>
        {tip && (
          <div style={{marginTop:9}}>
            <Tip tip={tip} level={level}/>
          </div>
        )}
      </div>
    </div>
  )
}
