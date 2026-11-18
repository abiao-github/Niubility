#!/usr/bin/env bash
# 把服务器上的 DHT 索引服务（127.0.0.1:8899）映射到本机同端口。
# 用法：bash scripts/index-tunnel.sh {start|stop|status}
set -euo pipefail

HOST_ALIAS="${INDEX_SSH_HOST:-OpticServer}"
LOCAL_PORT="${INDEX_LOCAL_PORT:-8899}"
REMOTE="127.0.0.1:8899"
PLIST="$HOME/Library/LaunchAgents/com.niubility.index-tunnel.plist"
LABEL="com.niubility.index-tunnel"

case "${1:-status}" in
  start)
    pkill -f "ssh -N -o ExitOnForwardFailure=yes -L ${LOCAL_PORT}:${REMOTE}" 2>/dev/null || true
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string>
    <string>-N</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>ServerAliveInterval=30</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-L</string><string>${LOCAL_PORT}:${REMOTE}</string>
    <string>${HOST_ALIAS}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/niubility-index-tunnel.log</string>
  <key>StandardErrorPath</key><string>/tmp/niubility-index-tunnel.log</string>
</dict>
</plist>
PLISTEOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"
    sleep 2
    echo "隧道已启动：127.0.0.1:${LOCAL_PORT} → ${HOST_ALIAS} ${REMOTE}"
    ;;
  stop)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "隧道已停止"
    ;;
  status)
    if pgrep -f "ssh -N .*${LOCAL_PORT}:${REMOTE}" >/dev/null; then
      echo "隧道运行中：127.0.0.1:${LOCAL_PORT}"
    else
      echo "隧道未运行"
    fi
    ;;
  *)
    echo "用法: $0 {start|stop|status}" >&2
    exit 1
    ;;
esac
