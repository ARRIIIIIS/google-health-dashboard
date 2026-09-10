#!/usr/bin/env python3
"""确定性地改写 .DS_Store 的窗口位置与图标坐标。

Finder 的 AppleScript 通道在受限环境下可能被系统拒绝，或在多屏 / 多次打开后把窗口
坐标挪到别处。这个脚本直接改写 .DS_Store 二进制里的两个字段，与 Finder 是否配合无关：

  1. bwsp.WindowBounds  —— 窗口位置与尺寸（等长原地替换，不改文件长度）
  2. Iloc 记录          —— 每个条目的图标坐标（x, y 各 4 字节大端）

用法：
    patch_dsstore.py <卷挂载路径> [--bounds "{{500, 335}, {660, 516}}"]

坐标说明（macOS 26.6 实测标定）：
  - Iloc 坐标原点在**窗口内容区左上角**，y 向下；存的是图标**中心**。
    x 存 160 时图标中心落在内容区 x=165，即 app 侧有 +5 的固定内缩。
  - WindowBounds 是**左上角原点**的屏幕坐标（不是 Cocoa 的底部原点），
    存 (500, 335) 窗口顶边就落在 y=335。
  - WindowBounds 的高度 = 标题栏 + 工具栏 + 内容区 + 路径栏。实测：
    标题栏 28 + 工具栏 40 + 路径栏 28 = 96，所以内容区要 420 就得写 516。
    .DS_Store 里的 ShowToolbar / ShowPathbar 在本机不被 Finder 采纳，
    所以按「工具栏一定在」来配高度，再把背景图多画 68 点（488）兜住
    万一工具栏被隐藏时多出来的内容区。
"""

import argparse
import plistlib
import re
import sys
import io

# 条目名 -> 目标坐标。
#
# 坐标语义（实测标定，macOS 26.6）：
#   Iloc 的 x/y 原点在**内容区左上角**，保存的是图标**中心**的基准点，但 Finder 渲染时
#   会把整个图标网格右移一个固定量（实测 +34.8pt，两个图标一致、与取值无关，
#   与图标名最长的标签宽度有关，对本 app 是确定值）。所以这里按「设计值 - 35」写，
#   渲染出来中心正好落在 165 / 495，中线 330 正对背景图箭头。
#   y 无偏移（208 -> 207.8）。
#   隐藏项挪到内容区下方（y=560 在 488 高的内容区之外），这样即使用户在 Finder 里
#   开了「显示隐藏文件」也看不到它们。
GRID_NUDGE_X = 35

DEFAULT_LAYOUT = {
    "Health Dashboard.app": (165 - GRID_NUDGE_X, 208),
    "Applications": (495 - GRID_NUDGE_X, 208),
    ".background": (60, 560),
    ".fseventsd": (220, 560),
    ".VolumeIcon.icns": (380, 560),
}

# 内容区高度（背景图高 488，设计区占上面 420）；用于校验隐藏项是否真在视口外
CONTENT_H = 488


def die(msg):
    print("ERROR: " + msg, file=sys.stderr)
    raise SystemExit(1)


def patch_window_bounds(d, new_bounds):
    """等长替换 WindowBounds 字符串。长度不等就只能靠 Finder 重写，这里直接报错。

    注意：二进制 plist 里的字符串是裸 ASCII，不带 plist 语法那层引号，
    所以匹配 `{{x, y}, {w, h}}` 而不是 `"{{x, y}, {w, h}}"`。
    """
    pattern = rb"\{\{\d+, \d+\}, \{\d+, \d+\}\}"
    want = ("{{%d, %d}, {%d, %d}}" % new_bounds).encode()
    hits = 0
    for m in re.finditer(pattern, bytes(d)):
        old = m.group(0)
        if len(old) != len(want):
            die(
                "WindowBounds 长度不一致，无法原地替换：%r -> %r。"
                "请把 --bounds 调成与原值等长（或先用 Finder 改一次窗口尺寸）。" % (old, want)
            )
        d[m.start():m.start() + len(old)] = want
        hits += 1
    if hits == 0:
        die("没找到 WindowBounds，说明 .DS_Store 里还没有窗口信息（Finder 从未打开过该卷）。")
    return hits


def iter_iloc(d):
    for m in re.finditer(b"Iloc", bytes(d)):
        i = m.start()
        ln = int.from_bytes(d[i + 8:i + 12], "big")
        if ln != 16:
            continue
        back = bytes(d[max(0, i - 120):i]).decode("utf-16-be", errors="ignore")
        yield i, back


def patch_iloc(d, layout):
    done = {}
    for i, back in iter_iloc(d):
        for name, (x, y) in layout.items():
            if back.endswith(name):
                off = i + 12
                d[off:off + 4] = x.to_bytes(4, "big")
                d[off + 4:off + 8] = y.to_bytes(4, "big")
                done[name] = (x, y)
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("volume", help="卷挂载路径，例如 /Volumes/Health Dashboard")
    ap.add_argument(
        "--bounds",
        default="{{500, 335}, {660, 516}}",
        help="窗口 bounds，格式 '{{x, y}, {w, h}}'；h 含标题栏（内容区高 + 28）",
    )
    args = ap.parse_args()

    nums = [int(n) for n in re.findall(r"-?\d+", args.bounds)]
    if len(nums) != 4:
        die("--bounds 需要 4 个数字")

    path = args.volume.rstrip("/") + "/.DS_Store"
    try:
        d = bytearray(open(path, "rb").read())
    except FileNotFoundError:
        die("找不到 " + path + "，先用 Finder 打开一次该卷再运行。")

    hits = patch_window_bounds(d, tuple(nums))
    done = patch_iloc(d, DEFAULT_LAYOUT)

    missing = [n for n in DEFAULT_LAYOUT if n not in done]
    if missing:
        die("以下条目的 Iloc 记录没找到，无法定位：" + ", ".join(missing))

    open(path, "wb").write(bytes(d))

    print("WindowBounds 已改写（%d 处）: %s" % (hits, args.bounds))
    for name, (x, y) in done.items():
        tag = "视口外" if y > CONTENT_H else "可见"
        print("  %-24s (%4d, %4d)  %s" % (name, x, y, tag))
    print("完成，共 %d 字节" % len(d))


if __name__ == "__main__":
    main()
