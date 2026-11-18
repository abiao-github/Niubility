#!/usr/bin/env python3
"""给本机 Prowlarr 的所有 indexer 测速，列出慢的/坏的，方便决定删哪些。

用法：
    python3 scripts/prowlarr-bench.py            # 默认测 "ubuntu" 和 "巨人"
    python3 scripts/prowlarr-bench.py 关键词1 关键词2

阈值：任一关键词超过 SLOW_SECONDS 秒、或报错，标记为 ❌ 建议删除。
删除命令会打印出来（不自动删）。
"""
import json, os, re, sys, time, urllib.parse, urllib.request

SLOW_SECONDS = 6.0
DELAY_SECONDS = 2.5   # 每次查询之间歇一下，否则站点限速会给出假的“超时”
BASE = "http://127.0.0.1:9696/api/v1"
CFG = os.path.expanduser("~/Library/Application Support/Prowlarr/config.xml")


def api_key():
    with open(CFG) as f:
        m = re.search(r"<ApiKey>([^<]+)</ApiKey>", f.read())
    if not m:
        sys.exit("读不到 Prowlarr API Key：" + CFG)
    return m.group(1)


KEY = api_key()


def get(path, timeout=30):
    req = urllib.request.Request(BASE + path, headers={"X-Api-Key": KEY})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode() or "[]"), time.time() - t0
    except Exception:
        return None, time.time() - t0


def main():
    queries = sys.argv[1:] or ["ubuntu", "巨人"]
    indexers, _ = get("/indexer")
    if not indexers:
        sys.exit("拿不到 indexer 列表（Prowlarr 没起来？）")

    print(f"共 {len(indexers)} 个 indexer，关键词: {queries}，阈值 {SLOW_SECONDS}s\n")
    bad = []
    for x in indexers:
        times, counts = [], []
        for q in queries:
            res, dt = get(
                f"/search?query={urllib.parse.quote(q)}&type=search&limit=10&indexerIds={x['id']}",
                timeout=25,
            )
            times.append(dt)
            counts.append(len(res) if isinstance(res, list) else -1)
            time.sleep(DELAY_SECONDS)   # 连续猛打会触发站点限速，测出来的超时是假的
        slow = max(times) > SLOW_SECONDS or any(c < 0 for c in counts)
        cells = "   ".join(f"{t:5.1f}s/{c:>3}条" for t, c in zip(times, counts))
        print(f"  {'❌' if slow else '✅'} {x['name']:<20} {cells}")
        if slow:
            bad.append((x["name"], x["id"]))

    if bad:
        print("\n建议剔除（先确认它们是不是偶尔抽风）：")
        for name, i in bad:
            print(f"  #{name}")
            print(f"  curl -X DELETE -H \"X-Api-Key: {KEY}\" {BASE}/indexer/{i}")
    else:
        print("\n都很健康 👍")


if __name__ == "__main__":
    main()
