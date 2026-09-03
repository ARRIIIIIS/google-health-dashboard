import json
import time
import os

DATA_PATH = "/Users/dfrobot/Library/Application Support/com.arrhealth.healthdashboard/data.json"

def inject_test_event():
    if not os.path.exists(DATA_PATH):
        print(f"❌ 错误: 未找到数据文件 {DATA_PATH}")
        return

    with open(DATA_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)

    t = data.setdefault("today", {})
    now = time.time()
    now_ms = int(now * 1000)
    # 巨大基线：让 check_sedentary 的「步数增加→重置久坐」分支（steps >= baseline + STEP_DELTA）
    # 永远不成立，无论真实 Google Fit 步数怎么涨都不会清零 remind_event / sedentary。
    # 这是先前测试失效的根因：旧注入用 last_steps=当前步数，而实时步数单调递增 → 被判定为「动了」→ 清零。
    HUGE = 9_999_999
    last_move = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now - 60 * 60))

    # 直接注入非零提醒事件（即便采集器因 token 过期跳过，文件里的非零值也会被前端读到）
    t["remind_event"] = now_ms
    t["sedentary"] = True
    t["idle_min"] = 60
    t["last_move_time"] = last_move      # 60 分钟前开始不动 → idle 远超阈值
    t["last_steps"] = HUGE               # 巨大基线，彻底防「步数增加」重置
    t["steps_at_sedentary"] = HUGE
    t["sedentary_notified"] = False
    t["last_remind_time"] = 0
    t["user_acked_time"] = 0

    with open(DATA_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"✅ 注入成功")
    print(f"   - remind_event: {now_ms}")
    print(f"   - sedentary: True, idle_min: 60, last_move: {last_move}, last_steps: {HUGE} (防重置)")
    print(f"\n👉 观察：Widget 软提醒（久坐计时下方胶囊）+ 菜单栏 Health 图标下方深色 Popover（最高层级）")

if __name__ == "__main__":
    inject_test_event()
