<div align="center">

# Fitbit Air

**A translucent Liquid Glass desktop health widget for macOS — powered by Google Health API, Tauri 2, and React 18.**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

[![Version](https://img.shields.io/badge/version-3.1.0-c1ff12?style=flat-square)](https://github.com/ARRIIIIIS/google-health-dashboard/releases/tag/v3.1.0)
[![Platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-0a84ff?style=flat-square)](#installation)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-24c8db?style=flat-square)](https://v2.tauri.app/)
[![React](https://img.shields.io/badge/React-18-61dafb?style=flat-square)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-1.88%2B-f74c00?style=flat-square)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/license-MIT-30d158?style=flat-square)](LICENSE)

<br>

<img src="assets/preview.jpg" alt="Fitbit Air macOS Desktop Widget" width="400">

</div>

---

## Overview

**Fitbit Air** is a lightweight, borderless macOS desktop widget that stays quietly anchored on your desktop without appearing in the Dock or stealing window focus. Built with native macOS vibrancy (`NSVisualEffectView`) and a `24px` super-ellipse **Liquid Glass** surface, it keeps your daily movement, heart rate, Fitbit battery level, and sedentary rhythm visible at a glance.

## Key Features

- **Liquid Glass Craft**: Authentic macOS frosted glass (`24px` radius) that automatically adapts to Light and Dark system appearances.
- **Real-Time Health Telemetry**: Steps (with customizable daily goal `1,000 – 50,000`), distance, calories, active minutes, live/resting heart rate, HRV, SpO₂, and sleep stage distribution.
- **Fitbit Battery & Sync Capsule**: Reads `pairedDevices` battery percentage in real time alongside your sedentary timer (`≤25%` amber low-battery alert; sync warning after 2h of inactivity).
- **7-Day Smooth Glow Trend Chart**: Click the steps or heart rate area to expand an inline 7-day trend chart with bottom opacity fade, dashed weekend/missing-data bridging, and clickable date/weekday labels.
- **Interactive Desktop Companions**: Four animated companions — **Qiuqiu**, **Nimbo**, **Twinkle**, and **Claw** (plus 3-minute auto-shuffle) — with 30fps cursor gaze tracking and automatic zero-power freeze on screen lock or hide.
- **AI-Powered Micro-Coaching**: Connects to any OpenAI-compatible API to generate concise, persona-driven health nudges (<30 chars) with a 6-item deduplication memory. Click the tip anytime to refresh.
- **Smart Sedentary Detection**: Combines step deltas with macOS HID idle / screen-lock awareness (never triggers false alerts while away), supporting custom active hours, lunch mute (`12:00–13:30`), workdays-only mode, and macOS Focus/DND sync.
- **Streamlined Menu Bar & 3-Step Setup Wizard**: Menu bar stays minimal (**Companion**, **Settings & Preferences…**, **Restart**, **Quit**). All configuration lives in a local browser wizard secured by a per-process `X-Setup-Token`.

## Installation

1. Download **`Fitbit.Air_3.1.0_aarch64.dmg`** from [GitHub Releases](https://github.com/ARRIIIIIS/google-health-dashboard/releases/latest).
2. Open the DMG and drag **`Fitbit Air.app`** into **Applications**.
3. Launch the app and click the menu bar icon → **Settings & Preferences…** to complete the 3-step setup in your browser:
   - **01 · Google Health Data**: Enter OAuth Client ID & Secret, authorize in one click, and test API latency.
   - **02 · AI Health Tips** *(optional)*: Pick a provider or enter any OpenAI-compatible Base URL, API Key, and model name.
   - **03 · Preferences & Schedule**: Visually pick your **Desktop Companion**, theme, language, sedentary schedule, daily step goal, launch at login, and local data directory.

## Development & Build

### Prerequisites

- **macOS** (Apple Silicon recommended)
- **Rust ≥ 1.88** (`rustup` stable; ensure `~/.cargo/bin` precedes Homebrew in `PATH`)
- **Node.js ≥ 20** & **Python 3** (used by `fetch_standalone.py`)

### Commands

```bash
# Install frontend dependencies
npm install

# Run in development mode (Vite + Tauri)
npm run tauri dev

# Build and install cleanly to /Applications/Fitbit Air.app
npm run install:mac

# Package a styled DMG installer (requires built .app)
bash ./scripts/build_dmg.sh "/Applications/Fitbit Air.app" "./Fitbit.Air_3.1.0_aarch64.dmg"
```

## Architecture

```text
├── assets/
│   ├── preview.jpg          # Widget preview screenshot
│   └── dmg/                 # DMG installer background & Finder layout assets
├── scripts/
│   ├── install_app.sh       # Build & install clean single-instance .app
│   ├── build_dmg.sh         # Create styled .dmg with fixed icon positions
│   └── patch_dsstore.py     # Verify & pin Finder .DS_Store window geometry
├── src/                     # React 18 + Vite frontend
│   ├── App.jsx              # Liquid Glass widget, 7-day trend chart, companion host
│   ├── SedPopover.jsx       # Sedentary reminder menu bar popover
│   ├── i18n.js              # Localization strings (zh / en / ja)
│   └── mood-mates/ & claw/  # Companion rendering engines & SVG assets
├── src-tauri/               # Tauri 2 Rust backend
│   ├── src/main.rs          # Window lifecycle, tray menu, local setup server, scheduler
│   ├── resources/
│   │   ├── fetch_standalone.py  # Google Health data collector
│   │   └── setup.html           # 3-step local setup wizard
│   ├── tauri.conf.json      # Tauri window & bundle configuration
│   └── Cargo.toml
└── tests/                   # Collector regression tests
```

## Privacy & Security

- **100% Local-First**: All OAuth tokens, API keys, and health snapshots stay on your machine (`~/.google-health-mcp/` and Tauri `app_data_dir`). Zero third-party analytics or telemetry.
- **Cross-Site Protection**: The local setup HTTP server (`127.0.0.1`) validates a per-process `X-Setup-Token` on all mutating and sensitive endpoints.

## FAQ

- **What is Fitbit Air?**
  Fitbit Air is an open-source macOS desktop health widget built with Tauri 2 and React 18 that displays Google Health metrics, Fitbit battery status, 7-day trends, interactive companions, and smart sedentary reminders in a Liquid Glass overlay.
- **Does Fitbit Air upload my data to any external server?**
  No. All health data and OAuth tokens stay strictly on your Mac. Optional AI coaching only calls the OpenAI-compatible endpoint you configure.
- **Does it consume battery when the Mac is locked?**
  No. Animations and background polling automatically freeze on macOS screen lock or when hidden.
- **Where can AI tools read structured project metadata?**
  See [`llms.txt`](llms.txt) and [`llms-full.txt`](llms-full.txt) for machine-readable project documentation.

## License

[MIT](LICENSE) © [ARRIIIIIS](https://github.com/ARRIIIIIS)
