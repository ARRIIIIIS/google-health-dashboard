# Health Dashboard (Tauri)

macOS 桌面健康小组件：从 Google Health API 拉取步数、心率、睡眠等数据，以毛玻璃面板 + 情绪球的形式常驻屏幕角落。基于 Tauri 2 + React 18，透明无边框、不进 Dock、不抢焦点。

![Platform](https://img.shields.io/badge/platform-macOS-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Rust](https://img.shields.io/badge/Rust-1.88%2B-orange)

## 功能

- 步数 / 距离 / 卡路里 / 活跃分钟
- 实时心率 / HRV / 血氧 / 呼吸率
- 睡眠阶段（深睡 / 浅睡 / REM / 清醒）
- 情绪球桌面萌宠（呼吸、眨眼、自动换表情，久坐变愤怒/出错）
- LLM 提示语：配置任意 OpenAI 兼容 API（如 DeepSeek），每次数据变化生成 20 字内个性化提示
- 久坐提醒弹窗 + 点击「起来了」立即重置
- 长按标题栏拖拽移动，位置自动记忆（重启后保持）
- 刷新间隔 5 / 15 / 30 分钟可选，点击刷新图标即刻拉取
- 毛玻璃磨砂面板，Apple 风格超椭圆连续曲率圆角（36px）
- 三语言界面（简体中文 / English / 日本語）

## 安装

从 [Releases](https://github.com/ARRIIIIIS/google-health-dashboard/releases) 下载最新的 `.dmg`，打开后把 `Health Dashboard.app` 拖入「应用程序」即可。

首次启动后通过菜单栏图标 → 设置，在浏览器引导页中完成：

1. **Google 健康数据**：OAuth 授权，凭据保存在 `~/.google-health-mcp/`（不会进仓库）
2. **AI 提示语**：填入 LLM Base URL / API Key / 模型名（OpenAI 兼容格式）

## 开发

```bash
# 安装前端依赖
npm install

# 开发模式（Vite + Tauri 窗口）
npm run tauri dev

# 生产构建
npm run tauri build   # 产物：src-tauri/target/release/bundle/macos/Health Dashboard.app
```

> 注意：构建依赖 Rust ≥ 1.88（rustup stable）。若本机同时装有 Homebrew 的 rust/cargo，需保证 `~/.cargo/bin` 在 PATH 前部，否则会因 MSRV 报错。

## 架构

```
health-dashboard-tauri/
├── src/                    # 前端（React 18 + Vite）
│   ├── App.jsx             # 主组件：小组件 UI、设置面板、情绪球 iframe
│   ├── main.jsx            # React 入口
│   ├── styles.css          # 样式与动画
│   └── emotion-ball/       # 情绪球引擎（内联进 iframe，零 HTTP 服务）
├── src-tauri/              # Tauri 后端（Rust）
│   ├── src/main.rs         # 窗口管理、拖拽定位持久化、TrayIcon、采集调度、命令
│   ├── resources/
│   │   ├── fetch_standalone.py  # Google Health 采集（写 JSON，每 5 分钟）
│   │   └── setup.html           # 设置引导页（浏览器打开）
│   ├── tauri.conf.json     # 窗口配置（344×272，透明无边框）
│   ├── capabilities/       # Tauri 2 ACL 权限
│   └── Cargo.toml
├── index.html
├── vite.config.js
└── package.json
```

## 数据流

```
Google Health API
    ↓ (Python fetch_standalone.py，每 5 分钟)
data.json (app_data_dir)
    ↓ (Tauri read_data 命令)
React 组件渲染
    ↓
透明置顶桌面窗口
```

- **自动刷新**：Rust 后端定时调用 Python 写 `data.json`
- **手动刷新**：前端 `invoke('refresh_now')` → Rust 调 Python → 写 `data.json`
- **久坐重置**：前端 `invoke('reset_sedentary')` → Rust 直接改 `data.json`
- **前端轮询**：每 5 秒 `invoke('read_data')` 读 `data.json`，数据变化即重渲染
- **点击即刻响应**：90 秒前端窗口强制显示归零状态，不等后端采集

## 已知限制

- 打包后需要目标机器有 Python 3 环境（采集脚本依赖）
- Google Health 首次使用需通过浏览器引导页完成 OAuth 授权
- 窗口透明 + 置顶效果针对 macOS 优化，其他平台玻璃感会退化

## License

MIT
