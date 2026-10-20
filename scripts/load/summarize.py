#!/usr/bin/env python3
"""Сводка по сырым метрикам k6 (--out csv=run.csv.gz): RPS/TPS, TPM, p50/p95/p99, ошибки.

  python3 scripts/load/summarize.py run.csv.gz            # по эндпоинтам за весь прогон
  python3 scripts/load/summarize.py run.csv.gz --windows 80 --offset 20   # по ступеням stress (окна по 80 с)

Запросы setup (создание пула пользователей) исключаются. «Ошибка» = HTTP-статус не 2xx или сетевая ошибка.
"""
import csv, gzip, sys
from collections import defaultdict

def pct(xs, p):
    if not xs: return float("nan")
    xs = sorted(xs); k = (len(xs) - 1) * p / 100; f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)

def tags(row):
    out = {}
    for part in (row.get("extra_tags") or "").split("&"):
        if "=" in part: k, v = part.split("=", 1); out[k] = v
    return out

def main():
    path = sys.argv[1]
    win = int(sys.argv[sys.argv.index("--windows") + 1]) if "--windows" in sys.argv else 0
    off = int(sys.argv[sys.argv.index("--offset") + 1]) if "--offset" in sys.argv else 0
    reqs = []  # (ts, endpoint, dur_ms, ok)
    dropped = []
    with gzip.open(path, "rt") as f:
        for row in csv.DictReader(f):
            m = row["metric_name"]
            if m == "dropped_iterations": dropped.append(int(float(row["timestamp"]))); continue
            if m != "http_req_duration": continue
            t = tags(row)
            if t.get("flow") == "setup" or row.get("group", "").startswith("::setup") or row.get("scenario") == "setup": continue
            st = row.get("status") or "0"
            ok = st.isdigit() and 200 <= int(st) < 300
            reqs.append((int(float(row["timestamp"])), t.get("endpoint") or row.get("name"), float(row["metric_value"]), ok, st))
    if not reqs: print("нет данных"); return
    t0 = min(r[0] for r in reqs); t1 = max(r[0] for r in reqs) + 1
    def line(label, rs, secs):
        d = [r[2] for r in rs]; err = sum(1 for r in rs if not r[3])
        codes = defaultdict(int)
        for r in rs:
            if not r[3]: codes[r[4]] += 1
        print(f"| {label} | {len(rs)} | {len(rs)/secs:.1f} | {len(rs)/secs*60:.0f} | {pct(d,50):.0f} | {pct(d,95):.0f} | {pct(d,99):.0f} | {max(d):.0f} | {100*err/len(rs):.2f}% {dict(codes) if codes else ''} |")
    hdr = "| {} | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |\n|---|---|---|---|---|---|---|---|---|"
    if not win:
        secs = t1 - t0
        print(f"Длительность: {secs} с\n"); print(hdr.format("Эндпоинт"))
        by = defaultdict(list)
        for r in reqs: by[r[1]].append(r)
        for k in sorted(by): line(k, by[k], secs)
        line("**Итого**", reqs, secs)
        print(f"\ndropped_iterations: {len(dropped)}")
        return
    print(hdr.format("Окно (с от старта)") + " dropped |")
    s = t0
    while s < t1:
        a, b = s + off, s + win
        rs = [r for r in reqs if a <= r[0] < b]
        if rs:
            dr = sum(1 for x in dropped if a <= x < b)
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf): line(f"{a-t0}-{b-t0}", rs, b - a)
            print(buf.getvalue().rstrip() + f" {dr} |")
        s += win

main()
