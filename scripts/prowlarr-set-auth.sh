#!/usr/bin/env bash
# 给本机 Prowlarr 设置/重置登录账号（Prowlarr 3.x 不允许“无认证”）。
# 用法：bash scripts/prowlarr-set-auth.sh [用户名]
# 密码会以交互方式读取，不落盘、不进 shell 历史。
set -euo pipefail

CFG="$HOME/Library/Application Support/Prowlarr/config.xml"
[ -f "$CFG" ] || { echo "找不到 $CFG，Prowlarr 装了吗？" >&2; exit 1; }

KEY=$(python3 - "$CFG" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
m = re.search(r'<ApiKey>([^<]+)</ApiKey>', s)
print(m.group(1) if m else '')
PY
)
[ -n "$KEY" ] || { echo "读不到 API Key" >&2; exit 1; }

USER_NAME="${1:-admin}"
read -r -s -p "给 Prowlarr 设置密码（输入时不显示）: " PASSWORD; echo
[ ${#PASSWORD} -ge 8 ] || { echo "Prowlarr 要求密码至少 8 位" >&2; exit 1; }

python3 - "$KEY" "$USER_NAME" "$PASSWORD" <<'PY'
import json, sys, urllib.request
key, user, pwd = sys.argv[1], sys.argv[2], sys.argv[3]
base = "http://127.0.0.1:9696/api/v1"
hdr = {"X-Api-Key": key, "Content-Type": "application/json"}

cfg = json.loads(urllib.request.urlopen(urllib.request.Request(base + "/config/host", headers=hdr), timeout=20).read())
cfg["authenticationMethod"] = "forms"
cfg["authenticationRequired"] = "enabled"
cfg["username"] = user
cfg["password"] = pwd
cfg["passwordConfirmation"] = pwd

req = urllib.request.Request(base + "/config/host", data=json.dumps(cfg).encode(), method="PUT", headers=hdr)
try:
    with urllib.request.urlopen(req, timeout=25) as r:
        print("写入成功，HTTP", r.status)
except urllib.error.HTTPError as e:
    print("失败:", e.code, e.read().decode()[:300]); sys.exit(1)
PY

echo "重启 Prowlarr…"
launchctl kickstart -k "gui/$(id -u)/com.niubility.prowlarr" 2>/dev/null || true
sleep 15
curl -sS -m 5 -o /dev/null -w "首页=%{http_code}  登录页=%{http_code}\n" http://127.0.0.1:9696/ 2>/dev/null || true
echo "账号：${USER_NAME}（密码是你刚输入的那个）"
