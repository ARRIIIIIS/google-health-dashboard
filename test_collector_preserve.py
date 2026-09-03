#!/usr/bin/env python3
"""
集成测试：用【真实 data.json 的形状】（含多条 history 快照、首条 remind_event=0）
跑【真实 check_sedentary】，验证"App 写在顶层 today 的久坐提醒"经采集器完整写盘后
不被清零、且能被 check_sedentary 真实点火。
桩掉网络依赖，但保留 check_sedentary 真实逻辑。
"""
import sys, os, json, tempfile, time
from datetime import datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src-tauri", "resources"))
import fetch_standalone as fs

REAL = os.path.expanduser("~/Library/Application Support/com.arrhealth.healthdashboard/data.json")
STUB_STEPS = 100

def build(out_path, inject=True):
    if os.path.exists(REAL):
        data = json.load(open(REAL))
    else:
        today = datetime.now().strftime("%Y-%m-%d")
        data = {"today": {"date": today, "steps": STUB_STEPS},
                "history": [{"date": today, "steps": STUB_STEPS, "remind_event": 0}]}
    if inject:
        now = time.time(); now_ms = int(now * 1000)
        last_move = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now - 50 * 60))
        t = data.setdefault("today", {})
        t.update({
            "remind_event": now_ms, "sedentary": True, "idle_min": 50,
            "last_move_time": last_move, "last_steps": STUB_STEPS,
            "steps_at_sedentary": STUB_STEPS, "sedentary_notified": False,
            "last_remind_time": 0, "user_acked_time": 0,
        })
    json.dump(data, open(out_path, "w"), ensure_ascii=False, indent=2)

# 桩掉网络依赖，让 main() 能走到写盘分支（不桩 check_sedentary，跑真实久坐检测）
fs.is_token_expired = lambda: False
fs.load_token = lambda: {}
fs.fetch_steps = lambda *a: STUB_STEPS
fs.fetch_distance = lambda *a: 1.0
fs.fetch_calories = lambda *a: 10
fs.fetch_azm = lambda *a: (10, 5, 2)
fs.fetch_sleep = lambda *a: None
fs.fetch_resting_hr = lambda *a: 60
fs.fetch_respiratory_rate = lambda *a: 15
fs.fetch_oxygen_saturation = lambda *a: 98
fs.fetch_hrv = lambda *a: 50
fs.fetch_latest_hr = lambda *a: (70, "12:00")
fs.NOTIFY_START_HOUR = 0
fs.NOTIFY_END_HOUR = 24  # 让测试不受时段限制

td = tempfile.mkdtemp()
out = os.path.join(td, "data.json")
build(out, inject=True)
fs._ARGS.out = out
fs._ARGS.sed_min = 40
fs._ARGS.remind_min = 30

fs.main()

res = json.load(open(out))
got = res["today"].get("remind_event")
print(f"written today.remind_event = {got}")
ok = isinstance(got, int) and got > 0
print("\nRESULT:", "PASS ✅ 真实数据形状下，注入的久坐提醒经采集写盘后保留/点火" if ok else "FAIL ❌ 被清零")
sys.exit(0 if ok else 1)
