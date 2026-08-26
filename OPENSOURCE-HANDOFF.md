# 开源交接给 WorkBuddy · Health Dashboard (Tauri)

> 项目根目录：`/Users/dfrobot/health-dashboard-tauri/`
> 交接时间：2026-08-26
> 状态：本地可正常运行（macOS 已部署 `/Applications/Health Dashboard.app`），**尚未 git 初始化，也从未推过 GitHub**。

---

## 一、这是个什么项目

Tauri 2 + React 18 的 macOS 桌面健康小组件，常驻屏幕角落，从 Google Health API v4 拉取步数/心率/睡眠等数据，毛玻璃面板 + 情绪球展示。不进 Dock、不抢焦点、登录自启。

旧的 Web 版（`~/google-health-dashboard`，7 步 OAuth 向导）是另一个仓库，**本项目是重写的 Tauri 桌面版，不要混**。

---

## 二、必须掌握的核心文件（按重要性）

| 文件 | 作用 |
|---|---|
| `src-tauri/src/main.rs` (1098 行) | 唯一 Rust 文件：Tauri 命令、菜单栏 TrayIcon、采集线程、坐标定位、自启、open_external |
| `src/App.jsx` (966 行) | React 前端：小组件 UI、设置面板、情绪球 iframe、事件监听 |
| `src/i18n.js` (159 行) | 三语言（zh-CN/en/ja）词条 + `t(key)` |
| `src-tauri/tauri.conf.json` | 窗口配置（344×272，透明，固定位置）、bundle 资源、features |
| `src-tauri/Cargo.toml` | 依赖；features = `["macos-private-api", "image-png", "tray-icon"]` |
| `src-tauri/capabilities/default.json` | **Tauri 2 ACL 权限**（缺它前端事件/窗口 API 全静默失败，已配好勿删） |
| `src-tauri/resources/fetch_standalone.py` (856 行) | Python 采集脚本，常驻线程每 300s 跑 `--once` 写 data.json；读 `~/.google-health-mcp/config.json`（**不在仓库内**） |
| `src-tauri/icons/128x128.png` | 菜单栏图标（TrayIcon 实际用的就是它） |
| `HANDOVER.md` | 完整开发交接文档（13 条硬性规则、命令清单、菜单结构、坐标模型） |
| `README.md` | 已有，MIT 标识，但内容需按现状更新 |

---

## 三、构建 / 运行命令（WorkBuddy 必读）

```bash
cd /Users/dfrobot/health-dashboard-tauri
export PATH="$HOME/.cargo/bin:$PATH"   # 必须用 Homebrew 的 rustc 1.98，系统 1.87 不支持 Tauri 2
npm install
npm run tauri dev        # 开发预览（注意：dev 模式在某些环境 WebView 会 Load failed，属已知良性）
npm run tauri build      # 必须用它！只 cargo build 不重嵌 dist 会白屏
# 产物：
#   src-tauri/target/release/bundle/macos/Health Dashboard.app   ← 构建产物（勿直接点）
#   src-tauri/target/release/bundle/dmg/Health Dashboard_1.0.0_aarch64.dmg
# 安装/更新：
cp -R "src-tauri/target/release/bundle/macos/Health Dashboard.app" /Applications/
```

### 13 条硬性规则（违反即翻车，勿回退，详见 HANDOVER.md）
1. 必须 `npm run tauri build`，不能只 `cargo build --release`
2. 构建前 `export PATH="$HOME/.cargo/bin:$PATH"`
3. 窗口层级唯一正确值 `-2147483602`；collectionBehavior 17（CanJoinAllSpaces+Stationary）
4. 激活策略双保险：LSUIElement + `set_activation_policy(Accessory)`
5. 圆角必须 React CSS（border-radius 22 + SQUIRCLE clip-path），不放 contentView.layer
6. 菜单栏图标走 **Tauri TrayIconBuilder**（手写 NSStatusItem 有 panic/点击劫持坑，已弃用）
7. 手搓 .ico 会损坏（上限 256px）→ 必须官方 `npm run tauri icon`
8. objc 0.2.7 无 foundation；自定义 NSPoint/NSSize/NSRect impl Encode，从 crate 根导出 `objc::{Encode, Encoding}`
9. 返回 void 的 `msg_send!` 必须 `let _: () =` 显式标注（否则 E0283）
10. qlmanage 压白背景 → 用 `convert -background none`
11. token 过期且刷新失败直接 exit 不写 data 文件
12. capabilities/default.json 是前端事件/窗口 API 生效的前提
13. 坐标模型：绝对坐标（Tauri 左上原点），`set_position` 直接喂窗口，不再叠加 NSScreen.frame.origin

---

## 四、开源前必须做的事（WorkBuddy TODO）

### 1. 初始化 git（当前不是 git 仓库）
```bash
cd /Users/dfrobot/health-dashboard-tauri
git init
git add .
git commit -m "Initial commit: Health Dashboard Tauri"
```
`.gitignore` 已正确排除 `node_modules/ dist/ src-tauri/target/ src-tauri/gen/`，**无需额外处理**。

### 2. 补 LICENSE 文件
README 写了 MIT，但**仓库里没有 LICENSE 文件**。请补一个 `LICENSE`（MIT，版权人写 dfrobot），并在文件头加 SPDX。

### 3. 密钥审计（已确认安全，无泄露风险）
- 无任何硬编码密钥：`fetch_standalone.py` 只读 `~/.google-health-mcp/config.json`（用户机器本地，不进仓库）
- OAuth 凭据 / LLM key 都在用户机器 `~` 下，不在源码
- `settings.json` 在 `~/Library/Application Support/...`，不在仓库
- **唯一个人标识**：bundle id `com.arrhealth.healthdashboard`（出现在 main.rs 第 606/617 行、Info.plist）。开源可考虑改成通用 id（如 `com.example.healthdashboard` 或你自己的反向域名），不强制。

### 4. GitHub 仓库
- 已确认复用既有仓库 `ARRIIIIIS/google-health-dashboard`：Tauri 版作为 v1.0.0 直接更新到该仓库 main（旧 Web 版 v1.1.0 保留在 git 历史，随时可回溯）。
- 创建后：`git remote add origin <url> && git push -u origin main`
- 全局 git user.name/email 当前为空，提交前需 `git config user.name/email` 或加 `--author`。

### 5. 更新 README
README 还写着"显示屏幕多选""自定义刷新"等已被删除的功能（见 HANDOVER.md 第八/九节）。开源前按现状改写：
- 已删除：显示屏幕多选、窗口拖拽、自定义刷新间隔（仅 5/15/30 预设）、Google/LLM 输入框
- 已改为：Google / AI 配置走浏览器引导卡片（App.jsx 顶部 `GOOGLE_SETUP_URL` / `AI_SETUP_URL` 常量，默认指向 GitHub README）
- 位置固定 (24, 82) 对齐 macOS 小组件

### 6. 引导 URL 常量
`src/App.jsx` 顶部 `GOOGLE_SETUP_URL` / `AI_SETUP_URL` 默认指向 `https://github.com/ARRIIIIIS/google-health-dashboard`。新仓库建好后改成对应地址。

---

## 五、已知残留（不阻塞，可后续清理）
- `MenuStrings` 里 `screen_sub` / `refresh_custom` / `move_*` 三语言词条已成未使用字段（仅 warning）
- `set_win_position` 函数为 dead code（仅 warning）
- `collect_displays` / `list_displays` 命令前端不再调用但保留
- `display_ids` / `display` / google / llm 字段在 `Settings` struct 保留（兼容），仅删 UI

---

## 六、运行数据位置（用户机器，不进仓库）
- 数据：`~/Library/Application Support/com.arrhealth.healthdashboard/data.json`
- 设置：`~/Library/Application Support/com.arrhealth.healthdashboard/settings.json`
- 自启：`~/Library/LaunchAgents/com.arrhealth.healthdashboard.plist`
- OAuth：`~/.google-health-mcp/`
