// data-server.js — serves health data + static files
// Endpoints:
//   /api/data    -> re-read data.js from disk and return JSON (no external fetch)
//   /api/refresh -> run fetch_standalone.py to pull fresh data from Google, then return JSON
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dataFile = process.env.GHD_DATA || path.join(__dirname, 'data.js');
const fetchScript = path.join(__dirname, 'fetch_standalone.py');
const PORT = parseInt(process.env.GHD_DATA_PORT || '8910', 10);

// Resolve python3 (macOS may not have a system python3 by default)
let PY = 'python3';
try {
  const w = require('child_process').execSync('which python3 2>/dev/null').toString().trim();
  if (w) PY = w;
} catch (e) {}

function log(m) { console.log('[' + new Date().toISOString() + '] ' + m); }

function loadData() {
  try {
    const raw = fs.readFileSync(dataFile, 'utf8');
    const clean = raw.replace(/\/\/.*\n/g, '').replace('const HEALTH_DATA = ', '').trim();
    return new Function('return ' + clean)();
  } catch (e) {
    return null;
  }
}

const initData = loadData();
if (!initData || !initData.today) {
  console.error('[warn] data.js 尚未生成，等待首次采集（Übersicht 组件需先完成设置并运行采集）');
}
log('Data file: ' + dataFile);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

// Shared promise so concurrent refreshes don't spawn multiple fetches at once
let fetchPromise = null;
function triggerFetch() {
  if (fetchPromise) return fetchPromise;
  fetchPromise = new Promise((resolve) => {
    log('[refresh] spawning ' + fetchScript);
    const p = spawn(PY, [fetchScript], { env: process.env });
    p.stdout.on('data', d => process.stdout.write(d));
    p.stderr.on('data', d => process.stderr.write(d));
    const killTimer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 120000);
    p.on('close', (code) => {
      clearTimeout(killTimer);
      fetchPromise = null;
      log('[refresh] done (exit ' + code + ')');
      resolve(code === 0);
    });
  });
  return fetchPromise;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/data') {
    const fresh = loadData();
    const out = Object.assign({}, fresh || initData);
    let focus = null;
    try { focus = fs.readFileSync(path.join(__dirname, '.focus'), 'utf8').trim() || null; } catch (e) {}
    out.focus = focus;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(JSON.stringify(out));
    return;
  }

  if (req.url === '/api/refresh') {
    let ok = false;
    try { ok = await triggerFetch(); } catch (e) { ok = false; }
    const fresh = loadData() || initData;
    const resp = Object.assign({}, fresh);
    resp._fetch = { ok: !!ok, ts: new Date().toISOString() };
    let focus = null;
    try { focus = fs.readFileSync(path.join(__dirname, '.focus'), 'utf8').trim() || null; } catch (e) {}
    resp.focus = focus;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(JSON.stringify(resp));
    return;
  }

  if (req.url.startsWith('/api/focus/')) {
    const m = decodeURIComponent(req.url.slice('/api/focus/'.length).split('?')[0]);
    const focusFile = path.join(__dirname, '.focus');
    let value = null;
    if (m && m !== 'clear') {
      try { fs.writeFileSync(focusFile, m); value = m; } catch (e) { value = null; }
    } else {
      try { fs.unlinkSync(focusFile); } catch (e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, focus: value }));
    return;
  }

  const filePath = (req.url === '/' || req.url === '')
    ? path.join(__dirname, 'widget.html')
    : path.join(__dirname, path.basename(req.url));

  const ext = path.extname(filePath);
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Check if OAuth config exists — if not, skip auto-fetch (qclaw agent handles collection)
const hasConfig = fs.existsSync(path.join(__dirname, 'config.json'));

server.listen(PORT, () => {
  log('✓ Health data server on http://127.0.0.1:' + PORT);
  log('  data file: ' + dataFile);

  if (!hasConfig) {
    log('  ⚠️  无 config.json，跳过自动采集（由 qclaw agent 负责数据采集）');
    return;
  }

  const FETCH_NORMAL = 10 * 60 * 1000;  // 常规间隔：10 分钟
  const FETCH_FOLLOW = 5 * 60 * 1000;   // 久坐复查间隔：5 分钟

  // 自适应调度：读 data.js 的 today.follow_up / snooze_until 决定下次采集间隔
  function scheduleNext() {
    let followUp = false, snooze = 0;
    try {
      const d = loadData();
      followUp = !!(d && d.today && d.today.follow_up);
      snooze = (d && d.today && d.today.snooze_until) || 0;
    } catch (e) {}
    let delay;
    if (snooze && Date.now() < snooze) {
      delay = Math.max(60 * 1000, snooze - Date.now());   // 稍后再提醒
    } else if (followUp) {
      delay = FETCH_FOLLOW;                                // 久坐复查 5 分钟
    } else {
      delay = FETCH_NORMAL;                                // 常规 10 分钟
    }
    log('[scheduler] next fetch in ' + Math.round(delay / 1000) + 's (follow_up=' + followUp + ', snooze=' + !!snooze + ')');
    setTimeout(async () => {
      try { await triggerFetch(); } catch (e) {}
      scheduleNext();
    }, delay);
  }

  // 启动后 5 秒先采一次，之后按状态自适应
  setTimeout(() => { triggerFetch().then(scheduleNext).catch(scheduleNext); }, 5000);
});
