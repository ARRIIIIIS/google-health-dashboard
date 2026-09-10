#!/usr/bin/env bash
#
# 打一个「有安装画面」的 dmg：背景图 + 固定图标位置 + 隐藏工具栏 + 卷自定义图标。
#
# 和 `hdiutil create -srcfolder` 一把梭的区别：那个出来的 dmg 打开是一个空窗口，
# 图标位置随机、没有背景图。
#
# 用法：
#   scripts/build_dmg.sh [.app 路径] [输出 dmg 路径]
#
# 默认：
#   APP = /tmp/hd-rel/release/bundle/macos/Health Dashboard.app
#   OUT = <仓库根>/Health Dashboard_3.0.0_aarch64.dmg
#
# 为什么把 .DS_Store 当资产直接拷，而不是每次跑 AppleScript 让 Finder 现写：
#   Finder 写出来的坐标不可控（多屏、反复打开会被挪位置），而且在受限环境里
#   AppleScript 通道可能被系统直接拒绝。assets/dmg/DS_Store 是一次性用
#   Finder 调好、并逐字段验过的版本，直接复用最稳。
#
# 依赖：SetFile（Xcode CLT）。无需 Finder / osascript。
# 注意：会挂载/卸载卷，需要跳出沙箱执行。

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-/tmp/hd-rel/release/bundle/macos/Health Dashboard.app}"
OUT="${2:-$REPO/Health Dashboard_3.0.0_aarch64.dmg}"

VOLNAME="Health Dashboard"
ASSETS="$REPO/assets/dmg"
DSSTORE="$ASSETS/finder-layout.DS_Store"
BG="$ASSETS/background.png"
VOLICON="$REPO/src-tauri/icons/icon.icns"
PATCHER="$REPO/scripts/patch_dsstore.py"

RW=/tmp/hd-rw.dmg
SETFILE=/Library/Developer/CommandLineTools/usr/bin/SetFile
GETFILE=/Library/Developer/CommandLineTools/usr/bin/GetFileInfo
PY="${PYTHON:-python3}"

# 窗口 bounds：内容区 660×420 + 标题栏 28 → 高 448
BOUNDS="{{360, 160}, {660, 448}}"

for f in "$APP" "$DSSTORE" "$BG"; do
  [ -e "$f" ] || { echo "缺少: $f"; exit 1; }
done

echo "== 1/7 卸载同名卷 =="
for v in /Volumes/"$VOLNAME"*; do
  [ -d "$v" ] && hdiutil detach "$v" -force >/dev/null 2>&1 && echo "  已卸载 $v" || true
done
rm -f "$RW"

echo "== 2/7 建可写镜像 =="
# 用空白镜像 + 事后拷贝，而不是 -srcfolder：-srcfolder 对点开头文件的处理不稳，
# 而 .background / .VolumeIcon.icns / .DS_Store 恰恰全是点开头的。
hdiutil create -size 200m -fs HFS+ -volname "$VOLNAME" -ov "$RW" >/dev/null

echo "== 3/7 挂载 =="
MNT=$(hdiutil attach "$RW" -readwrite -noverify -noautoopen | grep -o '/Volumes/.*' | head -1)
echo "  $MNT"

echo "== 4/7 拷贝内容 =="
# ditto 而不是 cp -R：保留资源分支与扩展属性，否则 .app 的资源可能不完整
ditto "$APP" "$MNT/$(basename "$APP")"
ln -sfn /Applications "$MNT/Applications"
mkdir -p "$MNT/.background"
cp "$BG" "$MNT/.background/background.png"
cp "$DSSTORE" "$MNT/.DS_Store"

echo "== 5/7 卷图标 =="
cp "$VOLICON" "$MNT/.VolumeIcon.icns"
"$SETFILE" -a C "$MNT"
echo "  属性: $("$GETFILE" -a "$MNT")   (要看到大写 C)"

echo "== 6/7 坐实窗口与图标坐标 =="
# 顺带校验 DS_Store 资产没被改坏；坐标若被改动，这里会重新钉回目标值
"$PY" "$PATCHER" "$MNT" --bounds "$BOUNDS"

sync
sleep 1
hdiutil detach "$MNT" -force >/dev/null
echo "  已卸载"

echo "== 7/7 压缩 =="
rm -f "$OUT"
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$OUT" >/dev/null
ls -la "$OUT"
echo "DONE"
