#!/usr/bin/env python3
"""
Google Health API 数据采集脚本
使用 curl 直连，绕过 MCP 层
API 文档：https://developers.google.com/health/android/reference/rest/v4
"""
import json, subprocess, sys, re, time, urllib.parse, random, os, shutil
from datetime import datetime, timedelta

def _detect_proxy():
    """本地代理(7890)活着就走代理，否则直连。避免代理软件没开时全挂。"""
    import socket
    try:
        socket.create_connection(("127.0.0.1", 7890), timeout=1).close()
        return ["--proxy", "http://127.0.0.1:7890"]
    except Exception:
        return []

PROXY_ARGS = _detect_proxy()
TOKEN_FILE = "/Users/dfrobot/.google-health-mcp/tokens.json"
CONFIG_FILE = "/Users/dfrobot/.google-health-mcp/config.json"
DATA_FILE = "/Users/dfrobot/google-health-dashboard/data.js"

# ─── Token 管理 ────────────────────────────────────────────────────────────────

def load_token():
    td = json.load(open(TOKEN_FILE))
    if td.get("expires_at", 0) - int(time.time()) < 60:
        log("token 快过期，刷新中...")
        new_tok = refresh_access_token()
        if not new_tok:
            log("⚠️  token 刷新失败，沿用旧 token")
        else:
            td = json.load(open(TOKEN_FILE))
    return td["access_token"]

def refresh_access_token():
    """用 refresh_token 换新 access_token，写回 tokens.json。返回新 token 或 None。"""
    try:
        cfg   = json.load(open(CONFIG_FILE))
        td    = json.load(open(TOKEN_FILE))
    except Exception as e:
        log(f"❌ 读取 OAuth 配置失败: {e}")
        return None
    body = urllib.parse.urlencode({
        "client_id":     cfg["GOOGLE_HEALTH_CLIENT_ID"],
        "client_secret": cfg["GOOGLE_HEALTH_CLIENT_SECRET"],
        "refresh_token": td.get("refresh_token", ""),
        "grant_type":    "refresh_token",
    })
    r = subprocess.run(
        ["curl", "-s", *PROXY_ARGS, "--max-time", "30", "-X", "POST",
         "https://oauth2.googleapis.com/token", "-d", body],
        capture_output=True, text=True
    )
    try:
        tok = json.loads(r.stdout)
        if "access_token" not in tok:
            log(f"❌ token 刷新返回异常: {str(tok)[:200]}")
            return None
        td["access_token"] = tok["access_token"]
        td["expires_in"]  = int(tok.get("expires_in", 3600))
        td["expires_at"]  = int(time.time()) + td["expires_in"]
        with open(TOKEN_FILE, "w") as f:
            json.dump(td, f, indent=2, ensure_ascii=False)
        log(f"✅ token 已刷新 (有效期 {td['expires_in']}s)")
        return tok["access_token"]
    except Exception as e:
        log(f"❌ token 刷新失败: {e} | {r.stdout[:150]}")
        return None

# ─── API 工具 ─────────────────────────────────────────────────────────────────

def _curl_json(cmd):
    """执行 curl 并解析 JSON，带重试。遇空响应/超时/解析失败重试最多 3 次。"""
    for attempt in range(1, 4):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
            out = r.stdout.strip()
            if not out:
                log(f"  ⚠️ API 空响应 (第{attempt}次)，重试...")
                time.sleep(2)
                continue
            return json.loads(out)
        except subprocess.TimeoutExpired:
            log(f"  ⚠️ API 超时 (第{attempt}次)，重试...")
            time.sleep(2)
        except Exception as e:
            log(f"  ⚠️ API 解析失败 (第{attempt}次): {e}，重试...")
            time.sleep(2)
    return {}

def api_get(path):
    return _curl_json([
        "curl", "-s", *PROXY_ARGS, "--max-time", "30",
        "-H", f"Authorization: Bearer {TOKEN}",
        f"https://health.googleapis.com/v4/{path}"
    ])

def api_post(dtype, body):
    """POST to dailyRollUp 接口（v4，无 dataTypeName）"""
    return _curl_json([
        "curl", "-s", *PROXY_ARGS, "--max-time", "30",
        "-H", f"Authorization: Bearer {TOKEN}",
        "-H", "Content-Type: application/json",
        "-X", "POST",
        f"https://health.googleapis.com/v4/users/me/dataTypes/{dtype}/dataPoints:dailyRollUp",
        "-d", json.dumps(body)
    ])

def make_range(date_str):
    """生成 civilDateRange body（v4 格式，仅 date 字段）"""
    y, m, d = map(int, date_str.split("-"))
    nxt = (datetime(y, m, d) + timedelta(days=1)).strftime("%Y-%m-%d").split("-")
    ny, nm, nd = map(int, nxt)
    return {
        "range": {
            "start": {"date": {"year": y, "month": m, "day": d}},
            "end":   {"date": {"year": ny, "month": nm, "day": nd}}
        }
    }

def cst(ts_utc, offset_str="28800s"):
    offset_s = int(re.sub(r"\D", "", offset_str) or "28800")
    dt = datetime.fromisoformat(ts_utc.replace("Z", "+00:00")) + timedelta(seconds=offset_s)
    return dt.strftime("%H:%M"), dt

# ─── 数据获取函数 ─────────────────────────────────────────────────────────────

def fetch_steps(today):
    body = make_range(today)
    d = api_post("steps", body)
    rdp = (d.get("rollupDataPoints") or [{}])[0]
    steps_val = int(rdp.get("steps", {}).get("countSum", 0))
    if steps_val == 0:
        log(f"  ⚠️ steps=0，可能是数据同步延迟或无数据")
    return steps_val

def fetch_distance(today):
    body = make_range(today)
    d = api_post("distance", body)
    rdp = (d.get("rollupDataPoints") or [{}])[0]
    return round(int(rdp.get("distance", {}).get("millimetersSum", 0)) / 1_000_000, 2)

def fetch_calories(today):
    body = make_range(today)
    d = api_post("total-calories", body)
    rdp = (d.get("rollupDataPoints") or [{}])[0]
    return int(rdp.get("totalCalories", {}).get("kcalSum", 0))

def fetch_azm(today):
    body = make_range(today)
    d = api_post("active-zone-minutes", body)
    rdp = (d.get("rollupDataPoints") or [{}])[0].get("activeZoneMinutes", {})
    fat  = int(rdp.get("sumInFatBurnHeartZone", 0))
    card = int(rdp.get("sumInCardioHeartZone", 0))
    peak = int(rdp.get("sumInPeakHeartZone", 0))
    return fat, card, peak

def fetch_sleep():
    """取最新一条夜间睡眠（STAGES 类型）"""
    d = api_get("users/me/dataTypes/sleep/dataPoints:reconcile?pageSize=10")
    for p in d.get("dataPoints", []):
        sl = p.get("sleep", {})
        if sl.get("type") != "STAGES":
            continue
        iv     = sl.get("interval", {})
        offset = int(re.sub(r"\D", "", iv.get("startUtcOffset", "28800s")) or "28800")
        st_raw = datetime.fromisoformat(iv.get("startTime", "").replace("Z", "+00:00"))
        en_raw = datetime.fromisoformat(iv.get("endTime",   "").replace("Z", "+00:00"))
        st_local = st_raw + timedelta(seconds=offset)
        en_local = en_raw + timedelta(seconds=offset)
        total_min = int((en_local - st_local).total_seconds() / 60)
        deep = rem = light = awake = 0
        for stage in sl.get("stages", []):
            off2 = int(re.sub(r"\D", "", stage.get("startUtcOffset", "28800s")) or "28800")
            st2  = datetime.fromisoformat(stage["startTime"].replace("Z","+00:00")) + timedelta(seconds=off2)
            en2  = datetime.fromisoformat(stage["endTime"].replace("Z","+00:00"))   + timedelta(seconds=off2)
            mins = int((en2 - st2).total_seconds() / 60)
            t = stage["type"]
            if   t == "DEEP":   deep  += mins
            elif t == "REM":    rem   += mins
            elif t == "LIGHT": light += mins
            elif t == "AWAKE": awake += mins
        return {
            "bedtime": st_local.strftime("%H:%M"),
            "wakeup":  en_local.strftime("%H:%M"),
            "total":   total_min,
            "deep":    deep,
            "rem":     rem,
            "light":   light,
            "awake":   awake,
        }
    return None

# ─── 新增指标（GET reconcile）────────────────────────────────────────────────

def fetch_daily_metric(dtype, today):
    """
    从 GET reconcile 端点取每日汇总指标。
    dtype: daily-resting-heart-rate | daily-respiratory-rate |
           daily-oxygen-saturation | daily-heart-rate-variability
    返回今日值（如今日无数据则取最新可用日）
    """
    ty, tm, td = map(int, today.split("-"))
    d = api_get(f"users/me/dataTypes/{dtype}/dataPoints:reconcile?pageSize=5")
    for p in d.get("dataPoints", []):
        # 统一取 date 字段：所有 daily-* 类型都返回 {year, month, day}
        if dtype == "daily-resting-heart-rate":
            v = p.get("dailyRestingHeartRate", {})
        elif dtype == "daily-respiratory-rate":
            v = p.get("dailyRespiratoryRate", {})
        elif dtype == "daily-oxygen-saturation":
            v = p.get("dailyOxygenSaturation", {})
        elif dtype == "daily-heart-rate-variability":
            v = p.get("dailyHeartRateVariability", {})
        else:
            v = {}
        date_obj = v.get("date", {})
        if date_obj.get("year") == ty and date_obj.get("month") == tm and date_obj.get("day") == td:
            if dtype == "daily-resting-heart-rate":
                return float(v.get("beatsPerMinute", 0))
            elif dtype == "daily-respiratory-rate":
                return round(v.get("breathsPerMinute", 0), 1)
            elif dtype == "daily-oxygen-saturation":
                return round(v.get("averagePercentage", 0), 1)
            elif dtype == "daily-heart-rate-variability":
                return round(v.get("averageHeartRateVariabilityMilliseconds", 0), 1)
    return None

def fetch_resting_hr(today):
    v = fetch_daily_metric("daily-resting-heart-rate", today)
    return v

def fetch_respiratory_rate(today):
    v = fetch_daily_metric("daily-respiratory-rate", today)
    return v

def fetch_oxygen_saturation(today):
    v = fetch_daily_metric("daily-oxygen-saturation", today)
    return v

def fetch_hrv(today):
    v = fetch_daily_metric("daily-heart-rate-variability", today)
    return v

# ─── 提示语生成 ───────────────────────────────────────────────────────────────

def load_history():
    """从 data.js 读取历史记录（存在 HEALTH_DATA.history）"""
    try:
        raw = open(DATA_FILE).read()
        clean = raw.replace("const HEALTH_DATA = ", "").strip().rstrip(";")
        d = json.loads(clean)
        return d.get("history", [])
    except:
        return []

def load_current_today():
    """读取 data.js 中当前的 today 数据（供防清零保护对比）"""
    try:
        raw = open(DATA_FILE).read()
        clean = raw.replace("const HEALTH_DATA = ", "").strip().rstrip(";")
        d = json.loads(clean)
        return d.get("today", {})
    except:
        return {}

# ─── 久坐检测参数 ──────────────────────────────────────────────────────────────
SEDENTARY_MIN = 45        # 连续不动超过此时长(分钟)则提醒
VERIFY_AFTER_MS = 3 * 60 * 1000  # 用户点击后 3 分钟核验步数
STEP_DELTA    = 80        # 步数增加超过此值算"有活动"，重置基线
NOTIFY_START_HOUR = 10     # 仅在工作时段发通知(这台 Mac 10:00–19:00 使用)
NOTIFY_END_HOUR   = 19

# 久坐通知文案池（拟人化/风趣，每次随机抽一条，只提静坐时长）
SEDENTARY_MSGS = [
    "你已经坐着发呆 {m} 分钟了，椅子都要长你身上了，起来晃晃？🪑",
    "警报！检测到人类已静止 {m} 分钟，本助理怀疑你被封印了，快解开！🧙",
    "我盯着你看了 {m} 分钟，你一动没动……是在跟我玩木头人吗？🌳",
    "你的屁股和椅子已经谈了 {m} 分钟恋爱，该分手让它们透透气了 💔",
    "{m} 分钟没见你挪窝，血液都要罢工了，走两步呗 🩸",
    "静坐 {m} 分钟达成！奖励是更硬的腰和更僵的脖子，起来领罚？😏",
    "本健康监测员已记录你静坐 {m} 分钟，再不活动我要去告状了 👮",
    "你这 {m} 分钟稳如泰山，连呼吸都规律得可疑，起来诈个尸吧 🧟",
    "检测到坐姿锁定 {m} 分钟，系统建议：站起来，帅/美给它看 👀",
    "{m} 分钟前我就喊你动了，你装没听见是吧？再不来我自个儿去散步了 🚶",
]


# alerter：真正的 macOS 通知横幅 + 按钮（非模态）。缺失时降级为纯横幅。
ALERTER_BIN = shutil.which("alerter") or "/usr/local/bin/alerter"


def send_notification(steps, idle_min):
    """弹出交互式久坐提醒（横幅 + 按钮），按选择更新状态。非阻塞。"""
    try:
        if os.path.exists(ALERTER_BIN):
            # 独立进程跑 alerter，避免阻塞采集流程；点击结果由 run_alerter_mode 写回
            subprocess.Popen(
                [sys.executable, __file__, "--alerter", str(idle_min)],
                start_new_session=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        else:
            # 降级：纯横幅（无按钮），不弹模态窗
            msg = random.choice(SEDENTARY_MSGS).format(m=idle_min)
            scpt = (f'display notification "{msg}" '
                    f'with title "健康提醒" subtitle "久坐检测" sound name "Glass"')
            subprocess.run(["osascript", "-e", scpt], check=False, timeout=10)
        log(f"  🔔 已弹出久坐提醒 (idle≈{idle_min}min)")
    except Exception as e:
        log(f"  ⚠️ 提醒弹窗失败: {e}")


def run_alerter_mode(idle_min):
    """用 alerter 弹横幅 + 按钮，解析点击结果，写回 data.js 状态。"""
    msg = random.choice(SEDENTARY_MSGS).format(m=idle_min).replace('"', "'")
    choice = "稍后"
    try:
        proc = subprocess.run(
            [ALERTER_BIN, "--message", msg,
             "--title", "健康提醒", "--subtitle", "久坐检测",
             "--actions", "稍后,现在起来", "--close-label", "稍后",
             "--sound", "Glass", "--timeout", "600", "--json"],
            capture_output=True, text=True, timeout=620,
        )
        out = proc.stdout.strip()
        if out:
            res = json.loads(out)
            if res.get("activationType") == "actionClicked" and res.get("action"):
                choice = res["action"]
            else:
                choice = "稍后"   # timeout / closed → 稍后
    except Exception:
        choice = "稍后"
    apply_choice(choice)


def apply_choice(choice):
    """
    把用户选择（现在起来 / 稍后）写回 data.js。
    两种选择统一行为：设置 3 分钟核验时间戳。
    3 分钟后 check_sedentary 会对比步数是否增加，决定是否继续提醒。
    """
    try:
        raw = open(DATA_FILE).read()
        d = json.loads(raw.replace("const HEALTH_DATA = ", "").strip().rstrip(";"))
        now = datetime.now()
        tid = d["today"]["date"]
        verify_time = int(now.timestamp() * 1000) + VERIFY_AFTER_MS
        steps_now = d["today"].get("steps", 0)

        for h in d.get("history", []):
            if h.get("date") == tid:
                h["verify_after_time"] = verify_time
                h["verify_baseline_steps"] = steps_now
                h["follow_up"] = True
                h["snooze_until"] = 0
                h["pending_notify"] = False
                h["sedentary_notified"] = True
                break

        d["today"]["verify_after_time"] = verify_time
        d["today"]["verify_baseline_steps"] = steps_now
        d["today"]["follow_up"] = True
        d["today"]["snooze_until"] = 0
        d["today"]["pending_notify"] = False
        d["today"]["sedentary_notified"] = True
        d["today"]["sedentary"] = True
        open(DATA_FILE, "w").write("const HEALTH_DATA = " + json.dumps(d, ensure_ascii=False, indent=2) + ";\n")
        log(f"  💬 用户点击「{choice}」，{VERIFY_AFTER_MS//60000}分钟后核验步数（基准={steps_now}）")
    except Exception as e:
        log(f"  ⚠️ 选择状态更新失败: {e}")


def check_sedentary(today_entry, steps, now):
    """
    久坐检测 + 自适应提醒：
    - 跟踪最近一次明显活动的时间，超过 SEDENTARY_MIN 未活动则标记久坐。
    - 首次提醒后进入 follow_up（5 分钟复查）模式：服务器据此缩短采集间隔。
    - 复查时若仍无变动 → 再次提醒（保持 5 分钟模式）；若有变动 → 退出 follow_up（恢复 10 分钟）。
    - 「稍后」会把 snooze_until 设为未来时刻，期间不重复提醒，到期再评估。
    - pending_notify 防止弹窗未关闭前被 5 分钟复查重复弹出。
    - verify_after：用户点击后 3 分钟核验步数，未增加则继续提醒。
    返回 (sedentary, idle_min, reminded_this_run)
    """
    last_move_time = today_entry.get("last_move_time")
    last_steps_rec = today_entry.get("last_steps", 0)
    follow_up = today_entry.get("follow_up", False)
    verify_after_time = today_entry.get("verify_after_time", 0)
    verify_baseline = today_entry.get("verify_baseline_steps", 0)

    # ── 核验模式：3 分钟后对比步数 ──────────────────────────────
    if verify_after_time and time.time() * 1000 >= verify_after_time:
        today_entry["verify_after_time"] = 0   # 清除核验时间
        if steps >= verify_baseline + STEP_DELTA:
            # ✅ 步数真的增加了：更新活动基线，退出久坐
            today_entry["last_move_time"] = now.strftime("%Y-%m-%d %H:%M:%S")
            today_entry["last_steps"] = steps
            today_entry["sedentary_notified"] = False
            today_entry["follow_up"] = False
            today_entry["snooze_until"] = 0
            today_entry["pending_notify"] = False
            log(f"  ✅ 核验通过：步数从 {verify_baseline} → {steps}，解除久坐提醒")
            return False, 0, False
        else:
            # ❌ 步数未增加：重新触发提醒（视为 follow_up 继续）
            log(f"  ❌ 核验失败：步数未增加（{verify_baseline} → {steps}），继续提醒")
            today_entry["sedentary_notified"] = False   # 允许再次弹窗
            follow_up = True

    # 首次运行：初始化活动基线
    if not last_move_time:
        today_entry["last_move_time"] = now.strftime("%Y-%m-%d %H:%M:%S")
        today_entry["last_steps"] = steps
        today_entry["sedentary_notified"] = False
        today_entry["follow_up"] = False
        today_entry["snooze_until"] = 0
        today_entry["pending_notify"] = False
        today_entry["verify_after_time"] = 0
        return False, 0, False

    # 步数明显增加时，更新活动基线并清除 follow_up / snooze / pending
    if steps >= last_steps_rec + STEP_DELTA:
        today_entry["last_move_time"] = now.strftime("%Y-%m-%d %H:%M:%S")
        today_entry["last_steps"] = steps
        today_entry["sedentary_notified"] = False
        today_entry["follow_up"] = False
        today_entry["snooze_until"] = 0
        today_entry["pending_notify"] = False
        today_entry["verify_after_time"] = 0
        return False, 0, False

    idle_min = int((now - datetime.strptime(last_move_time, "%Y-%m-%d %H:%M:%S")).total_seconds() // 60)
    if idle_min < SEDENTARY_MIN:
        today_entry["follow_up"] = False
        today_entry["snooze_until"] = 0
        today_entry["pending_notify"] = False
        today_entry["verify_after_time"] = 0
        return False, idle_min, False

    # 已达久坐阈值；先看「稍后」snooze 是否仍生效
    snooze_until = today_entry.get("snooze_until", 0)
    if snooze_until and time.time() * 1000 < snooze_until:
        # 稍后模式生效中：暂不提醒，保持状态等 snooze 到期
        return True, idle_min, False

    # 触发提醒（本周期首次 或 follow_up 复查，且弹窗未挂起）
    in_window = NOTIFY_START_HOUR <= now.hour < NOTIFY_END_HOUR
    reminded = False
    if in_window and (not today_entry.get("sedentary_notified") or follow_up) and not today_entry.get("pending_notify"):
        reminded = True
        today_entry["sedentary_notified"] = True
    today_entry["follow_up"] = True   # 进入/保持 5 分钟复查模式
    return True, idle_min, reminded

# 时段问候语（按 update_seq 轮换，避免每次同一句）
TIME_GREET = {
    "morning":   ["早安，新的一天从活动开始 ☀️", "早上好，今天也加油 💪", "晨光正好，动起来吧 🌅"],
    "noon":      ["午间散步，助消化也提神 🚶", "午饭后来点活动吧 🍱", "午后黄金时间，起身走走 ☀️"],
    "afternoon": ["下午茶时间，顺便拉伸 🍵", "工作间隙，给身体充个电 ⚡", "稍显倦怠？站起来活动 💡"],
    "evening":   ["傍晚放松，今日达标了吗？🌆", "一天将尽，回顾下步数 🌇", "晚间散步，助眠又舒心 🚶"],
    "night":     ["夜深了，准备休息 🌙", "该给身体充电了，早点睡 💤", "深夜时段，降低亮度护眼 📱"],
}
GOOD_MSGS = [
    "各项指标平稳，保持就好 👍",
    "今天状态不错，继续 🌟",
    "身体数据正常，棒 ✨",
]

def generate_insight(steps, sleep_total, deep, rem, resting_hr, hrv, spo2, resp, azm, yesterday, hour=None):
    if hour is None:
        hour = datetime.now().hour
    """
    生成一句简洁的自然语言健康洞察（助理风格）。
    以「今天 vs 昨天」为主轴，结合时段上下文，2–3 句内说完。
    不堆砌数据，关注值得说的变化。
    """
    hour = datetime.now().hour
    is_morning = hour < 11
    is_evening = hour >= 18
    insights = []
    alert = None

    y = yesterday or {}

    # ── 睡眠（总量变化优先，再看质量细分）──仅上午提醒，下午不显示
    y_sleep = y.get("sleep_asleep_min", 0) or 0
    y_deep  = y.get("sleep_deep_min", 0) or 0
    y_rem   = y.get("sleep_rem_min", 0) or 0
    if sleep_total and hour < 12:
        diff = sleep_total - y_sleep
        if diff <= -30:
            insights.append(f"睡眠比昨天少{abs(diff)}分钟，今晚早睡")
        elif diff >= 30:
            insights.append(f"睡眠充足，{sleep_total}min")
        if deep and y_deep and (deep - y_deep) <= -15:
            insights.append("深睡偏少")
        elif deep and y_deep and (deep - y_deep) >= 20:
            insights.append("深睡质量好")

    # ── 步数（下午/晚比变化趋势；上午只提示活跃时间）──
    y_steps = y.get("steps", 0) or 0
    azm_total = (azm[0] + azm[1] + azm[2]) if azm else 0
    if is_morning:
        # 上午不对比绝对量（10点归零，yesterday是全天总量，时间尺度不同）
        # 只看活跃时间
        if azm_total and azm_total >= 20:
            insights.append(f"活跃时间充足，继续保持")
        elif azm_total and azm_total < 10:
            insights.append("还没怎么动，起身走走")
    else:
        step_diff_pct = (steps - y_steps) / max(y_steps, 1) * 100
        if step_diff_pct < -20:
            insights.append("今天比昨天安静")
        elif step_diff_pct > 20:
            insights.append("今天比昨天活跃")
        elif azm_total and azm_total < 20 and steps < 5000:
            insights.append("有效活动偏少，建议动一动")

    # ── 呼吸率（结合时段解读）──
    y_resp = y.get("respiratory_rate", 0) or 0
    if resp and y_resp:
        delta = resp - y_resp
        if is_morning:
            if delta > 3:
                insights.append(f"刚醒呼吸偏快({resp}/min)，正常激活现象")
            elif delta < -3:
                insights.append(f"晨间呼吸平稳({resp}/min)")
        elif delta > 3:
            insights.append(f"呼吸比昨天快{round(delta)}次，关注")
        elif delta < -3 and not is_morning:
            insights.append(f"呼吸较稳({resp}/min)")

    # ── 心率 & HRV（联合解读）──
    y_hrv  = y.get("hrv", 0) or 0
    y_rhr  = y.get("resting_hr", 0) or 0
    if hrv and y_hrv:
        hrv_delta = hrv - y_hrv
        rhr_delta = (resting_hr - y_rhr) if (resting_hr and y_rhr) else 0
        if hrv_delta < -8 and rhr_delta > 5:
            insights.append("HRV降、心率升，可能疲劳")
        elif hrv_delta < -8:
            insights.append("HRV下降，神经系统偏疲劳")
        elif hrv_delta > 8 and rhr_delta < -3:
            insights.append("状态不错，心率稳、HRV高")

    # ── 血氧（直接告警，不进 insights）──
    if spo2 and spo2 < 94:
        alert = f"血氧{spo2}%，偏低"
    elif spo2 and spo2 < 95:
        insights.append(f"血氧{spo2}%，略低")

    # ── 综合评级 ──
    if alert:
        return alert, "alert"
    if insights:
        return "，".join(insights[:2]), "good"
    return None, "good"


def generate_tip(steps, azm, sleep_total, deep, rem, resting_hr, hrv, spo2, resp, yesterday, update_seq, sedentary=False):
    """
    生成小组件提示文本。
    核心：generate_insight() 给出自然语言洞察，阈值告警兜底。
    """
    hour = datetime.now().hour
    if   5 <= hour < 11: blk = "morning"
    elif 11 <= hour < 14: blk = "noon"
    elif 14 <= hour < 18: blk = "afternoon"
    elif 18 <= hour < 22: blk = "evening"
    else:                  blk = "night"
    greet = TIME_GREET[blk][update_seq % len(TIME_GREET[blk])]

    insight, insight_level = generate_insight(
        steps, sleep_total, deep, rem,
        resting_hr, hrv, spo2, resp, azm, yesterday, hour=hour
    )

    # 硬阈值告警（仅真正需要立即处理的红线，不包括步数/活动量——由洞察层解读）
    warnings = []
    azm_total = (azm[0] + azm[1] + azm[2]) if azm else 0
    if azm_total == 0 and hour >= 16:
        warnings.append(("warn", "今日尚无有效活动"))
    if sleep_total and sleep_total < 300:
        warnings.append(("alert", "睡眠严重不足(<5h)，注意休息"))
    if spo2 and spo2 < 92:
        warnings.append(("alert", f"血氧{spo2}%，偏低"))
    elif spo2 and spo2 < 95:
        warnings.append(("warn", f"血氧{spo2}%，略低"))
    if resting_hr and resting_hr > 85:
        warnings.append(("alert", "静息心率持续偏高，建议就医"))
    if hrv and hrv < 20:
        warnings.append(("warn", "HRV 明显偏低，可能过度疲劳"))
    if sedentary:
        warnings.append(("warn", "已久坐一段时间，建议起身活动 🚶"))

    if warnings:
        warnings.sort(key=lambda w: 0 if w[0] == "alert" else 1)
        level, wtxt = warnings[0]
        return f"{greet} {wtxt}", level

    if insight:
        return f"{greet} {insight}", insight_level
    return f"{greet} {GOOD_MSGS[update_seq % len(GOOD_MSGS)]}", "good"

# ─── 日志 / 主流程 ────────────────────────────────────────────────────────────

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def main():
    global TOKEN
    TOKEN = load_token()

    today = datetime.now().strftime("%Y-%m-%d")
    log(f"开始采集 {today}...")

    # 每日汇总（dailyRollUp）
    steps     = fetch_steps(today)
    distance  = fetch_distance(today)
    calories  = fetch_calories(today)
    azm       = fetch_azm(today)
    azm_str   = f"{sum(azm)}min(脂{azm[0]}/心{azm[1]}/峰{azm[2]})"
    log(f"  步数: {steps} | 距离: {distance}km | 卡路里: {calories} | 活动: {azm_str}")

    # 睡眠
    sleep = fetch_sleep()
    sl_str = (f"睡眠{int(sleep['total'])}min(深{sleep['deep']}/REM{sleep['rem']}/浅{sleep['light']}/清醒{sleep['awake']}) "
              f"入睡{sleep['bedtime']}→{sleep['wakeup']}") if sleep else "无睡眠数据"
    log(f"  {sl_str}")

    # 每日指标（GET reconcile）
    resting_hr  = fetch_resting_hr(today)
    resp        = fetch_respiratory_rate(today)
    spo2        = fetch_oxygen_saturation(today)
    hrv         = fetch_hrv(today)
    log(f"  静息HR: {resting_hr} | 呼吸: {resp} | SpO2: {spo2} | HRV: {hrv}")

    # ── 历史记录（用于变化对比）──
    history = load_history()
    today_entry = next((h for h in history if h.get("date") == today), None)
    if today_entry:
        today_entry["update_count"] = today_entry.get("update_count", 0) + 1
    else:
        today_entry = {"date": today, "update_count": 0}
        history.append(today_entry)
    # 只保留最近 7 天
    history = [h for h in history if h.get("date")][-7:]
    update_seq = today_entry["update_count"]
    yesterday = next((h for h in reversed(history) if h.get("date") != today), None)
    if yesterday:
        log(f"  昨日对比: steps={yesterday.get('steps')} sleep={yesterday.get('sleep_asleep_min')} hrv={yesterday.get('hrv')}")

    # ── 久坐检测 ──
    now = datetime.now()
    sedentary, idle_min, reminded = check_sedentary(today_entry, steps, now)
    if sedentary:
        log(f"  ⏱️ 久坐检测: idle≈{idle_min}min, reminded={reminded}, follow_up={today_entry.get('follow_up')}")
    if reminded:
        today_entry["pending_notify"] = True
        send_notification(steps, idle_min)   # 写盘后弹交互窗

    # 生成提示
    tip, tip_level = generate_tip(
        steps, azm,
        (sleep["total"] - sleep["awake"]) if sleep else 0,
        sleep["deep"]  if sleep else 0,
        sleep["rem"]   if sleep else 0,
        resting_hr, hrv, spo2, resp,
        yesterday, update_seq, sedentary
    )
    log(f"  tip: {tip} [{tip_level}] (seq={update_seq}, sedentary={sedentary})")

    # 写入 data.js
    # 写入 data.js（data-server.js 期望格式：const HEALTH_DATA = { today: {...} }）
    today_data = {
        "date":      today,
        "updated_at": datetime.now().strftime("%H:%M"),
        "steps":     steps,
        "distance":  distance,
        "calories":  calories,
        "azm_fat":   azm[0],
        "azm_card":  azm[1],
        "azm_peak":  azm[2],
        # Widget 期望的字段名（兼容）
        "active_minutes": azm[0] + azm[1] + azm[2],   # 总活动分钟
        "resting_hr": resting_hr,
        "hrv":       hrv,
        "spo2":      spo2,
        "respiratory_rate": resp,
        # Widget 期望的睡眠字段名
        "sleep_asleep_min": (sleep["total"] - sleep["awake"]) if sleep else 0,
        "sleep_awake_min":  sleep["awake"]    if sleep else 0,
        "sleep_light_min":  sleep["light"]    if sleep else 0,
        "sleep_deep_min":   sleep["deep"]     if sleep else 0,
        "sleep_rem_min":    sleep["rem"]      if sleep else 0,
        "sleep_bedtime":    sleep["bedtime"]  if sleep else "",
        "sleep_wakeup":     sleep["wakeup"]   if sleep else "",
        "tip":      tip,
        "tip_level": tip_level,
        "sedentary": sedentary,
        "follow_up": today_entry.get("follow_up", False),
        "snooze_until": today_entry.get("snooze_until", 0),
        "pending_notify": today_entry.get("pending_notify", False),
    }

    # ── 防清零保护 ──
    # 若本次核心指标全空（步数/距离/卡路里均为 0 且无睡眠），
    # 且历史同期有有效数据 → 判定为 API 瞬时失败，保留上次有效数据，不覆盖。
    prev = load_current_today()
    core_empty = (steps == 0 and distance == 0 and calories == 0
                  and (sleep is None or sleep["total"] == 0))
    if prev.get("date") == today and core_empty and (prev.get("steps") or 0) > 0:
        log("  ⚠️ 本次采集核心指标全空，疑似 API 瞬时失败，保留上次有效数据")
        kept = dict(prev)
        kept["updated_at"] = datetime.now().strftime("%H:%M")
        with open(DATA_FILE, "w") as f:
            f.write("const HEALTH_DATA = " + json.dumps({"today": kept, "history": history}, ensure_ascii=False, indent=2) + ";\n")
        log("✅ 已保留上次有效数据，跳过本次写入")
        return

    # 更新历史条目（供下次对比）
    today_entry.update({
        "steps": steps,
        "sleep_asleep_min": today_data["sleep_asleep_min"],
        "hrv": hrv,
        "resting_hr": resting_hr,
        "spo2": spo2,
    })
    with open(DATA_FILE, "w") as f:
        f.write("const HEALTH_DATA = " + json.dumps({"today": today_data, "history": history}, ensure_ascii=False, indent=2) + ";\n")
    log(f"✅ data.js 已写入 ({today})")
    print("DASHBOARD_UPDATE_OK")

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--alerter":
        idle = int(sys.argv[2]) if len(sys.argv) > 2 else 45
        run_alerter_mode(idle)
    else:
        main()
