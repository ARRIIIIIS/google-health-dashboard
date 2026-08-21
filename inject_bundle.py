#!/usr/bin/env python3
"""Read ball-bundle.html and inject as a string field into JSON on stdin."""
import json
import sys

try:
    raw = sys.stdin.read() or "{}"
    data = json.loads(raw)
except Exception:
    data = {}

try:
    with open('/Users/dfrobot/google-health-dashboard/ball-bundle.html', 'r', encoding='utf-8') as f:
        data['ball_bundle'] = f.read()
except Exception:
    pass

sys.stdout.write(json.dumps(data))
