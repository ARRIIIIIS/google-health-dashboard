#!/usr/bin/env python3
"""确定性地改写 .DS_Store 的窗口位置与图标坐标。

Finder 的 AppleScript 通道在受限环境下可能被系统拒绝，或在多屏 / 多次打开后把窗口
坐标挪到别处。这个脚本直接改写 .DS_Store 二进制里的两个字段，与 Finder 是否配合无关：

  1. bwsp.WindowBounds  —— 窗口位置与尺寸（等长原地替换，不改文件长度）
  2. Iloc 记录          —— 每个条目的图标坐标（x, y 各 4 字节大端）

用法：
    patch_dsstore.py <卷挂载路径> [--bounds "{{360, 160}, {660, 448}}"]

坐标说明：Finder 的图标坐标原点在**窗口内容区左上角**，y 向下。
窗口的 WindowBounds 高度 = 内容区高度 + 标题栏高度（本机实测 28pt）。
"""

import argparse
import plistlib
import re
import sys
import io

# 条目名 -> 目标坐标。隐藏项挪到内容区下方（内容区高 420，y=560 完全在视口外），
# 这样即使用户在 Finder 里开了「显示隐藏文件」也看不到它们。
DEFAULT_LAYOUT = {
    "Health Dashboard.app": (165, 208),
    "Applications": (495, 208),
    ".background": (60, 560),
    ".fseventsd": (220, 560),
    ".VolumeIcon.icns": (380, 560),
}

# 窗口内容区之外的坐标才算「挪走」；用于校验
CONTENT_H = 420


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
        default="{{360, 160}, {660, 448}}",
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
