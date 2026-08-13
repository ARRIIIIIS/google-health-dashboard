#!/usr/bin/env node
/**
 * 健康仪表盘 · 界面与引导设置服务器
 *
 * 功能：
 *   - 浏览器仪表盘（/）
 *   - 傻瓜式引导设置向导（/setup）
 *   - Google OAuth 授权回调（/oauth/callback）
 *   - 配置/状态/测试接口（/api/*）
 *
 * 使用: node standalone-server.js
 * 访问: http://localhost:8911
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = __dirname;
const PUBLIC = path.join(BASE, 'public');
const CONFIG_FILE = process.env.GHD_CONFIG || path.join(BASE, 'config.json');
const TOKEN_FILE  = process.env.GHD_TOKENS || path.join(BASE, 'tokens.json');
const DATA_FILE   = process.env.GHD_DATA   || path.join(BASE, 'data.js');
const FETCH       = path.join(BASE, 'fetch_standalone.py');
const PORT        = parseInt(process.env.GHD_PORT || '8911', 10);

// Google Health API 所需授权范围
const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.nutrition.readonly'
];

// ─── 配置读写 ──────────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
function loadToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')); }
  catch { return null; }
}
function redirectUri(cfg) {
  return (cfg.google && cfg.google.redirect_uri) || `http://127.0.0.1:${PORT}/oauth/callback`;
}
function isConfigured() {
  const c = loadConfig();
  const g = c.google || {};
  const tok = loadToken();
  return !!(g.client_id && g.client_secret) && !!(tok && tok.refresh_token);
}

// ─── 数据读取 ──────────────────────────────────────────────────────────────
function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const clean = raw.replace('const HEALTH_DATA =', '').trim().replace(/;\s*$/, '');
    return JSON.parse(clean);
  } catch { return null; }
}

// ─── 运行采集脚本 ──────────────────────────────────────────────────────────
function runFetch() {
  return new Promise((resolve) => {
    const p = spawn('python3', [FETCH], { env: process.env });
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('close', (code) => resolve(code === 0));
  });
}

// ─── 构建 Google 授权 URL ──────────────────────────────────────────────────
function buildAuthUrl(cfg) {
  const g = cfg.google || {};
  if (!g.client_id) return null;
  const params = new URLSearchParams({
    client_id: g.client_id,
    redirect_uri: redirectUri(cfg),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ─── 用授权码换取 token ────────────────────────────────────────────────────
function exchangeCode(code, cfg) {
  return new Promise((resolve, reject) => {
    const g = cfg.google || {};
    const body = new URLSearchParams({
      code,
      client_id: g.client_id,
      client_secret: g.client_secret,
      redirect_uri: redirectUri(cfg),
      grant_type: 'authorization_code'
    }).toString();
    const proxy = cfg.proxy || '';
    const args = ['-s', '--max-time', '30', '-X', 'POST',
                  'https://oauth2.googleapis.com/token', '-d', body];
    if (proxy) args.splice(1, 0, '--proxy', proxy);
    const p = spawn('curl', args, { env: process.env });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', () => {
      try {
        const tok = JSON.parse(out);
        if (tok.error) return reject(new Error(tok.error_description || tok.error));
        if (!tok.refresh_token) {
          return reject(new Error('未返回 refresh_token：请确认 OAuth 客户端类型为「桌面应用」，并删掉旧凭据重新创建后授权'));
        }
        const data = {
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          expires_in: parseInt(tok.expires_in || 3600, 10),
          expires_at: Math.floor(Date.now() / 1000) + parseInt(tok.expires_in || 3600, 10)
        };
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
        resolve(tok);
      } catch (e) { reject(e); }
    });
  });
}

// ─── 静态页 ────────────────────────────────────────────────────────────────
function serveFile(res, file, type) {
  try {
    const html = fs.readFileSync(file, 'utf-8');
    res.writeHead(200, { 'Content-Type': type || 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  } catch {
    res.writeHead(500); res.end('文件缺失');
  }
}

// ─── 路由 ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // 引导设置页
  if (pathname === '/setup') {
    return serveFile(res, path.join(PUBLIC, 'setup.html'));
  }

  // OAuth 回调
  if (pathname === '/oauth/callback') {
    const code = url.searchParams.get('code');
    const cfg = loadConfig();
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('缺少授权码');
    }
    try {
      await exchangeCode(code, cfg);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:80px">
        <h1>✅ 授权成功！</h1><p>你可以关闭这个标签页，回到设置向导继续。</p>
        <script>setTimeout(()=>window.close(),2500);</script></body>`);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:80px">
        <h1>❌ 授权失败</h1><p>${String(e.message || e).replace(/</g,'')}</p>
        <p><a href="/setup">返回重新设置</a></p></body>`);
    }
    return;
  }

  // API
  if (pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // 状态
    if (pathname === '/api/status') {
      const c = loadConfig(); const g = c.google || {}; const tok = loadToken();
      return res.end(JSON.stringify({
        configured: isConfigured(),
        hasClient: !!(g.client_id && g.client_secret),
        hasToken: !!(tok && tok.refresh_token),
        client_id: g.client_id || '',
        client_secret: g.client_secret || '',
        proxy: c.proxy || '',
        redirect_uri: redirectUri(c),
        port: PORT
      }));
    }

    // 保存客户端/代理配置
    if (pathname === '/api/config' && req.method === 'POST') {
      let body = '';
      await new Promise(r => { req.on('data', d => body += d); req.on('end', r); });
      let input; try { input = JSON.parse(body); } catch { return res.end(JSON.stringify({ ok: false })); }
      const cfg = loadConfig();
      cfg.google = cfg.google || {};
      if (input.client_id) cfg.google.client_id = input.client_id;
      if (input.client_secret) cfg.google.client_secret = input.client_secret;
      if (input.proxy !== undefined) cfg.proxy = input.proxy || null;
      if (!cfg.google.redirect_uri) cfg.google.redirect_uri = redirectUri(cfg);
      saveConfig(cfg);
      return res.end(JSON.stringify({ ok: true }));
    }

    // 授权 URL
    if (pathname === '/api/oauth/url') {
      const cfg = loadConfig();
      const u = buildAuthUrl(cfg);
      return res.end(JSON.stringify({ url: u }));
    }

    // 测试连接：跑一次采集，返回摘要
    if (pathname === '/api/test' && req.method === 'POST') {
      const ok = await runFetch();
      if (!ok) return res.end(JSON.stringify({ ok: false, error: '采集脚本执行失败，请检查配置与网络' }));
      const data = readData();
      return res.end(JSON.stringify({ ok: true, today: data ? data.today : null }));
    }

    // 数据接口（直接读 data.js）
    if (pathname === '/api/data') {
      const data = readData();
      if (!data) return res.end(JSON.stringify({ today: null }));
      return res.end(JSON.stringify(data));
    }

    // 触发刷新（采集）
    if (pathname === '/api/refresh' && req.method === 'POST') {
      runFetch().then(ok => res.end(JSON.stringify({ ok })));
      return;
    }

    return res.end(JSON.stringify({ error: 'unknown' }));
  }

  // 首页：已配置→仪表盘，未配置→引导设置
  if (pathname === '/' || pathname === '/index.html') {
    if (isConfigured()) {
      return serveFile(res, path.join(PUBLIC, 'dashboard.html'));
    }
    res.writeHead(302, { Location: '/setup' });
    return res.end();
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`✓ 健康仪表盘已启动: http://localhost:${PORT}`);
  console.log(`✓ 首次使用请打开: http://localhost:${PORT}/setup`);
  if (!isConfigured()) console.log('⚠ 尚未完成设置，已自动跳转引导界面');
});
