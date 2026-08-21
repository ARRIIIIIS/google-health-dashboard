#!/usr/bin/env python3
"""
久坐重置 HTTP 服务（127.0.0.1:9293）
widget 点「起来了」按钮 → fetch /reset_sedentary → 把 data.js 里今日的
last_move_time 重置为当前时间、清空所有久坐状态字段 → 下次 fetch 周期 idle 归零。
由 launchd 常驻（com.local.sed-reset.plist）。
"""
import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

DATA_FILE = "/Users/dfrobot/google-health-dashboard/data.js"


def reset_sedentary():
    with open(DATA_FILE) as f:
        raw = f.read()
    d = json.loads(raw.replace("const HEALTH_DATA = ", "", 1).strip().rstrip(";"))
    today = d["today"]["date"]
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    steps = d["today"].get("steps", 0)
    for h in d.get("history", []):
        if h.get("date") == today:
            h["last_move_time"] = now
            h["last_steps"] = steps
            h["sedentary_notified"] = False
            h["follow_up"] = False
            h["pending_notify"] = False
            h["snooze_until"] = 0
            h["verify_after_time"] = 0
            h["verify_baseline_steps"] = 0
    t = d["today"]
    t["sedentary"] = False
    t["idle_min"] = 0
    t["pending_notify"] = False
    t["snooze_until"] = 0
    t["follow_up"] = False
    t["verify_after_time"] = 0
    t["verify_baseline_steps"] = 0
    with open(DATA_FILE, "w") as f:
        f.write("const HEALTH_DATA = " + json.dumps(d, ensure_ascii=False, indent=2) + ";\n")
    return True


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/reset_sedentary"):
            try:
                reset_sedentary()
                body = b"ok"
            except Exception as e:
                body = ("err " + str(e)).encode()
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 9293), Handler).serve_forever()
