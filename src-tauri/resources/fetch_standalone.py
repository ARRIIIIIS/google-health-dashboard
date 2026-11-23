#!/usr/bin/env python3
"""
Google Health API 数据采集脚本
使用 curl 直连，绕过 MCP 层
API 文档：https://developers.google.com/health/android/reference/rest/v4
"""
import json, subprocess, sys, re, time, urllib.parse, random, os, shutil, argparse, threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

# 提示文本中剥离 emoji / 装饰符号（小组件系统字体无法渲染，会显示成 □）
_EMOJI_RE = re.compile(r'[\U0001F000-\U0001FFFF\u2600-\u27BF\uFE0F\u200D]')
def clean_text(s):
    if not s: return s
    return _EMOJI_RE.sub('', s).strip()

def _detect_proxy():
    """本地代理(7890)活着就走代理，否则直连。避免代理软件没开时全挂。"""
    import socket
    try:
        socket.create_connection(("127.0.0.1", 7890), timeout=1).close()
        return ["--proxy", "http://127.0.0.1:7890"]
    except Exception:
        return []

PROXY_ARGS = _detect_proxy()

# --ping 模式下静默：日志走 stderr，避免污染 stdout 上的 JSON 结果
_QUIET = False

# ── 命令行参数（Tauri 跨平台：路径由 Rust 传入）──
_ARGV = argparse.ArgumentParser()
_ARGV.add_argument("--out",    default=os.path.expanduser("~/google-health-dashboard/data.js"))
_ARGV.add_argument("--token",  default=os.path.expanduser("~/.google-health-mcp/tokens.json"))
_ARGV.add_argument("--config", default=os.path.expanduser("~/.google-health-mcp/config.json"))
_ARGV.add_argument("--once",   action="store_true")
_ARGV.add_argument("--ping",   action="store_true", help="轻量探测：只测 API 连通与延迟，输出 JSON，不采集数据")
_ARGV.add_argument("--loop",   action="store_true")
_ARGV.add_argument("--sed-min",    type=int, default=45, help="连续不动超过此时长(分钟)判定久坐")
_ARGV.add_argument("--remind-min", type=int, default=30, help="久坐后每隔多久复查提醒一次(分钟)")
_ARGV.add_argument("--notify-start", type=int, default=9, help="久坐提醒开始小时(0-23)")
_ARGV.add_argument("--notify-end",   type=int, default=22, help="久坐提醒结束小时(1-24)")
_ARGS = _ARGV.parse_known_args()[0]
TOKEN_FILE  = _ARGS.token
CONFIG_FILE = _ARGS.config
DATA_FILE   = _ARGS.out

def _atomic_write_json(path, data):
    """原子写 JSON：先写同目录临时文件再 os.replace，避免并发读写读到半写残缺文件。"""
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp_path = f"{path}.tmp.{os.getpid()}.{int(time.time() * 1000)}"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)

def write_data(d):
    """写数据文件（纯 JSON，供 Tauri Rust 读取）。"""
    _atomic_write_json(DATA_FILE, d)

def load_data_file():
    """读取数据文件，兼容纯 JSON 与旧版 const HEALTH_DATA 格式。"""
    try:
        raw = open(DATA_FILE).read()
    except Exception:
        return {"today": {}, "history": []}
    raw = raw.strip()
    if raw.startswith("const HEALTH_DATA"):
        raw = raw.replace("const HEALTH_DATA = ", "", 1).strip().rstrip(";")
    try:
        return json.loads(raw)
    except Exception:
        return {"today": {}, "history": []}

def get_7day_averages(history, today_date):
    """
    计算过去7天（不含今日）的指标平均值。
    预期 history 包含 snapshot。通过获取每天最后的 snapshot 来代表当日总量。
    """
    target_dates = []
    try:
        today_dt = datetime.strptime(today_date, "%Y-%m-%d")
    except:
        return {}

    for i in range(1, 8):
        target_dates.append((today_dt - timedelta(days=i)).strftime("%Y-%m-%d"))
    
    # 分组：date -> [entries]
    date_groups = {}
    for entry in history:
        d = entry.get("date")
        if d in target_dates:
            if d not in date_groups:
                date_groups[d] = []
            date_groups[d].append(entry)
            
    metrics_to_avg = ["steps", "sleep_asleep_min", "hrv", "resting_hr", "spo2", "resp"]
    stats = {m: [] for m in metrics_to_avg}
    
    for d in target_dates:
        entries = date_groups.get(d, [])
        if not entries:
            continue
        # 最后一个 entry 代表该日最新的状态/总量
        latest = entries[-1]
        for m in metrics_to_avg:
            val = latest.get(m)
            if val is not None and isinstance(val, (int, float)):
                stats[m].append(val)
                
    averages = {}
    for m in metrics_to_avg:
        vals = stats[m]
        if vals:
            averages[m] = round(sum(vals) / len(vals), 2)
        else:
            averages[m] = None
    return averages

def get_7day_series(history, today_date, today_summary):
    """生成最近 7 天（含今日，按日期升序）的每日汇总数组，供前端 7 日迷你趋势浮层直接渲染。"""
    try:
        today_dt = datetime.strptime(today_date, "%Y-%m-%d")
    except Exception:
        return []
    days = [(today_dt - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(6, 0, -1)]
    by_date = {}
    for entry in history:
        d = entry.get("date")
        if d in days and entry.get("steps") is not None:
            by_date[d] = entry
    series = []
    for d in days:
        e = by_date.get(d, {})
        series.append({
            "date": d,
            "steps": e.get("steps"),
            "active_minutes": e.get("active_minutes"),
            "sleep_asleep_min": e.get("sleep_asleep_min"),
            "resting_hr": e.get("resting_hr"),
            "hrv": e.get("hrv"),
            "spo2": e.get("spo2"),
        })
    series.append({
        "date": today_date,
        "steps": today_summary.get("steps"),
        "active_minutes": today_summary.get("active_minutes"),
        "sleep_asleep_min": today_summary.get("sleep_asleep_min"),
        "resting_hr": today_summary.get("resting_hr"),
        "hrv": today_summary.get("hrv"),
        "spo2": today_summary.get("spo2"),
    })
    return series

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

def is_token_expired():
    """检查 token 是否已过期（含 60s 缓冲）。"""
    try:
        td = json.load(open(TOKEN_FILE))
        return td.get("expires_at", 0) - int(time.time()) < 60
    except Exception:
        return True

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
         "https://oauth2.googleapis.com/token", "--data-binary", "@-"],
        input=body,
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
        _atomic_write_json(TOKEN_FILE, td)
        log(f"✅ token 已刷新 (有效期 {td['expires_in']}s)")
        return tok["access_token"]
    except Exception as e:
        log(f"❌ token 刷新失败: {e} | {r.stdout[:150]}")
        return None

# ─── API 工具 ─────────────────────────────────────────────────────────────────

def _curl_json(cmd, stdin_data=None):
    """执行 curl 并解析 JSON，带重试。遇空响应/超时/解析失败重试最多 3 次。"""
    for attempt in range(1, 4):
        try:
            r = subprocess.run(cmd, input=stdin_data, capture_output=True, text=True, timeout=40)
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

_TOKEN_LOCK = threading.Lock()

def _curl_auth_cfg(tok):
    safe = (tok or "").replace("\\", "\\\\").replace('"', '\\"').replace("\r", "").replace("\n", "")
    return f'header = "Authorization: Bearer {safe}"\n'

def _is_401(resp):
    if not isinstance(resp, dict):
        return False
    err = resp.get("error")
    return isinstance(err, dict) and err.get("code") == 401

def _refresh_token_once(old_tok):
    global TOKEN
    with _TOKEN_LOCK:
        if TOKEN and TOKEN != old_tok:
            return TOKEN
        log("🔄 收到 401，自动刷新 access_token 并重试...")
        new_tok = refresh_access_token()
        if new_tok:
            TOKEN = new_tok
        return TOKEN

def api_get(path):
    tok = TOKEN
    cmd = [
        "curl", "-s", *PROXY_ARGS, "--max-time", "30",
        "-K", "-",
        f"https://health.googleapis.com/v4/{path}"
    ]
    res = _curl_json(cmd, stdin_data=_curl_auth_cfg(tok))
    if _is_401(res):
        tok2 = _refresh_token_once(tok)
        if tok2 and tok2 != tok:
            res = _curl_json(cmd, stdin_data=_curl_auth_cfg(tok2))
    return res

def api_post(dtype, body):
    """POST to dailyRollUp 接口（v4，无 dataTypeName）"""
    tok = TOKEN
    cmd = [
        "curl", "-s", *PROXY_ARGS, "--max-time", "30",
        "-K", "-",
        "-H", "Content-Type: application/json",
        "-X", "POST",
        f"https://health.googleapis.com/v4/users/me/dataTypes/{dtype}/dataPoints:dailyRollUp",
        "-d", json.dumps(body)
    ]
    res = _curl_json(cmd, stdin_data=_curl_auth_cfg(tok))
    if _is_401(res):
        tok2 = _refresh_token_once(tok)
        if tok2 and tok2 != tok:
            res = _curl_json(cmd, stdin_data=_curl_auth_cfg(tok2))
    return res

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
    """取最近一次夜间睡眠（STAGES 类型）。
    关键校验：醒来时间（本地日期）必须等于今天，才作为「昨晚的睡眠」返回；
    否则说明昨晚未佩戴 / 无新睡眠，返回 None（前端显示无睡眠），
    避免把前几天旧睡眠原样带过来造成「睡眠不更新」的假象。"""
    today_date = datetime.now().date()
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
        # 醒来日期非今天 → 这是前几天的旧睡眠，跳过（不返回给今天）
        if en_local.date() != today_date:
            log(f"  ⏭️  跳过旧睡眠记录（醒来 {en_local.strftime('%Y-%m-%d %H:%M')}，非今日），昨晚可能未佩戴")
            continue
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

def fetch_latest_hr():
    """
    取最新实时心率样本（Fitbit Air / Health Connect 每 3 秒上报）及设备同步信息。
    返回 (bpm, "HH:MM", sync_age_min, device_name)。
    """
    try:
        d = api_get("users/me/dataTypes/heart-rate/dataPoints?pageSize=1")
        pts = d.get("dataPoints", [])
        if not pts:
            return None, None, None, None
        pt0 = pts[0]
        dev = (pt0.get("dataSource", {}).get("device", {}).get("displayName")
               or pt0.get("dataSource", {}).get("platform")
               or "Fitbit")
        hr = pt0.get("heartRate", {})
        bpm = float(hr.get("beatsPerMinute", 0)) or None
        st = hr.get("sampleTime", {})
        tt = st.get("civilTime", {}).get("time", {})
        time_str = None
        if tt.get("hours") is not None:
            hh, mm = tt.get("hours", 0), tt.get("minutes", 0)
            time_str = f"{hh:02d}:{mm:02d}"
        sync_age_min = None
        phys = st.get("physicalTime", "")
        if phys:
            try:
                from datetime import timezone
                dt_utc = datetime.fromisoformat(phys.replace("Z", "+00:00"))
                now_utc = datetime.now(timezone.utc)
                sync_age_min = max(0, int((now_utc - dt_utc).total_seconds() // 60))
            except Exception:
                pass
        return (int(round(bpm)) if bpm else None), time_str, sync_age_min, dev
    except Exception:
        return None, None, None, None

def fetch_device_info():
    """
    从 users/me/pairedDevices 获取实体手环（排除 MobileTrack）的真实电池电量与最后同步时间。
    返回 dict: {battery: int|None, status: str, name: str, last_sync: str|None, sync_age_min: int|None}
    """
    out = {"battery": None, "status": "", "name": "Fitbit", "last_sync": None, "sync_age_min": None}
    try:
        d = api_get("users/me/pairedDevices")
        devs = d.get("pairedDevices", [])
        if not devs:
            return out
        # 优先选择有 batteryLevel 或非 MobileTrack 的实体手环，按 lastSyncTime 降序
        real_devs = [x for x in devs if x.get("deviceVersion") != "MobileTrack"]
        candidates = real_devs if real_devs else devs
        candidates.sort(key=lambda x: x.get("lastSyncTime") or "", reverse=True)
        best = candidates[0]
        out["name"] = best.get("deviceVersion") or "Fitbit"
        out["status"] = best.get("batteryStatus") or ""
        if best.get("batteryLevel") is not None:
            out["battery"] = int(best["batteryLevel"])
        ts = best.get("lastSyncTime", "")
        if ts:
            try:
                from datetime import timezone
                dt_utc = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                now_utc = datetime.now(timezone.utc)
                out["sync_age_min"] = max(0, int((now_utc - dt_utc).total_seconds() // 60))
                dt_local = dt_utc.astimezone()
                out["last_sync"] = dt_local.strftime("%H:%M")
            except Exception:
                pass
        return out
    except Exception as e:
        log(f"  ⚠️ 获取手环电量失败: {e}")
        return out


def fetch_hourly_steps(steps_today, steps_yest):
    """
    （已停用：折线图被用户否决后不再调用，函数保留以备将来复用）
    拉取今日/昨日每小时步数原始点，按本地小时聚合，
    再缩放使累计曲线终点对齐日总量（解决 raw 累加与 reconcile 的差异）。
    返回 (今日累计[24], 昨日累计[24])，失败返回 (None, None)。
    """
    try:
        pts = []
        url = "users/me/dataTypes/steps/dataPoints?pageSize=500"
        for _ in range(12):   # 上限 12 页，足够覆盖今/昨两天
            d = api_get(url)
            pts += d.get("dataPoints", [])
            tok = d.get("nextPageToken")
            if not tok:
                break
            url = f"users/me/dataTypes/steps/dataPoints?pageSize=500&pageToken={tok}"

        def local_hour(p):
            iv = p["steps"]["interval"]
            st = iv["startTime"]                       # 2026-08-21T09:02:00Z
            off = int(iv.get("startUtcOffset", "0s").rstrip("s") or 0) / 3600.0
            hh = int(st[11:13])
            return st[:10], int(hh + off) % 24

        today_s = datetime.now().strftime("%Y-%m-%d")
        yest_s  = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        td, yd = [0] * 24, [0] * 24
        for p in pts:
            d0, h = local_hour(p)
            c = int(p["steps"]["count"])
            if d0 == today_s:   td[h] += c
            elif d0 == yest_s:  yd[h] += c

        def cumulative(arr, tot):
            s = sum(arr)
            if s == 0:
                return [0] * 24
            f = (tot or 0) / s
            out, run = [], 0
            for v in arr:
                run += v * f
                out.append(round(run))
            return out

        return cumulative(td, steps_today), cumulative(yd, steps_yest)
    except Exception:
        return None, None

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
    """读取历史记录（data.json 的 history 字段）"""
    return load_data_file().get("history", [])

def load_current_today():
    """读取当前 today 数据（供防清零保护对比）"""
    return load_data_file().get("today", {})


# App / Rust / 前端把以下交互字段写在【顶层 today】上；
# 而 check_sedentary 只读写 history 列表里的今日条目 (today_entry)。
# 采集器每轮用 today_data（来自 history 条目）整文件覆盖写盘，
# 若这些字段只存在于顶层 today（如 remind_event 由前端/脚本直接写入），
# 下一轮采集就会把它们清零，导致久坐提醒在真实场景下几乎不触发。
# 因此写盘前必须把顶层旧值作为兜底合并进来。
APP_FIELDS = {
    "follow_up": False,
    "snooze_until": 0,
    "pending_notify": False,
    "steps_at_sedentary": 0,
    "user_acked_time": 0,
    "remind_event": 0,
    "sedentary_notified": False,
    "last_remind_time": 0,
    "last_move_time": "",
    "last_steps": 0,
    "computer_away": False,
}

def preserve_app_fields(today_entry, prev_today):
    """
    合并 App 托管的交互字段。
    优先取本次 check_sedentary 计算出的 today_entry 值（采集器权威），
    否则回退到顶层 today 的旧值（App/Rust/前端写入的），
    再否则用默认值。这样顶层 today 上的 remind_event 等不会被采集覆盖清零。
    """
    out = {}
    for f, default in APP_FIELDS.items():
        v = today_entry.get(f, None)
        if v is None:
            v = prev_today.get(f, None)
        out[f] = default if v is None else v
    return out

# ─── 久坐检测参数 ──────────────────────────────────────────────────────────────
SEDENTARY_MIN = 45        # 连续不动超过此时长(分钟)则提醒（可被 --sed-min 覆盖）
SEDENTARY_REMIND_MIN = 30 # 首次提醒后，每隔此时长复查提醒一次(分钟)（可被 --remind-min 覆盖）
STEP_DELTA    = 30        # 步数增加超过此值算"有活动"，重置久坐（80→30：短走也算活动）
NOTIFY_START_HOUR = 10     # 仅在工作时段发通知(这台 Mac 10:00–19:00 使用)
NOTIFY_END_HOUR   = 19
USER_ACK_GRACE_MS = 3 * 60 * 1000  # 用户点"站起来了"后 3 分钟宽限，期间不重复弹

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
    用户点击「现在起来」或「稍后」后的处理。
    不再立刻重置久坐状态——只记录 ack 时间，给 3 分钟宽限。
    下次 check_sedentary 会对比步数：步数增加 → 自动重置；步数不变 → 宽限期过后继续提醒。
    """
    try:
        d = load_data_file()
        now = datetime.now()
        tid = d["today"]["date"]
        ack_time = int(time.time() * 1000)

        for h in d.get("history", []):
            if h.get("date") == tid:
                h["user_acked_time"] = ack_time
                h["last_remind_time"] = ack_time
                h["sedentary_notified"] = True
                break

        d["today"]["user_acked_time"] = ack_time
        d["today"]["last_remind_time"] = ack_time
        d["today"]["sedentary_notified"] = True
        write_data(d)
        log(f"  💬 用户点击「{choice}」，3分钟宽限期内不重复弹（步数增加将自动解除久坐）")
    except Exception as e:
        log(f"  ⚠️ 选择状态更新失败: {e}")


def _get_macos_hid_idle_min():
    """读取 macOS IOHIDSystem 的键鼠空闲时长（分钟）。非 macOS 或读取失败返回 0。"""
    if sys.platform != "darwin":
        return 0
    try:
        r = subprocess.run(
            ["ioreg", "-c", "IOHIDSystem", "-d", "4"],
            capture_output=True, text=True, timeout=3
        )
        m = re.search(r'"HIDIdleTime"\s*=\s*(\d+)', r.stdout)
        if m:
            ns = int(m.group(1))
            return int(ns / 1_000_000_000 / 60)
    except Exception:
        pass
    return 0

def check_sedentary(today_entry, prev_today, steps, now):
    """
    步数驱动 + 电脑键鼠活跃协同的久坐检测：
    核心原则：
    ── 场景 1：步数增加（≥ STEP_DELTA）→ 确认解除久坐
    ── 场景 2：电脑键鼠空闲 ≥ 20 分钟 → 用户已离开电脑/锁屏/开会（可能没戴表），
               标记 computer_away=True，不误弹久坐提醒；当用户刚回到电脑前（hid_idle < 5）时，
               重置活动基线时间，避免一坐下就被弹窗
    ── 场景 3：点"站起来了"→ 立刻重置数值（即时反馈），3 分钟后复查步数：
               步数增加 → 确认解除；步数未变 → 回滚到原始 idle 时间并继续累计
    ── 场景 4：久坐提醒后用户未操作、步数也未变 → 按 SEDENTARY_REMIND_MIN 间隔复查提醒
    返回 (sedentary, idle_min, reminded_this_run)
    """
    def _pick(key, default):
        v = (prev_today or {}).get(key, None)
        if v is None:
            v = today_entry.get(key, None)
        return default if v is None else v

    last_move_time = _pick("last_move_time", None)
    last_steps_rec = _pick("last_steps", 0)
    steps_at_sedentary = _pick("steps_at_sedentary", 0)
    user_acked_time = _pick("user_acked_time", 0)
    steps_at_ack = _pick("steps_at_ack", 0)
    last_move_time_before_ack = _pick("last_move_time_before_ack", "")
    was_away = bool(_pick("computer_away", False))

    hid_idle_min = _get_macos_hid_idle_min()
    away_threshold = min(max(15, SEDENTARY_MIN // 2), 20)
    if hid_idle_min >= away_threshold:
        today_entry["computer_away"] = True
        log(f"  💤 电脑键鼠已空闲 {hid_idle_min}min（≥{away_threshold}min），判定离座/锁屏，暂停久坐计时")
        return False, 0, False
    if was_away and hid_idle_min < 5:
        log("  👋 检测到用户刚回到电脑前，重置久坐计时基线")
        today_entry["computer_away"] = False
        today_entry["last_move_time"] = now.strftime("%Y-%m-%d %H:%M:%S")
        today_entry["last_steps"] = steps
        today_entry["sedentary_notified"] = False
        today_entry["follow_up"] = False
        today_entry["snooze_until"] = 0
        today_entry["pending_notify"] = False
        today_entry["remind_event"] = 0
        today_entry["steps_at_sedentary"] = 0
        return False, 0, False
    today_entry["computer_away"] = False

    # ── 首次运行：初始化活动基线 ──
    if not last_move_time:
        today_entry["last_move_time"] = now.strftime("%Y-%m-%d %H:%M:%S")
        today_entry["last_steps"] = steps
        today_entry["sedentary_notified"] = False
        today_entry["follow_up"] = False
        today_entry["snooze_until"] = 0
        today_entry["pending_notify"] = False
        today_entry["remind_event"] = 0
        today_entry["steps_at_sedentary"] = 0
        today_entry["user_acked_time"] = 0
        today_entry["steps_at_ack"] = 0
        today_entry["last_move_time_before_ack"] = ""
        return False, 0, False

    # ── 用户点过"站起来了"，且宽限期已过（3 分钟）── 检查是否说谎
    now_ms = time.time() * 1000
    if user_acked_time and now_ms - user_acked_time >= USER_ACK_GRACE_MS:
        if steps_at_ack and steps >= steps_at_ack + STEP_DELTA:
            # ✅ 步数真的增加了：确认解除，清掉 ack 和回滚记录
            today_entry["last_move_time"] = now.strftime("%Y-%m-%d %H:%M:%S")
            today_entry["last_steps"] = steps
            today_entry["sedentary_notified"] = False
            today_entry["follow_up"] = False
            today_entry["snooze_until"] = 0
            today_entry["pending_notify"] = False
            today_entry["remind_event"] = 0
            today_entry["steps_at_sedentary"] = 0
            today_entry["user_acked_time"] = 0
            today_entry["steps_at_ack"] = 0
            today_entry["last_move_time_before_ack"] = ""
            log(f"  ✅ ack 核验通过：步数从 {steps_at_ack}→{steps}（≥{STEP_DELTA}），确认解除久坐")
            return False, 0, False
        else:
            # ❌ 说谎了：回滚到原始 last_move_time，idle 继续累计
            log(f"  ❌ ack 核验失败：步数未增加（{steps_at_ack}→{steps}），回滚久坐数值")
            if last_move_time_before_ack:
                today_entry["last_move_time"] = last_move_time_before_ack
                today_entry["last_steps"] = steps_at_ack or steps
            today_entry["user_acked_time"] = 0
            today_entry["steps_at_ack"] = 0
            today_entry["last_move_time_before_ack"] = ""
            today_entry["sedentary_notified"] = False  # 允许再次弹窗
            # 防说谎是最高优先级「抓包」：被抓到没真走，就作废此前点的「稍后」，
            # 让再提醒穿透 snooze 静默期强制弹出。
            today_entry["snooze_until"] = 0
            # 重新计算 idle_min（基于回滚后的 last_move_time）
            last_move_time = today_entry.get("last_move_time", last_move_time)

    # ── 步数增加 → 自动重置久坐（核心逻辑）──
    baseline = max(last_steps_rec, steps_at_sedentary) if steps_at_sedentary else last_steps_rec
    if steps >= baseline + STEP_DELTA:
        today_entry["last_move_time"] = now.strftime("%Y-%m-%d %H:%M:%S")
        today_entry["last_steps"] = steps
        today_entry["sedentary_notified"] = False
        today_entry["follow_up"] = False
        today_entry["snooze_until"] = 0
        today_entry["pending_notify"] = False
        today_entry["remind_event"] = 0
        today_entry["steps_at_sedentary"] = 0
        today_entry["user_acked_time"] = 0
        today_entry["steps_at_ack"] = 0
        today_entry["last_move_time_before_ack"] = ""
        log(f"  ✅ 步数增加 {last_steps_rec}→{steps}（≥{STEP_DELTA}），自动解除久坐")
        return False, 0, False

    idle_min = int((now - datetime.strptime(last_move_time, "%Y-%m-%d %H:%M:%S")).total_seconds() // 60)
    if idle_min < 0:
        idle_min = 0
    if idle_min < SEDENTARY_MIN:
        today_entry["follow_up"] = False
        today_entry["snooze_until"] = 0
        today_entry["pending_notify"] = False
        today_entry["remind_event"] = 0
        today_entry["steps_at_sedentary"] = 0
        today_entry["user_acked_time"] = 0
        today_entry["steps_at_ack"] = 0
        today_entry["last_move_time_before_ack"] = ""
        return False, idle_min, False

    # ── 已达久坐阈值 ──
    if not steps_at_sedentary:
        today_entry["steps_at_sedentary"] = steps
        log(f"  📊 记录久坐基线步数: {steps}")

    # 用户刚点过"站起来了"？3 分钟宽限期内不重复弹
    if user_acked_time and now_ms - user_acked_time < USER_ACK_GRACE_MS:
        return True, idle_min, False

    # 触发提醒（首次 或 复查到期）
    in_window = NOTIFY_START_HOUR <= now.hour < NOTIFY_END_HOUR
    reminded = False
    last_remind = today_entry.get("last_remind_time", 0)
    remind_due = (now_ms - last_remind) >= SEDENTARY_REMIND_MIN * 60 * 1000
    if in_window and (not today_entry.get("sedentary_notified") or remind_due) and not today_entry.get("pending_notify"):
        reminded = True
        today_entry["sedentary_notified"] = True
        today_entry["last_remind_time"] = int(now_ms)
        # 提醒事件时间戳：Tauri 前端检测到它变化 → 调 Rust 弹系统通知（菜单栏 app 身份）
        today_entry["remind_event"] = int(now_ms)
    today_entry["follow_up"] = True
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
    """
    生成一句简洁的自然语言健康洞察（助理风格）。
    以「今天 vs 昨天」为主轴，结合时段上下文，2–3 句内说完。
    不堆砌数据，关注值得说的变化。
    """
    if hour is None:
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


def generate_tip(steps, azm, sleep_total, deep, rem, resting_hr, hrv, spo2, resp, yesterday, update_seq, sedentary=False, idle_min=0):
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

    if warnings:
        # alert 级红线最优先；warn 级让位给久坐提示（久坐更紧急、可立即行动）
        alerts = [w for w in warnings if w[0] == "alert"]
        if alerts:
            return f"{greet} {alerts[0][1]}", "alert"

    # 久坐提醒优先于 warn 级警告与普通洞察（时间敏感、需要立刻行动）
    if sedentary:
        return f"{greet} 已久坐 {idle_min} 分钟，起来活动 3 分钟就能重置", "warn"

    if warnings:
        level, wtxt = warnings[0]
        return f"{greet} {wtxt}", level

    if insight:
        return f"{greet} {insight}", insight_level
    return f"{greet} {GOOD_MSGS[update_seq % len(GOOD_MSGS)]}", "good"

# ─── 日志 / 主流程 ────────────────────────────────────────────────────────────

def log(msg):
    # --ping 时 stdout 要保持纯净（只输出 JSON），日志改走 stderr
    if _QUIET:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True, file=sys.stderr)
        return
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def main():
    global TOKEN, SEDENTARY_MIN, SEDENTARY_REMIND_MIN, NOTIFY_START_HOUR, NOTIFY_END_HOUR
    TOKEN = load_token()
    # 久坐阈值/提醒间隔/提醒时段由 Tauri 侧 settings 传入，用户改设置后立即生效
    SEDENTARY_MIN = max(5, _ARGS.sed_min)
    SEDENTARY_REMIND_MIN = max(5, _ARGS.remind_min)
    NOTIFY_START_HOUR = max(0, min(23, _ARGS.notify_start))
    NOTIFY_END_HOUR = max(1, min(24, _ARGS.notify_end))

    # 如果 token 仍然过期（刷新失败），不要调 API 覆盖好数据
    if is_token_expired():
        log("❌ Token 已过期且刷新失败，跳过本次采集，保留旧数据")
        print("DASHBOARD_SKIP")
        return

    today = datetime.now().strftime("%Y-%m-%d")
    t_start = time.time()
    log(f"开始并发采集 {today}...")

    # 11 个接口并发拉取（耗时从 4~8s 压到 ~1s）
    with ThreadPoolExecutor(max_workers=6) as pool:
        f_steps    = pool.submit(fetch_steps, today)
        f_dist     = pool.submit(fetch_distance, today)
        f_cal      = pool.submit(fetch_calories, today)
        f_azm      = pool.submit(fetch_azm, today)
        f_sleep    = pool.submit(fetch_sleep)
        f_rhr      = pool.submit(fetch_resting_hr, today)
        f_resp     = pool.submit(fetch_respiratory_rate, today)
        f_spo2     = pool.submit(fetch_oxygen_saturation, today)
        f_hrv      = pool.submit(fetch_hrv, today)
        f_live_hr  = pool.submit(fetch_latest_hr)
        f_dev      = pool.submit(fetch_device_info)

        steps    = f_steps.result()
        distance = f_dist.result()
        calories = f_cal.result()
        azm      = f_azm.result()
        sleep    = f_sleep.result()
        resting_hr = f_rhr.result()
        resp       = f_resp.result()
        spo2       = f_spo2.result()
        hrv        = f_hrv.result()
        heart_rate, heart_rate_time, hr_sync_age, hr_dev_name = f_live_hr.result()
        dev_info   = f_dev.result()

    device_battery = dev_info.get("battery")
    device_battery_status = dev_info.get("status") or ""
    device_name = dev_info.get("name") or hr_dev_name or "Fitbit"
    sync_age_min = dev_info.get("sync_age_min") if dev_info.get("sync_age_min") is not None else hr_sync_age
    last_sync_time = dev_info.get("last_sync") or heart_rate_time

    azm_str = f"{sum(azm)}min(脂{azm[0]}/心{azm[1]}/峰{azm[2]})"
    log(f"  步数: {steps} | 距离: {distance}km | 卡路里: {calories} | 活动: {azm_str} ({int((time.time()-t_start)*1000)}ms)")
    sl_str = (f"睡眠{int(sleep['total'])}min(深{sleep['deep']}/REM{sleep['rem']}/浅{sleep['light']}/清醒{sleep['awake']}) "
              f"入睡{sleep['bedtime']}→{sleep['wakeup']}") if sleep else "无睡眠数据"
    log(f"  {sl_str}")
    log(f"  静息HR: {resting_hr} | 实时HR: {heart_rate}@{heart_rate_time} | 手环: {device_name} 电量={device_battery}%({device_battery_status}) 同步={last_sync_time}(距今{sync_age_min}m) | 呼吸: {resp} | SpO2: {spo2} | HRV: {hrv}")

    # ── 历史记录（用于变化对比）──
    history = load_history()
    now_dt = datetime.now()
    now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")
    now_time_str = now_dt.strftime("%H:%M")
    today = now_dt.strftime("%Y-%m-%d")
    
    # 1. 寻找或创建“今日”汇总条目（用于 Widget 展示与防清零保护）
    today_entry = next((h for h in history if h.get("date") == today), None)
    if today_entry:
        today_entry["update_count"] = today_entry.get("update_count", 0) + 1
    else:
        today_entry = {"date": today, "update_count": 0}
        history.append(today_entry)

    # 顶层 today 是 App/Rust/前端写入的权威实时态（remind_event、sedentary 等）。
    # check_sedentary 只从 history 条目读基线，会忽略顶层写入；这里读出来作为兜底。
    prev_today = load_current_today()

    # 2. 生成当前状态快照（用于时间序列对比）
    snapshot = {
        "date": today,
        "time": now_time_str,
        "steps": steps,
        "active_minutes": azm[0] + azm[1] + azm[2],
        "sleep_asleep_min": (sleep["total"] - sleep["awake"]) if sleep else 0,
        "resting_hr": resting_hr,
        "hrv": hrv,
        "spo2": spo2,
        "resp": resp,
        "timestamp": int(time.time() * 1000)
    }
    history.append(snapshot)

    # 3. 修剪历史记录：保留最近 8 天（满足 7 日均值计算，之前 [-500:] 按 5 分钟粒度只能留 ~1.7 天），
    #    同时按 2500 条上限保底防止文件无限膨胀
    cutoff_date = (now_dt - timedelta(days=8)).strftime("%Y-%m-%d")
    history = [h for h in history if (h.get("date") or "") >= cutoff_date][-2500:]
    
    # 4. 提取对比基线（用于 Python 端日志记录）
    update_seq = today_entry["update_count"]
    yesterday = next((h for h in reversed(history) if h.get("date") != today), None)
    if yesterday:
        log(f"  昨日/最近一次对比: steps={yesterday.get('steps')} time={yesterday.get('time')}")
    
    rolling_averages = get_7day_averages(history, today)
    if rolling_averages:
        log(f"  7日均值: {rolling_averages}")

    # ── 久坐检测 ──
    sedentary, idle_min, reminded = check_sedentary(today_entry, prev_today, steps, datetime.now())
    sync_stale = bool(sync_age_min is not None and sync_age_min >= 120)
    log(f"  久坐: {'是' if sedentary else '否'} (idle={idle_min}min) | 手环电量: {device_battery}% | 同步状态: {'超时未同步' if sync_stale else '正常'}")

    # 生成提示
    tip, tip_level = generate_tip(
        steps, azm,
        (sleep["total"] - sleep["awake"]) if sleep else 0,
        sleep["deep"]  if sleep else 0,
        sleep["rem"]   if sleep else 0,
        resting_hr, hrv, spo2, resp,
        yesterday, update_seq, sedentary, idle_min
    )
    log(f"  tip: {tip} [{tip_level}] (seq={update_seq})")

    # 写入 data.json
    # prev_today 已在上面读取（check_sedentary 之前），作为 App 托管交互字段的兜底来源
    today_data = {
        "date":      today,
        "updated_at": datetime.now().strftime("%H:%M"),
        "steps":     steps,
        "distance":  distance,
        "calories":  calories,
        "azm_fat":   azm[0],
        "azm_card":  azm[1],
        "azm_peak":  azm[2],
        "active_minutes": azm[0] + azm[1] + azm[2],
        "resting_hr": resting_hr,
        "heart_rate":      heart_rate,
        "heart_rate_time": heart_rate_time,
        "hrv":       hrv,
        "spo2":      spo2,
        "respiratory_rate": resp,
        "sleep_asleep_min": (sleep["total"] - sleep["awake"]) if sleep else 0,
        "sleep_awake_min":  sleep["awake"]    if sleep else 0,
        "sleep_light_min":  sleep["light"]    if sleep else 0,
        "sleep_deep_min":   sleep["deep"]     if sleep else 0,
        "sleep_rem_min":    sleep["rem"]      if sleep else 0,
        "sleep_bedtime":    sleep["bedtime"]  if sleep else "",
        "sleep_wakeup":     sleep["wakeup"]   if sleep else "",
        "tip":      clean_text(tip),
        "tip_level": tip_level,
        "sedentary": sedentary,
        "idle_min": idle_min,
        "device_battery": device_battery,
        "device_battery_status": device_battery_status,
        "last_sync_time": last_sync_time or datetime.now().strftime("%H:%M"),
        "sync_age_min": sync_age_min,
        "sync_stale": sync_stale,
        "device_name": device_name,
        # ── App 托管交互字段：采集器不权威，优先保留旧值，避免覆盖清零 ──
        **preserve_app_fields(today_entry, prev_today),
        "rolling_averages": rolling_averages,
    }
    daily_history = get_7day_series(history, today, today_data)
    today_data["daily_history"] = daily_history

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
        write_data({"today": kept, "history": history})
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
    write_data({"today": today_data, "history": history})
    log(f"✅ data.json 已写入 ({today})")
    print("DASHBOARD_UPDATE_OK")

def ping():
    """轻量探测 Google Health API（供设置面板「数据 API 延迟测试」用）。
    stdout 只输出一行 JSON：{"ok":bool,"ms":int,"detail":str}。
    不做全量采集，只打一次 dataSources 列表端点（最轻的请求）。
    """
    res = {"ok": False, "ms": 0, "detail": ""}
    try:
        tok = load_token()
    except FileNotFoundError:
        res["detail"] = "未找到凭证文件（需先在浏览器完成 Google 授权）"
        print(json.dumps(res, ensure_ascii=False)); return
    except Exception as e:
        res["detail"] = f"读取凭证失败: {e}"
        print(json.dumps(res, ensure_ascii=False)); return
    if not tok:
        res["detail"] = "凭证无效或刷新失败（需重新授权）"
        print(json.dumps(res, ensure_ascii=False)); return

    t0 = time.time()
    try:
        # 直连时显式 --noproxy '*'，避免继承 GUI 进程的 HTTP_PROXY 环境变量：
        # 本机对 Google Health 直连才是通的，走代理反而空响应。检测到 7890 代理才走代理。
        _curl_proxy = list(PROXY_ARGS) + (["--noproxy", "*"] if not PROXY_ARGS else [])
        r = subprocess.run([
            "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", *_curl_proxy,
            "--connect-timeout", "5", "--max-time", "15",
            "-K", "-",
            "https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints:reconcile?pageSize=1",
        ], input=_curl_auth_cfg(tok), capture_output=True, text=True, timeout=20)
        res["ms"] = int((time.time() - t0) * 1000)
        code = (r.stdout or "").strip()
        if code == "200":
            res["ok"] = True
            res["detail"] = "HTTP 200 · 凭证有效"
        elif code == "401" or code == "403":
            res["detail"] = f"HTTP {code} · 凭证被拒绝（需重新授权）"
        else:
            res["detail"] = f"HTTP {code or '无响应'}"
    except subprocess.TimeoutExpired:
        res["ms"] = int((time.time() - t0) * 1000)
        res["detail"] = "请求超时 (>15s)"
    except Exception as e:
        res["ms"] = int((time.time() - t0) * 1000)
        res["detail"] = str(e)
    print(json.dumps(res, ensure_ascii=False))

if __name__ == "__main__":
    if _ARGS.ping:
        _QUIET = True
        ping()
    elif _ARGS.loop:
        while True:
            try:
                main()
            except Exception as e:
                log(f"采集异常: {e}")
            time.sleep(300)
    else:
        main()
