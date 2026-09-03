#!/usr/bin/env python3
"""回归测试：采集器写盘前必须保留 App 托管的交互字段，不能清零。"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src-tauri", "resources"))
import fetch_standalone as fs

def eq(label, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}: got={got!r} want={want!r}")
    return ok

all_ok = True

# 1) 本次 check_sedentary 已算出 remind_event → 优先用采集值
r = fs.preserve_app_fields(
    {"remind_event": 123, "user_acked_time": 55, "sedentary_notified": True},
    {"remind_event": 0, "user_acked_time": 0, "sedentary_notified": False},
)
all_ok &= eq("采集值优先(remind_event)", r["remind_event"], 123)
all_ok &= eq("采集值优先(user_acked_time)", r["user_acked_time"], 55)
all_ok &= eq("采集值优先(sedentary_notified)", r["sedentary_notified"], True)

# 2) 采集条目里没有该字段，但顶层 today 有（App/前端/脚本直接写入）→ 回退顶层旧值
r = fs.preserve_app_fields(
    {"sedentary_notified": False},                 # 仅含部分字段
    {"remind_event": 999, "user_acked_time": 77, "sedentary_notified": False},
)
all_ok &= eq("顶层旧值兜底(remind_event)", r["remind_event"], 999)
all_ok &= eq("顶层旧值兜底(user_acked_time)", r["user_acked_time"], 77)

# 3) 两边都没有 → 默认值（不报错、不丢键）
r = fs.preserve_app_fields({}, {})
all_ok &= eq("默认(remind_event)", r["remind_event"], 0)
all_ok &= eq("默认(sedentary_notified)", r["sedentary_notified"], False)
all_ok &= eq("默认(pending_notify)", r["pending_notify"], False)
all_ok &= eq("默认(last_move_time)", r["last_move_time"], "")
all_ok &= eq("默认(follow_up)", r["follow_up"], False)

# 4) 关键回归：测试脚本只写顶层 today.remind_event，history 条目无该字段时不能被清成 0
r = fs.preserve_app_fields(
    {"steps": 100, "last_steps": 100},            # history 条目（无 remind_event）
    {"remind_event": 1700000000000, "sedentary": True, "idle_min": 50},
)
all_ok &= eq("回归: 顶层 remind_event 不被清零", r["remind_event"], 1700000000000)

print("\n结果:", "ALL PASS ✅" if all_ok else "SOME FAILED ❌")
sys.exit(0 if all_ok else 1)
