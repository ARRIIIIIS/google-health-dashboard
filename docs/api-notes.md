# 健康数据采集指令

你的任务：采集今日全部健康数据，然后更新 `data.js` 文件。

## API 格式速查

**所有 dailyRollUp 接口（步数/距离/卡路里/活动区间）**：
```
POST https://health.googleapis.com/v4/users/me/dataTypes/{dtype}/dataPoints:dailyRollUp
Body（civilDateRange 格式）：
{
  "range": {
    "start": {
      "date": {"year": 2026, "month": 7, "day": 27},
      "time": {"hours": 0, "minutes": 0, "seconds": 0, "nanos": 0}
    },
    "end": {
      "date": {"year": 2026, "month": 7, "day": 28},
      "time": {"hours": 0, "minutes": 0, "seconds": 0, "nanos": 0}
    }
  }
}
```

**注意**：`range.end.date` 是**次日**（today+1），即 today 的数据截止到当天 23:59:59。

## 步骤

### 1. 读取 data.js
```bash
cat ./data.js
```

### 2. 采集数据（curl 直连，走代理）

```python
import json, subprocess, re
from datetime import datetime, timedelta

PROXY = None  # 或 "http://127.0.0.1:7890"
TOKEN_FILE = "./tokens.json"
DATA_FILE = "./data.js"

def load_token():
    with open(TOKEN_FILE) as f:
        return json.load(f)["access_token"]

def api_post(dtype, body):
    r = subprocess.run(
        ["curl", "-s", "--proxy", PROXY, "--max-time", "30",
         "-H", f"Authorization: Bearer {TOKEN}",
         "-H", "Content-Type: application/json",
         "-X", "POST",
         f"https://health.googleapis.com/v4/users/me/dataTypes/{dtype}/dataPoints:dailyRollUp",
         "-d", json.dumps(body)],
        capture_output=True, text=True
    )
    return json.loads(r.stdout)

def api_get(path):
    r = subprocess.run(
        ["curl", "-s", "--proxy", PROXY, "--max-time", "30",
         "-H", f"Authorization: Bearer {TOKEN}",
         f"https://health.googleapis.com/v4/{path}"],
        capture_output=True, text=True
    )
    return json.loads(r.stdout)

def make_range(date_str):
    """date_str 格式 YYYY-MM-DD，返回 civilDateRange body"""
    y, m, d = map(int, date_str.split("-"))
    nxt = (datetime(*map(int, date_str.split("-"))) + timedelta(days=1)).strftime("%Y-%m-%d").split("-")
    ny, nm, nd = map(int, nxt)
    return {
        "range": {
            "start": {"date": {"year": y, "month": m, "day": d},
                      "time": {"hours": 0, "minutes": 0, "seconds": 0, "nanos": 0}},
            "end":   {"date": {"year": ny, "month": nm, "day": nd},
                      "time": {"hours": 0, "minutes": 0, "seconds": 0, "nanos": 0}}
        }
    }

TOKEN = load_token()
today = datetime.now().strftime("%Y-%m-%d")  # "2026-07-27"

body = make_range(today)

# 步数
steps_d = api_post("steps", body)
steps = int((steps_d.get("rollupDataPoints") or [{}])[0].get("steps", {}).get("countSum", 0))

# 距离（mm → km）
dist_d = api_post("distance", body)
dist = round(int((dist_d.get("rollupDataPoints") or [{}])[0].get("distance", {}).get("millimetersSum", 0)) / 1_000_000, 2)

# 卡路里
cals_d = api_post("total-calories", body)
cals = int((cals_d.get("rollupDataPoints") or [{}])[0].get("totalCalories", {}).get("kcalSum", 0))

# 活动区间
azm_d = api_post("active-zone-minutes", body)
azm_rdp = (azm_d.get("rollupDataPoints") or [{}])[0].get("activeZoneMinutes", {})
fb = int(azm_rdp.get("sumInFatBurnHeartZone", 0))
cb = int(azm_rdp.get("sumInCardioHeartZone", 0))
pb = int(azm_rdp.get("sumInPeakHeartZone", 0))
active_min = fb + cb + pb

# 睡眠（reconcile，取最新 STAGES 记录）
sleep_d = api_get("users/me/dataTypes/sleep/dataPoints:reconcile?pageSize=10")
sl = None
for p in sleep_d.get("dataPoints", []):
    if p.get("sleep", {}).get("type") != "STAGES":
        continue
    iv = p["sleep"]["interval"]
    off_s = int(re.sub(r"\D", "", iv.get("startUtcOffset", "28800s")) or "28800")
    st_local = datetime.fromisoformat(iv["startTime"].replace("Z", "+00:00")) + timedelta(seconds=off_s)
    en_local = datetime.fromisoformat(iv["endTime"].replace("Z", "+00:00")) + timedelta(seconds=off_s)
    total_min = int((en_local - st_local).total_seconds() / 60)
    deep = rem = light = awake = 0
    for stg in p["sleep"].get("stages", []):
        off2 = int(re.sub(r"\D", "", stg.get("startUtcOffset", "28800s")) or "28800")
        st2 = datetime.fromisoformat(stg["startTime"].replace("Z", "+00:00")) + timedelta(seconds=off2)
        en2 = datetime.fromisoformat(stg["endTime"].replace("Z", "+00:00")) + timedelta(seconds=off2)
        mins = int((en2 - st2).total_seconds() / 60)
        t = stg["type"]
        if t == "DEEP":  deep  += mins
        elif t == "REM":  rem  += mins
        elif t == "LIGHT": light += mins
        elif t == "AWAKE": awake += mins
    sl = {
        "bedtime": st_local.strftime("%H:%M"),
        "wakeup":   en_local.strftime("%H:%M"),
        "total":    total_min,
        "deep":     deep,
        "rem":      rem,
        "light":    light,
        "awake":    awake,
        "asleep":   total_min - awake,
        "date_cst": st_local.strftime("%-m/%-d")
    }
    break  # 只取最新一条

print(f"采集完成: steps={steps}, dist={dist}, cals={cals}, active={active_min}min, sleep={sl}")
```

### 3. 更新 data.js（使用严格的行级正则）

```python
import re

ts = datetime.now().strftime("%Y-%m-%d %H:%M CST")
tip = f'昨晚深睡{sl["deep"] if sl else "?"}min，质量极佳。今日步数目标过半，继续保持。'

with open(DATA_FILE) as f:
    raw = f.read()

# 用行级正则，每行只替换一次（防止同一行被多次匹配）
raw = re.sub(r'^(\s+tip: )".*",?$', f'\\g<1>"{tip}",', raw, count=1, flags=re.MULTILINE)
raw = re.sub(r'^(\s+tip_level: )".*",?$', '\\g<1>"good",', raw, count=1, flags=re.MULTILINE)
raw = re.sub(r'^(\s+date: )".*",?$', f'\\g<1>"{today}",', raw, count=1, flags=re.MULTILINE)
raw = re.sub(r'^(\s+updated: )".*",?$', f'\\g<1>"{ts}",', raw, count=1, flags=re.MULTILINE)
raw = re.sub(r'^(\s+steps: )\d+,?$', f'\\g<1>{steps},', raw, count=1, flags=re.MULTILINE)
raw = re.sub(r'^(\s+distance_km: )[\d.]+,?$', f'\\g<1>{dist},', raw, count=1, flags=re.MULTILINE)
raw = re.sub(r'^(\s+total_calories: )\d+,?$', f'\\g<1>{cals},', raw, count=1, flags=re.MULTILINE)
raw = re.sub(r'^(\s+active_minutes: )\d+,?$', f'\\g<1>{active_min},', raw, count=1, flags=re.MULTILINE)
raw = re.sub(r'^(\s+azm_fat_burn: )\d+,?$', f'\\g<1>{fb},', raw, count=1, flags=re.MULTILINE)
raw = re.sub(r'^(\s+azm_cardio: )\d+,?$', f'\\g<1>{cb},', raw, count=1, flags=re.MULTILINE)
raw = re.sub(r'^(\s+azm_peak: )\d+,?$', f'\\g<1>{pb},', raw, count=1, flags=re.MULTILINE)

if sl:
    raw = re.sub(r'^(\s+sleep_total_min: )\d+,?$', f'\\g<1>{sl["total"]},', raw, count=1, flags=re.MULTILINE)
    raw = re.sub(r'^(\s+sleep_asleep_min: )\d+,?$', f'\\g<1>{sl["asleep"]},', raw, count=1, flags=re.MULTILINE)
    raw = re.sub(r'^(\s+sleep_awake_min: )\d+,?$', f'\\g<1>{sl["awake"]},', raw, count=1, flags=re.MULTILINE)
    raw = re.sub(r'^(\s+sleep_light_min: )\d+,?$', f'\\g<1>{sl["light"]},', raw, count=1, flags=re.MULTILINE)
    raw = re.sub(r'^(\s+sleep_deep_min: )\d+,?$', f'\\g<1>{sl["deep"]},', raw, count=1, flags=re.MULTILINE)
    raw = re.sub(r'^(\s+sleep_rem_min: )\d+,?$', f'\\g<1>{sl["rem"]},', raw, count=1, flags=re.MULTILINE)
    raw = re.sub(r'^(\s+bedtime: )"[^"]+",?$', f'\\g<1>"{sl["bedtime"]}",', raw, count=1, flags=re.MULTILINE)
    raw = re.sub(r'^(\s+wakeup: )"[^"]+",?$', f'\\g<1>"{sl["wakeup"]}",', raw, count=1, flags=re.MULTILINE)

with open(DATA_FILE, "w") as f:
    f.write(raw)

print(f"✅ data.js 已写入 ({today})")
```

## 数据字段对应

| API 返回字段 | data.js 字段 | 说明 |
|---|---|---|
| `rollupDataPoints[0].steps.countSum` | `steps` | 每日总步数 |
| `rollupDataPoints[0].distance.millimetersSum / 1_000_000` | `distance_km` | 公里数 |
| `rollupDataPoints[0].totalCalories.kcalSum` | `total_calories` | 每日总卡路里 |
| `activeZoneMinutes.sumInFatBurnHeartZone` | `azm_fat_burn` | 脂肪燃烧分钟数 |
| `activeZoneMinutes.sumInCardioHeartZone` | `azm_cardio` | 心率增强分钟数 |
| `activeZoneMinutes.sumInPeakHeartZone` | `azm_peak` | 峰值分钟数 |
| sleep.stages DEEP/REM/LIGHT/AWAKE | `sleep_deep/...` | 各阶段分钟数 |
| sleep.interval startTime + offset | `bedtime` | 睡眠开始时间（CST） |

## 支持 dailyRollUp 的数据类型
`steps`, `distance`, `total-calories`, `active-zone-minutes`

### dailyRollUp v4 body 格式（正确，已验证）
```json
POST /v4/users/me/dataTypes/{dtype}/dataPoints:dailyRollUp
{
  "range": {
    "start": {"date": {"year":2026,"month":7,"day":28},
             "time": {"hours":0,"minutes":0,"seconds":0,"nanos":0}},
    "end":   {"date": {"year":2026,"month":7,"day":29},
             "time": {"hours":0,"minutes":0,"seconds":0,"nanos":0}}
  }
}
```
- **不能用 `dataTypeName`**（v4 已废弃，报 `Invalid name 'dataTypeName'`）
- **不能用 `windowSizeDays`**（报 `Invalid argument in request`）
- **不能用 `dataSourceFamily`**（部分类型不支持，报 `Data family is missing`）

## 通过 GET reconcile 获取的每日汇总指标
已验证可用（2026-07-28 全部返回今日数据）：

| 数据类型 ID | 字段 | 示例值 |
|---|---|---|
| `daily-resting-heart-rate` | `dailyRestingHeartRate.beatsPerMinute` | 70 bpm |
| `daily-respiratory-rate` | `dailyRespiratoryRate.breathsPerMinute` | 11.6 |
| `daily-oxygen-saturation` | `dailyOxygenSaturation.averagePercentage` | 96.3% |
| `daily-heart-rate-variability` | `dailyHeartRateVariability.averageHeartRateVariabilityMilliseconds` | 43.7 ms |

### reconcile GET 请求格式
```
GET /v4/users/me/dataTypes/{dtype}/dataPoints:reconcile?pageSize=5
```
- body 无需参数，API 按日期倒序返回
- `dataSourceFamily=google-sources` 对这些类型不适用（需省略）
- 响应中 date 字段为 `{year, month, day}` 对象，需用日期对象比对

## sleep reconcile（已知工作）
`GET /v4/users/me/dataTypes/sleep/dataPoints:reconcile?pageSize=10`
- 返回 `sleep.type=STAGES` 条目
- 无需 `dataSourceFamily` 参数

## 完成
写入成功后输出：`DASHBOARD_UPDATE_OK`
