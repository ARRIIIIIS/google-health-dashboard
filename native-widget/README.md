# 健康 · 原生 macOS 小组件（WidgetKit）

把现有 Tauri 健康桌面组件的外观，做成 macOS 原生桌面小组件（出现在系统「小组件库」里）。
布局与配色 **1:1 还原** `App.jsx` 的 `Widget` 渲染 + `C_DARK` 调色板，直接读取
`~/Library/Application Support/com.arrhealth.healthdashboard/data.json`，无需改动现有 Tauri app。

## 还原了什么

| 区块 | 状态 |
| --- | --- |
| 三环 logo + 标题「健康」 | ✓ 完全一致 |
| 大号步数 + 距离/卡路里副行 + 活跃分钟 | ✓ 完全一致 |
| 步数进度条、四宫格（心率/HRV/血氧/呼吸） | ✓ 完全一致 |
| 睡眠分段条（深/REM/浅/醒）+ 深睡·REM 标注 | ✓ 完全一致 |
| 久坐 chip（已静坐 X 分钟，琥珀色态） | △ 仅静态显示，点不开弹窗 |
| AI tip | △ 显示本地兜底池（按分钟轮换），非实时 LLM 生成 |
| 情绪球（跟鼠标的实时画布） | ✗ 用静态心情字形替代 |
| 刷新按钮 | ✗ 装饰性，无操作（WidgetKit 刷新由系统调度） |

## 构建（两种方式任选）

### 方式 A：XcodeGen（推荐，一条命令）
```bash
brew install xcodegen
cd native-widget
xcodegen generate
open HealthWidget.xcodeproj
# 选 HealthWidget scheme → Run（或 Archive 后安装）
```

### 方式 B：Xcode 手动
1. Xcode → New → Project → macOS → App，Product Name `HealthWidget`，Interface SwiftUI，关闭「Core Data」。
2. File → New → Target → macOS → Widget Extension，名称 `HealthWidgetExtension`，**不要**勾选「Include Configuration Intent」。
3. 把本目录 `HealthWidget/` 与 `HealthWidgetExtension/` 下的 `.swift` 覆盖进对应 target（删掉 Xcode 自动生成的模板文件）。
4. 两个 target 的 Signing & Capabilities 里**删除 App Sandbox**（或把 entitlements 里的 `com.apple.security.app-sandbox` 设为 `false`）。
5. 两个 target 的 Deployment Target 设为 **macOS 13.0+**。
6. Run。

> 本机需 Xcode 15+（Swift 5.9，`homeDirectoryForCurrentUser` 需 macOS 13）。
> 我没有 Xcode 环境，无法替你编译验证，请在你本机构建。

## 数据流

- `Provider.loadData()` 直接读绝对路径
  `~/Library/Application Support/com.arrhealth.healthdashboard/data.json`。
- Tauri app 照常每 5 分钟写盘，**无需任何改动**。
- 若日后给 app/extension 开启沙盒，请改用 **App Group** 共享容器，让 Tauri app 把
  `data.json` 同时写到 `~/Library/Group Containers/<group>/`，组件从 Group 路径读取。

## 刷新频率（关键限制）

WidgetKit 的 Timeline 由系统统一调度，**不能按需即时刷新**。本工程在
`getTimeline` 里请求约 20 分钟后重载，但实际间隔由系统预算决定（通常 15–60 分钟）。
因此组件里看到的永远是「系统上次刷新时的快照」，不像 Tauri 组件那样想刷就刷。

若想让 Tauri app 在写完数据后主动推一次刷新，可在 Tauri 侧调用
`WidgetCenter.shared.reloadAllTimelines()`（需 import WidgetKit，且知道本组件 bundle id
`com.arrhealth.healthwidget.extension`）。此为可选增强，当前未接入。

## 安装到小组件库

运行一次宿主 App（`HealthWidget`）后，组件即出现在系统小组件库：
点击桌面空白处 → 右上角「编辑小组件」/ 菜单栏小组件按钮 → 找到「健康」→ 拖到桌面。

## 文件结构

```
native-widget/
├── project.yml                      # XcodeGen 工程描述
├── HealthWidget/                    # 宿主 App（容器，必须存在）
│   ├── HealthWidgetApp.swift
│   ├── ContentView.swift
│   ├── Info.plist
│   └── HealthWidget.entitlements    # 关闭沙盒
└── HealthWidgetExtension/           # WidgetKit 扩展
    ├── HealthWidgetBundle.swift      # @main WidgetBundle
    ├── Provider.swift                # 读 data.json + 时间线
    ├── HealthWidgetView.swift        # 1:1 还原的 SwiftUI 布局
    ├── Models.swift                  # data.json 的 Codable 模型
    ├── Info.plist
    └── HealthWidgetExtension.entitlements
```
