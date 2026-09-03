#!/usr/bin/env python3
# 验证 sed-pop 菜单栏弹窗：定位窗口 -> 按窗口ID截图 -> 像素分析确认内容渲染
import subprocess, sys
import Quartz
from PIL import Image
from collections import Counter

WID_PAT = 200  # 弹窗宽约 200
APP = "Health Dashboard"

def find_pop():
    wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID) or []
    for w in wl:
        if str(w.get(Quartz.kCGWindowOwnerName, "")) != APP:
            continue
        b = w.get(Quartz.kCGWindowBounds) or {}
        ww, hh = b.get("Width"), b.get("Height")
        if ww and abs(ww - 200) < 25 and hh and abs(hh - 92) < 25:
            return int(w.get(Quartz.kCGWindowNumber)), (ww, hh, b.get("X"), b.get("Y")), w.get(Quartz.kCGWindowIsOnscreen)
    return None, None, None

def main():
    wid, geo, onscreen = find_pop()
    if not wid:
        print("RESULT: NO_WINDOW  (弹窗未创建)")
        return 1
    ww, hh, x, y = geo
    print(f"RESULT: WINDOW  wid={wid}  {ww}x{hh} @({x},{y})  onscreen={onscreen}")
    png = "/tmp/hd_pop_capture.png"
    subprocess.run(["screencapture", "-l", str(wid), png], check=True)
    im = Image.open(png).convert("RGB")
    px = list(im.getdata())
    cnt = Counter(px)
    amber = sum(n for c, n in cnt.items() if abs(c[0]-255) < 45 and abs(c[1]-159) < 55 and abs(c[2]-10) < 70)
    dark = sum(n for c, n in cnt.items() if c[0] < 80 and c[1] < 70 and c[2] < 60)
    total = len(px)
    print(f"  amber像素(边框/文字): {amber} ({amber*100/total:.2f}%)")
    print(f"  dark像素(弹框底):     {dark} ({dark*100/total:.2f}%)")
    ok = amber > 50 and dark > total * 0.05
    print("RESULT: CONTENT_OK" if ok else "RESULT: CONTENT_MISSING")
    return 0 if ok else 2

if __name__ == "__main__":
    sys.exit(main())
