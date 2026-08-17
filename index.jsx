export const command = "curl -s 'http://127.0.0.1:8910/api/data'"
export const showOnAllScreens = false
export const showOnMainScreen = true
export const refreshFrequency = 600000

export const className = `
  top: 36px;
  left: 16px;
  width: 344px;
  height: 254px;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', sans-serif;
  user-select: none;
  overflow: hidden;
`

// ── Bold saturation palette ─────────────────────────────────────────────────
const C = {
  base:     '#ffffff',
  cardBg:   '#fafafa',     // pill 灰色底
  outline:  '#e5e5ea',
  label:    '#1d1d1f',
  second:   '#4f4f55',
  third:    '#9b9ba0',

  // 饱和主色（参考 Google Health 风格）
  green:    '#1e8a4c',  greenBg:    '#c9ecd2',  greenLite: '#e6f3ea',
  red:      '#ff453a',  redEnd:     '#ff2d55',
  blue:     '#1a73e8',  blueBg:     '#d4e3fc',
  purple:   '#7c4dff',  purpleBg:   '#e2d6f9',
  orange:   '#ff9500',  orangeBg:   '#ffe4b3',
  cyan:     '#129eaf',  cyanBg:     '#d1f0f4',

  tipGood:  '#d1f4d8',  tipGoodTxt:  '#0b5a1e',
  tipWarn:  '#ffe4b3',  tipWarnTxt:  '#7a4100',
  tipAlert: '#ffd1cd',  tipAlertTxt: '#a50009',
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtNum(n) { return n ? Number(n).toLocaleString('zh') : null }
function fmtTime(d) {
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0')
}
function fmtSleep(min) {
  if (!min) return null
  return Math.floor(min/60) + 'h' + (min%60 ? min%60+'m' : '')
}

// ── Bold Ring (thick, rounded, saturated) ───────────────────────────────────
function Ring({ value, max, sz, color, trackColor, label, sub }) {
  sz  = sz || 110
  const sw   = 9
  const r    = (sz - sw) / 2
  const circ = 2 * Math.PI * r
  const pct  = Math.min(100, (value || 0) / max * 100)
  const dash = pct / 100 * circ
  const innerPx = Math.min(22, Math.max(15, Math.floor(sz * 0.22)))
  return (
    <div style={{position:'relative',width:sz,height:sz,flexShrink:0}}>
      <svg width={sz} height={sz} style={{transform:'rotate(-90deg)',display:'block'}}>
        <circle cx={sz/2} cy={sz/2} r={r} fill='none' stroke={trackColor} strokeWidth={sw}/>
        <circle cx={sz/2} cy={sz/2} r={r} fill='none'
          stroke={color} strokeWidth={sw}
          strokeDasharray={dash + ' ' + (circ - dash)}
          strokeLinecap='round'/>
      </svg>
      <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column',
                   alignItems:'center',justifyContent:'center',gap:1}}>
        <span style={{fontSize:8,color:C.second,fontWeight:600,letterSpacing:0.3}}>{label}</span>
        <span style={{fontSize:innerPx,fontWeight:700,color:C.label,lineHeight:1,
                     maxWidth:sz-14,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
          {value != null ? value : '—'}
        </span>
        <span style={{fontSize:8.5,color:C.second,fontWeight:700,letterSpacing:0.2}}>{sub}</span>
      </div>
    </div>
  )
}

// ── Mini sparkline (breaks on null gaps, draws avg baseline) ───────────────
function Spark({ data, color, w, h, placeholder }) {
  w = w || 36; h = h || 18
  const pts = (data || []).map(function(v, i){ return v == null ? null : { i, v } })
  const vals = pts.filter(function(p){ return p })
  if (vals.length < 2) {
    return (
      <div style={{width:w,height:h,display:'flex',alignItems:'center',justifyContent:'center',
                   flexShrink:0, color:placeholder || C.third, fontSize:9, fontWeight:700}}>
        ·
      </div>
    )
  }
  const min = Math.min.apply(null, vals.map(function(p){ return p.v }))
  const max = Math.max.apply(null, vals.map(function(p){ return p.v }))
  const range = (max - min) || 1
  const avg = vals.reduce(function(a,b){return a+b.v}, 0) / vals.length
  const x = function(i){ return i / (pts.length - 1 || 1) * (w - 6) + 3 }
  const y = function(v){ return h - 3 - (v - min) / range * (h - 6) }
  let segs = [], cur = []
  pts.forEach(function(p){
    if (p) cur.push(x(p.i).toFixed(1) + ',' + y(p.v).toFixed(1))
    else { if (cur.length > 1) segs.push(cur); cur = [] }
  })
  if (cur.length > 1) segs.push(cur)
  const first = vals[0], last = vals[vals.length - 1]
  const avgY = y(avg).toFixed(1)
  return (
    <svg width={w} height={h} style={{flexShrink:0, display:'block', alignSelf:'center'}}>
      {/* 平均基线 */}
      <line x1={2} y1={avgY} x2={w-2} y2={avgY}
            stroke={color} strokeWidth={0.6} strokeDasharray='2 1.5' opacity={0.45}/>
      {segs.map(function(s, si){
        return <polyline key={si} points={s.join(' ')} fill='none' stroke={color}
                 strokeWidth={1.5} strokeLinecap='round' strokeLinejoin='round'
                 opacity={0.9}/>
      })}
      {/* 首点（淡灰）+ 末点（实色） */}
      <circle cx={x(first.i).toFixed(1)} cy={y(first.v).toFixed(1)} r={1.4}
              fill='none' stroke={color} strokeWidth={0.8} opacity={0.5}/>
      <circle cx={x(last.i).toFixed(1)} cy={y(last.v).toFixed(1)} r={1.9} fill={color}/>
    </svg>
  )
}

// ── Detail overlay: 7-day line chart for clicked metric ────────────────────
function DetailOverlay({ focus, history, today, onClose, refresh }) {
  const META = {
    heart:  { field:'resting_hr', label:'静息心率', unit:'bpm', color:C.red,    today:today.resting_hr,  decimals:0 },
    hrv:    { field:'hrv',        label:'HRV',     unit:'ms',  color:C.blue,   today:today.hrv,         decimals:0 },
    spo2:   { field:'spo2',       label:'血氧',    unit:'%',   color:C.cyan,   today:today.spo2,        decimals:1 },
  }
  const meta = META[focus]
  if (!meta) return null
  const series = (history || []).map(function(e){ return e[meta.field] })
  if (meta.today != null) series.push(meta.today)
  const pts = series.map(function(v, i){ return v == null ? null : { i, v } })
  const vals = pts.filter(function(p){ return p })
  const W = 280, H = 120, PAD = { l: 26, r: 8, t: 14, b: 18 }
  const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b

  let svg
  if (vals.length < 1) {
    svg = <div style={{width:W,height:H,display:'flex',alignItems:'center',justifyContent:'center',
                       color:C.third,fontSize:11,fontWeight:600}}>暂无数据</div>
  } else {
    const min = Math.min.apply(null, vals.map(function(p){return p.v}))
    const max = Math.max.apply(null, vals.map(function(p){return p.v}))
    const range = (max - min) || 1
    const x = function(i){ return PAD.l + i / (pts.length - 1 || 1) * innerW }
    const y = function(v){ return PAD.t + innerH - (v - min) / range * innerH }
    const avg = vals.reduce(function(a,b){return a+b.v}, 0) / vals.length
    const ticks = 3
    const yTickVals = []
    for (let i = 0; i < ticks; i++) yTickVals.push(min + (max - min) * i / (ticks - 1))

    // 拆线段
    let segs = [], cur = []
    pts.forEach(function(p){
      if (p) cur.push(x(p).toFixed(1) + ',' + y(p.v).toFixed(1))
      else { if (cur.length > 1) segs.push(cur); cur = [] }
    })
    if (cur.length > 1) segs.push(cur)

    const last = vals[vals.length - 1]
    const dateLabels = (history || []).map(function(e){return e.date ? e.date.slice(5) : ''})
    if (today && today.date) dateLabels.push(today.date.slice(5))
    const labelStep = Math.max(1, Math.ceil(dateLabels.length / 5))

    svg = (
      <svg width={W} height={H} style={{display:'block'}}>
        {/* 横向网格 + Y 轴标签 */}
        {yTickVals.map(function(v, i){
          const yy = y(v).toFixed(1)
          return (
            <g key={i}>
              <line x1={PAD.l} y1={yy} x2={W - PAD.r} y2={yy}
                    stroke={C.outline} strokeWidth={0.5} opacity={0.6}/>
              <text x={PAD.l - 4} y={yy} fontSize={8} fill={C.third}
                    textAnchor='end' dominantBaseline='middle' fontWeight={600}>
                {Number(v).toFixed(meta.decimals)}
              </text>
            </g>
          )
        })}
        {/* 平均基线 */}
        <line x1={PAD.l} y1={y(avg).toFixed(1)} x2={W - PAD.r} y2={y(avg).toFixed(1)}
              stroke={meta.color} strokeWidth={0.8} strokeDasharray='3 2' opacity={0.5}/>
        {/* 数据线 */}
        {segs.map(function(s, si){
          return <polyline key={si} points={s.join(' ')} fill='none' stroke={meta.color}
                   strokeWidth={2} strokeLinecap='round' strokeLinejoin='round'/>
        })}
        {/* 数据点 */}
        {vals.map(function(p, i){
          return <circle key={i} cx={x(p.i).toFixed(1)} cy={y(p.v).toFixed(1)} r={2.2}
                         fill={meta.color}/>
        })}
        {/* 当前高亮 + 数值 */}
        <circle cx={x(last.i).toFixed(1)} cy={y(last.v).toFixed(1)} r={4}
                fill='white' stroke={meta.color} strokeWidth={2}/>
        <rect x={Math.min(W - PAD.r - 64, x(last.i) - 32)} y={Math.max(PAD.t - 2, y(last.v) - 22)}
              width={60} height={16} rx={4} fill={meta.color}/>
        <text x={Math.min(W - PAD.r - 64, x(last.i) - 32) + 30}
              y={Math.max(PAD.t - 2, y(last.v) - 22) + 11}
              fontSize={10} fontWeight={700} fill='white' textAnchor='middle'>
          {Number(last.v).toFixed(meta.decimals)} {meta.unit}
        </text>
        {/* X 轴日期 */}
        {dateLabels.map(function(d, i){
          if (i % labelStep !== 0 && i !== dateLabels.length - 1) return null
          return <text key={i} x={x(i).toFixed(1)} y={H - 4} fontSize={8}
                       fill={C.third} textAnchor='middle' fontWeight={500}>{d}</text>
        })}
      </svg>
    )
  }

  async function close(e){
    e && e.stopPropagation && e.stopPropagation()
    try { await fetch('http://127.0.0.1:8910/api/focus/clear') } catch(_){}
    if (refresh) refresh()
  }

  return (
    <div onMouseDown={close}
         style={{position:'absolute', top:30, left:0, right:0, bottom:0,
                 background:'rgba(255,255,255,0.985)',
                 borderRadius:22, padding:'6px 10px 4px',
                 display:'flex', flexDirection:'column', gap:3,
                 zIndex:10, boxShadow:'0 4px 12px rgba(0,0,0,0.10)'}}>
      <div style={{display:'flex', alignItems:'center', paddingLeft:2}}>
        <span style={{width:8, height:8, borderRadius:'50%', background:meta.color, flexShrink:0}}/>
        <span style={{fontSize:11, fontWeight:700, color:C.label, marginLeft:6}}>{meta.label} · 近 7 日</span>
        <div style={{flex:1}}/>
        <div onMouseDown={close} title='关闭'
             style={{width:18, height:18, borderRadius:'50%', background:C.outline,
                     display:'flex', alignItems:'center', justifyContent:'center',
                     cursor:'pointer', fontSize:12, fontWeight:700, color:C.second, lineHeight:1}}>×</div>
      </div>
      <div style={{display:'flex', justifyContent:'center', flex:1, alignItems:'center'}}>{svg}</div>
    </div>
  )
}

// ── Metric card: bold color side-bar + saturated translucent fill ────────────
function Card({ accentColor, icon, iconBg, iconColor, value, unit, label, right, onClick }) {
  return (
    <div onMouseDown={onClick ? function(e){
      e.preventDefault(); e.stopPropagation(); onClick(e)
    } : undefined}
         style={{position:'relative',background:C.cardBg,
                 borderRadius:14,overflow:'hidden',
                 display:'flex',alignItems:'center',gap:7,
                 padding:'7px 9px 7px 8px',flex:1,minWidth:0,
                 cursor:onClick ? 'pointer' : 'default'}}>
      {/* 左侧粗彩条 */}
      <div style={{position:'absolute',left:0,top:0,bottom:0,width:5,
                   background:accentColor,
                   borderTopLeftRadius:14,borderBottomLeftRadius:14}}/>
      {/* 半透明饱和色填充 */}
      <div style={{position:'absolute',inset:0,background:iconBg,opacity:0.5,
                   pointerEvents:'none'}}/>
      <div style={{position:'relative',zIndex:1,
                   width:28,height:28,borderRadius:'50%',
                   background:iconBg,
                   display:'flex',alignItems:'center',justifyContent:'center',
                   flexShrink:0,fontSize:13,fontWeight:700,color:iconColor,lineHeight:1}}>
        {icon}
      </div>
      <div style={{position:'relative',zIndex:1,flex:1,minWidth:0,overflow:'hidden'}}>
        <div style={{fontSize:14,fontWeight:700,color:C.label,lineHeight:1.1,
                     whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
          {value != null ? value : '—'}
          <span style={{fontSize:9,fontWeight:500,color:C.second,marginLeft:1.5}}>{unit}</span>
        </div>
        <div style={{fontSize:8.5,color:C.second,marginTop:2,
                     whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',
                     fontWeight:500,letterSpacing:0.2}}>
          {label}
        </div>
      </div>
      {right}
    </div>
  )
}

// ── Sleep bar (rounded segments, saturated) ─────────────────────────────────
function SleepBar({ asleep, awake, light, deep, rem }) {
  const phases = [
    {k:'awake',v:awake||0,c:C.third,    n:'清醒'},
    {k:'light',v:light||0,c:'#5ac8fa',  n:'浅睡'},
    {k:'deep', v:deep||0, c:C.green,    n:'深睡'},
    {k:'rem',  v:rem||0,  c:C.purple,  n:'REM'},
  ]
  return (
    <div style={{background:'#f7f5fc',borderRadius:14,
                 padding:'8px 10px 7px',marginTop:-22}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
        <span style={{fontSize:9,fontWeight:700,color:C.label,paddingLeft:2}}>睡眠</span>
        <span style={{fontSize:9,fontWeight:600,color:C.second,paddingRight:2}}>{fmtSleep(asleep)||'—'}</span>
      </div>
      <div style={{display:'flex',height:7,borderRadius:3.5,overflow:'hidden',gap:1.5,marginBottom:6}}>
        {phases.map(function(p){return(
          <div key={p.k} style={{flex:p.v||0.4,height:'100%',background:p.c,
                                 borderRadius:3.5,
                                 opacity:asleep?1:0.22}}/>
        )})}
      </div>
      <div style={{display:'flex',gap:10,fontSize:8,color:C.second,fontWeight:500,paddingLeft:2}}>
        {phases.map(function(p){return(
          <span key={p.k} style={{display:'flex',alignItems:'center',gap:3}}>
            <span style={{width:4.5,height:4.5,borderRadius:'50%',background:p.c,flexShrink:0}}/>
            {p.n}
          </span>
        )})}
      </div>
    </div>
  )
}

// ── Active pill (no progress bar) ───────────────────────────────────────────
function ActivePill({ minutes }) {
  return (
    <div style={{background:C.greenBg,borderRadius:12,
                 display:'flex',alignItems:'center',justifyContent:'center',
                 padding:'4px 9px',gap:3,marginTop:3}}>
      <span style={{fontSize:11,fontWeight:700,color:C.green,lineHeight:1}}>
        {minutes != null ? minutes : '—'}
      </span>
      <span style={{fontSize:7.5,fontWeight:600,color:C.green}}>min 活跃</span>
    </div>
  )
}

// ── Tip pill (saturated blocks) ─────────────────────────────────────────────
function Tip({ tip, level, style }) {
  const bg = level==='alert'?C.tipAlert : level==='warn'?C.tipWarn : C.tipGood
  const fg = level==='alert'?C.tipAlertTxt: level==='warn'?C.tipWarnTxt: C.tipGoodTxt
  const dot = level==='alert'?'!': level==='warn'?'⚠':'✓'
  return (
    <div style={{display:'flex',alignItems:'flex-start',gap:5,
                 background:bg,borderRadius:10,padding:'6px 10px',
                 ...(style||{})}}>
      <span style={{width:12,height:12,borderRadius:'50%',
                    background:'rgba(255,255,255,0.55)',
                    display:'flex',alignItems:'center',justifyContent:'center',
                    fontSize:9,fontWeight:800,color:fg,flexShrink:0}}>{dot}</span>
      <span style={{fontSize:9,fontWeight:600,color:fg,lineHeight:1.35,
                    flex:1,overflow:'hidden',display:'-webkit-box',
                    WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{tip}</span>
    </div>
  )
}

// ── Render ───────────────────────────────────────────────────────────────────
export const render = function({ output, refresh }) {
  let data = {}
  try { data = JSON.parse(output || '{}') } catch(e) {}

  const t = data.today || {}
  const steps   = t.steps || 0
  const active  = t.active_minutes || 0
  const resting = t.resting_hr
  const hrv     = t.hrv
  const spo2    = t.spo2
  const resp    = t.respiratory_rate
  const sleep   = t.sleep_asleep_min || 0
  const tip     = t.tip
  const level   = t.tip_level || 'good'
  const updated = t.updated_at

  const now   = new Date()
  const h     = now.getHours()
  const m     = now.getMinutes()
  const inWork = (h >= 10 && h < 12) || (h === 13 && m >= 30) || (h > 13 && h < 19)

  // ── 7-day trend (exclude today) ───────────────────────────────────────────
  const hist = Array.isArray(data.history) ? data.history : []
  const prior = hist.filter(function(e){ return e.date && e.date !== t.date })
  const stepAvg = prior.length >= 2
    ? prior.map(function(e){ return e.steps || 0 })
          .reduce(function(a, b){ return a + b }, 0) / prior.length
    : null
  const stepDiff = stepAvg ? Math.round((steps - stepAvg) / stepAvg * 100) : null
  const stepSub = stepDiff == null
    ? (steps >= 8000 ? '✓达成' : '目标8k')
    : (steps >= 8000 ? '✓ ' : '') + '7日均' + (stepAvg/1000).toFixed(1) + 'k ' +
      (stepDiff >= 0 ? '↑' : '↓') + Math.abs(stepDiff) + '%'

  // sparkline series: history + today (if present)
  const rhrSeries = hist.map(function(e){ return e.resting_hr })
  if (resting != null) rhrSeries.push(resting)
  const hrvSeries = hist.map(function(e){ return e.hrv })
  if (hrv != null) hrvSeries.push(hrv)
  const spo2Series = hist.map(function(e){ return e.spo2 })
  if (spo2 != null) spo2Series.push(spo2)

  // ── Click handlers: set focus then re-render ─────────────────────────────
  const focus = data.focus || null
  async function pickFocus(metric){
    try { await fetch('http://127.0.0.1:8910/api/focus/' + metric) } catch(_){}
    refresh()
  }

  return (
    <div style={{position:'relative', background:C.base, borderRadius:22, width:'100%', height:'100%',
                 boxSizing:'border-box', padding:'9px 11px 9px',
                 display:'flex', flexDirection:'column', gap:1,
                 boxShadow:'0 2px 8px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.06)'}}>

      {/* Header */}
      <div style={{display:'flex',alignItems:'center',gap:8,paddingLeft:2}}>
        {/* 渐变红心 Icon */}
        <div style={{width:22,height:22,borderRadius:'50%',
                     background:'linear-gradient(135deg,#ff453a,#ff2d55)',
                     display:'flex',alignItems:'center',justifyContent:'center',
                     flexShrink:0,boxShadow:'0 1px 3px rgba(255,45,85,0.4)'}}>
          <svg width="12" height="11" viewBox="0 0 13 12" fill="#ffffff">
            <path d="M6.5 11.2C6.2 11.2 5.9 11.1 5.7 10.9L0.7 6.2C-0.3 4.9 -0.3 3.1 0.7 1.8 1.5 0.7 2.8 0 4.3 0 5.1 0 5.8 0.3 6.5 0.7 7.2 0.3 7.9 0 8.7 0 10.2 0 11.5 0.7 12.3 1.8 13.3 3.1 13.3 4.9 12.3 6.2L7.3 10.9C7.1 11.1 6.8 11.2 6.5 11.2Z"/>
          </svg>
        </div>
        <span style={{fontSize:12,fontWeight:700,color:C.label,letterSpacing:-0.2}}>健康</span>

        {/* 实心饱和 工作中徽章 */}
        <div style={{background: inWork ? C.green : C.outline,
                     borderRadius:100, padding:'2.5px 8px',
                     display:'flex',alignItems:'center'}}>
          <span style={{fontSize:8.5,fontWeight:700,
                        color: inWork ? '#ffffff' : C.second,
                        letterSpacing:0.3,lineHeight:1}}>
            {inWork ? '工作中' : '休息中'}
          </span>
        </div>

        <div style={{flex:1}}/>

        <span style={{fontSize:8.5,fontWeight:500,color:C.third}}>{updated || fmtTime(now)}</span>

        <div onMouseDown={async function(e){
          e.preventDefault()
          try{await fetch('http://127.0.0.1:8910/api/refresh')}catch(_){}
          refresh()
        }} title="刷新" style={{width:20,height:20,borderRadius:'50%',background:C.outline,
          display:'flex',alignItems:'center',justifyContent:'center',
          cursor:'pointer',flexShrink:0,color:C.second,fontSize:11,fontWeight:700}}>
          ↻
        </div>
      </div>

      {/* Body: ring column + 2x2 cards column */}
      <div style={{display:'flex',gap:11,flex:1,minHeight:0,alignItems:'stretch',marginTop:-20}}>

        {/* Left: ring + active below */}
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',
                     justifyContent:'center',flexShrink:0}}>
          <Ring value={steps>0 ? fmtNum(steps).replace(/,/g,'') : null}
                max={8000} sz={82}
                color={C.green} trackColor={C.greenBg}
                label="步数" sub={stepSub}/>
          <ActivePill minutes={active}/>
        </div>

        {/* Right: 2×2 cards */}
        <div style={{display:'flex',flexDirection:'column',gap:7,flex:1,minWidth:0,
                     justifyContent:'center'}}>
          <div style={{display:'flex',gap:7}}>
            <Card accentColor={C.red}    icon='♥'  iconBg={C.tipAlert} iconColor={C.red}
                  value={resting} label="心率"  unit="bpm"
                  right={<Spark data={rhrSeries} color={C.red}/>}
                  onClick={function(){ pickFocus('heart') }}/>
            <Card accentColor={C.blue}   icon='H'  iconBg={C.blueBg}   iconColor={C.blue}
                  value={hrv}     label="HRV"   unit="ms"
                  right={<Spark data={hrvSeries} color={C.blue}/>}
                  onClick={function(){ pickFocus('hrv') }}/>
          </div>
          <div style={{display:'flex',gap:7}}>
            <Card accentColor={C.cyan}   icon='O₂' iconBg={C.cyanBg}   iconColor={C.cyan}
                  value={spo2}    label="血氧"  unit="%"
                  right={<Spark data={spo2Series} color={C.cyan}/>}
                  onClick={function(){ pickFocus('spo2') }}/>
            <Card accentColor={C.purple} icon='R'  iconBg={C.purpleBg} iconColor={C.purple}
                  value={resp}    label="呼吸"  unit="/min"/>
          </div>
        </div>
      </div>

      {/* Sleep */}
      <SleepBar asleep={sleep} awake={t.sleep_awake_min}
                light={t.sleep_light_min} deep={t.sleep_deep_min} rem={t.sleep_rem_min}/>

      {/* Tip */}
      {tip && <Tip tip={tip} level={level} style={{marginTop:4}}/>}

      {/* Detail overlay (when a heart metric card is clicked) */}
      {focus && ['heart','hrv','spo2'].indexOf(focus) >= 0 && (
        <DetailOverlay focus={focus} history={hist} today={t} refresh={refresh}/>
      )}
    </div>
  )
}