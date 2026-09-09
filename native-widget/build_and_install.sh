#!/usr/bin/env bash
# 构建并安装原生健康桌面小组件到 /Applications
# 前置：Xcode 26+（提供 xcodebuild）、xcodegen（brew install xcodegen 或本机已有）
#
# 说明：本机 XcodeGen 2.46 的 `embed` 字段会被静默忽略（不会生成
# "Embed App Extensions" 阶段），所以本脚本在 xcodebuild 之后手动把
# .appex 拷进 .app/Contents/PlugIns/ 并重新签名，等价于正确的嵌入。
set -e -o pipefail

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export USER="${USER:-$(whoami)}"
export LOGNAME="${LOGNAME:-$(whoami)}"

# 定位 xcodegen（本机常见路径）
if ! command -v xcodegen >/dev/null 2>&1; then
  for p in "$HOME/.linuxbrew-mac/bin/xcodegen" "$HOME/.linuxbrew/bin/xcodegen" \
           /opt/homebrew/bin/xcodegen /usr/local/bin/xcodegen; do
    [ -x "$p" ] && { export PATH="$(dirname "$p"):$PATH"; break; }
  done
fi

cd "$(dirname "$0")"

echo ">>> xcodegen generate"
xcodegen generate

rm -rf /tmp/hdw-build

echo ">>> build extension"
xcodebuild -project HealthWidget.xcodeproj -scheme HealthWidgetExtension \
  -configuration Release -derivedDataPath /tmp/hdw-build build | tail -5
if [ ! -d /tmp/hdw-build/Build/Products/Release/HealthWidgetExtension.appex/Contents/MacOS ]; then
  echo "EXTENSION BUILD FAILED"; exit 1
fi

echo ">>> build app"
xcodebuild -project HealthWidget.xcodeproj -scheme HealthWidget \
  -configuration Release -derivedDataPath /tmp/hdw-build build | tail -5

APP=$(find /tmp/hdw-build -name HealthWidget.app -maxdepth 7 | head -1)
APEX=$(find /tmp/hdw-build -name HealthWidgetExtension.appex -maxdepth 7 | head -1)
echo "APP=$APP"
echo "APEX=$APEX"

echo ">>> embed .appex into .app/Contents/PlugIns"
mkdir -p "$APP/Contents/PlugIns"
cp -R "$APEX" "$APP/Contents/PlugIns/"

echo ">>> ad-hoc resign (本地运行足够；如需开发者证书把 - 换成证书名)"
codesign --force --deep --sign - "$APP"

echo ">>> install to /Applications"
rm -rf /Applications/HealthWidget.app
cp -R "$APP" /Applications/
ls /Applications/HealthWidget.app/Contents/PlugIns/

echo ">>> done. 去桌面右键「编辑小组件」搜索「健康」添加即可。"
