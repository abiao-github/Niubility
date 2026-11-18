#!/usr/bin/env bash
# 在服务器上安装/更新 牛逼BT 的 DHT 索引服务（不需要 root）。
# 用法（在服务器上执行）：
#   INDEX_TOKEN=xxxx bash server-install.sh
# 幂等：重复执行会更新代码、重启服务。
set -euo pipefail

ROOT="${INDEX_ROOT:-$HOME/niubility-index}"
TOKEN="${INDEX_TOKEN:-}"
PORT="${INDEX_PORT:-8899}"
DHT_PORT="${DHT_PORT:-6881}"

[ -n "$TOKEN" ] || { echo "[install] 必须设置 INDEX_TOKEN" >&2; exit 1; }

mkdir -p "$ROOT"
cd "$ROOT"

# ---------- 1. Node 运行时（免 root） ----------
if [ ! -x "$ROOT/runtime/bin/node" ]; then
  echo "[install] 下载 Node 运行时…"
  LIST=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -oE 'node-v[0-9.]+-linux-x64\.tar\.gz' | head -1)
  if [ -z "$LIST" ]; then echo "[install] 取不到 Node 版本列表" >&2; exit 1; fi
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$LIST" -o /tmp/node.tar.gz
  rm -rf "$ROOT/runtime" && mkdir -p "$ROOT/runtime"
  tar -xzf /tmp/node.tar.gz -C "$ROOT/runtime" --strip-components=1
  rm -f /tmp/node.tar.gz
fi
NODE="$ROOT/runtime/bin/node"
NPM="$ROOT/runtime/bin/npm"
echo "[install] node $($NODE -v)"

# ---------- 2. 依赖 ----------
cd "$ROOT/indexer"
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  echo "[install] 安装依赖（bittorrent-dht / webtorrent）…"
  PATH="$ROOT/runtime/bin:$PATH" "$NPM" install --omit=dev --no-audit --no-fund 2>&1 | tail -3
fi

# ---------- 3. 启动脚本 ----------
cat > "$ROOT/start.sh" <<EOS
#!/usr/bin/env bash
# 看门狗：node 挂掉就 3 秒后重来（DHT 爬虫长期跑，偶发崩溃不该让服务消失）
cd "$ROOT/indexer"
export INDEX_PORT=$PORT
export INDEX_HOST=127.0.0.1
export INDEX_TOKEN=$TOKEN
export DHT_PORT=$DHT_PORT
export DHT_WORKERS=\${DHT_WORKERS:-4}
export INDEX_DB=$ROOT/index.jsonl.gz

# 防止重复启动（同一时间只留一份）
LOCK="$ROOT/.lock"
exec 9>"\$LOCK"
if ! flock -n 9; then echo "已有一个实例在跑，退出" ; exit 0; fi

while true; do
  echo $$ > "$ROOT/index.pid"
  "$ROOT/runtime/bin/node" --max-old-space-size=\${INDEX_HEAP_MB:-12288} run.js >> "$ROOT/index.log" 2>&1
  code=\$?
  echo "\$(date -Is) [watchdog] node 退出 code=\$code，3 秒后重启" >> "$ROOT/index.log"
  sleep 3
done
EOS
chmod +x "$ROOT/start.sh"

# ---------- 4. 重启服务 ----------
# 注意：start.sh 是看门狗，只杀它会留下孤儿子进程占着 UDP 端口，
# 新实例会 EADDRINUSE 死循环。所以 node 和 start.sh 都要杀干净。
pkill -f "$ROOT/runtime/bin/node run.js" 2>/dev/null || true
pkill -f "$ROOT/start.sh" 2>/dev/null || true
sleep 2
pkill -9 -f "$ROOT/runtime/bin/node run.js" 2>/dev/null || true
pkill -9 -f "$ROOT/start.sh" 2>/dev/null || true
sleep 1
nohup "$ROOT/start.sh" >/dev/null 2>&1 &
echo $! > "$ROOT/index.pid"
sleep 3

# ---------- 5. 开机自启（用户 crontab，不需要 root） ----------
# 注意：新账号 `crontab -l` 会返回非 0，配合 set -o pipefail 会直接中断脚本，必须 || true
set +e
if command -v crontab >/dev/null 2>&1; then
  CUR="$(crontab -l 2>/dev/null || true)"
  {
    printf '%s\n' "$CUR" | grep -v 'niubility-index/start.sh' || true
    printf '@reboot %s/start.sh >/dev/null 2>&1\n' "$ROOT"
  } | crontab - 2>/dev/null && echo "[install] 已写入 crontab @reboot" || echo "[install] crontab 写入失败（不影响运行，可手动加）"
fi
set -e

# ---------- 6. 自检 ----------
sleep 1
if curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health" >/dev/null; then
  echo "[install] 服务已就绪：http://127.0.0.1:$PORT"
  curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/stats" || true
  echo
else
  echo "[install] 启动失败，日志末尾：" >&2
  tail -20 "$ROOT/index.log" >&2 || true
  exit 1
fi
