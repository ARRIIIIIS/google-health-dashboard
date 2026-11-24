#!/usr/bin/env bash
#
# 一键编译、清理重复副本并安装到 /Applications/Health Dashboard.app
# 彻底避免 macOS 出现两个同名 App 或两个后台进程：
# 1. 只构建 .app bundle
# 2. 先退出正在运行的旧进程
# 3. 从 LaunchServices 注销构建目录与临时目录中的 .app
# 4. 将构建产物 mv（移动而非复制）到 /Applications，保证全盘只有唯一一份 .app
# 5. 重新注册并启动唯一实例

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# 自动定位 arm64 node 与 cargo
if [ -d "$HOME/.nvm/versions/node/v26.9.0/bin" ]; then
  export PATH="$HOME/.nvm/versions/node/v26.9.0/bin:$PATH"
fi
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
BUILD_APP="$REPO/src-tauri/target/release/bundle/macos/Fitbit Air.app"
DEST_APP="/Applications/Fitbit Air.app"
OLD_APP="/Applications/Health Dashboard.app"

echo "== 1/4 编译打包 Fitbit Air.app =="
npm run tauri build -- --bundles app

echo "== 2/4 停止旧进程并清理重复注册 =="
killall -9 health-dashboard-tauri 2>/dev/null || true
sleep 1
"$LSREG" -u "$BUILD_APP" 2>/dev/null || true
if [ -d "$OLD_APP" ]; then
  "$LSREG" -u "$OLD_APP" 2>/dev/null || true
  rm -rf "$OLD_APP"
fi
rm -rf "/tmp/hd-rel" "/tmp/hd-dmg-mnt" 2>/dev/null || true

echo "== 3/4 移动安装到 ${DEST_APP}（不留构建目录副本）=="
rm -rf "$DEST_APP"
mv "$BUILD_APP" "$DEST_APP"
"$LSREG" -f "$DEST_APP" 2>/dev/null || true

echo "== 4/4 启动唯一实例 =="
open "$DEST_APP"
sleep 1
ps aux | grep -i "health-dashboard-tauri" | grep -v grep || true
echo "✅ 安装完成，全盘唯一路径：$DEST_APP"
