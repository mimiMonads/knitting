#!/usr/bin/env python3
# multi_line.py — Worker vs Knitting (Multi test: 4 threads, complex JSON)

import re, os, json, math, argparse
import matplotlib.pyplot as plt
from plot_style import apply_dark_style

apply_dark_style()

RUNTIME_FILES = {
    "Node.js": "node_multi.json",
    "Deno":    "deno_multi.json",
    "Bun":     "bun_multi.json",
}

RUNTIME_COLORS = {"Node.js": "#1f77b4", "Deno": "#2ca02c", "Bun": "#d62728"}
KNIT_COLORS    = {"Node.js": "#aec7e8",  "Deno": "#98df8a", "Bun": "#ff9896"}

# capture "(10)" / "(100)" / "(1000)" or "→ 10"
COUNT_RE = re.compile(r"(?:→\s*|->\s*|\()\s*(\d{1,5})\b")
UNIT_RE  = re.compile(r"([-+]?\d*\.?\d+)\s*(ns|µs|us|ms|s)\b", re.IGNORECASE)

def to_us(v):
    # Accept numbers (assume ns) or strings w/ units
    if isinstance(v, (int, float)):
        return float(v) / 1000.0
    if not isinstance(v, str):
        return math.nan
    s = v.replace("µ", "u")
    m = UNIT_RE.search(s)
    if not m:
        try: return float(s.strip()) / 1000.0
        except: return math.nan
    num = float(m.group(1)); unit = m.group(2).lower()
    if unit == "ns": return num / 1000.0
    if unit in ("us",): return num
    if unit == "ms": return num * 1000.0
    if unit == "s":  return num * 1_000_000.0
    return num

def label_to_count(label: str | None):
    if not label: return None
    m = COUNT_RE.search(label)
    return int(m.group(1)) if m else None

def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def extract_rows(obj):
    """Return {'worker': [(label, avg_us), ...], 'knitting': [...]}.
       Handles array-of-sections where only the last includes 'knitting'."""
    rows = {"worker": [], "knitting": []}

    def push(group, label, avg):
        g = (group or "").lower()
        if g in rows and avg is not None:
            rows[g].append((str(label or ""), to_us(avg)))

    def scan_entry_dict(d, group_hint=None):
        if not isinstance(d, dict): return
        label = d.get("label") or d.get("name") or ""
        avg = d.get("avg") or d.get("average") or d.get("mean")
        if avg is None and isinstance(d.get("stats"), dict):
            avg = d["stats"].get("avg")  # your dumps store ns here; to_us() will convert
        g = (d.get("group") or d.get("mode") or group_hint or "").lower()
        if g not in ("worker", "knitting"):
            low = str(label).lower()
            if "worker" in low: g = "worker"
            elif "knitting" in low: g = "knitting"
        push(g, label, avg)

    def scan_array(arr, group_hint=None):
        for item in arr:
            scan_entry_dict(item, group_hint=group_hint)

    if isinstance(obj, dict):
        for g in ("worker", "knitting"):
            if isinstance(obj.get(g), list):
                scan_array(obj[g], group_hint=g)
        if isinstance(obj.get("entries"), list):
            scan_array(obj["entries"])
    elif isinstance(obj, list):
        for section in obj:
            if isinstance(section, dict):
                for g in ("worker", "knitting"):
                    if isinstance(section.get(g), list):
                        scan_array(section[g], group_hint=g)
                if isinstance(section.get("entries"), list):
                    scan_array(section["entries"])
    return rows

def align_by_count(rows):
    w_map, k_map = {}, {}
    for lab, avg in rows["worker"]:
        c = label_to_count(lab)
        if c is not None and not math.isnan(avg): w_map[c] = avg
    for lab, avg in rows["knitting"]:
        c = label_to_count(lab)
        if c is not None and not math.isnan(avg): k_map[c] = avg
    common = sorted(set(w_map) & set(k_map))
    if common:
        return [f"{c} msgs" for c in common], [w_map[c] for c in common], [k_map[c] for c in common]
    # fallback: index align
    n = min(len(rows["worker"]), len(rows["knitting"]))
    return [str(i+1) for i in range(n)], [rows["worker"][i][1] for i in range(n)], [rows["knitting"][i][1] for i in range(n)]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", "-i", default="./results", help="folder with *_multi.json")
    ap.add_argument("--out", "-o", default="./charts/multi_line.png", help="output PNG path")
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    fig, ax = plt.subplots(figsize=(8, 6))
    x_labels_ref = None

    for runtime, filename in RUNTIME_FILES.items():
        path = os.path.join(args.input, filename)
        if not os.path.isfile(path):
            print(f"[warn] missing {path}, skipping {runtime}")
            continue
        rows = extract_rows(read_json(path))
        labels, w_vals, k_vals = align_by_count(rows)
        if not labels:
            print(f"[warn] {filename}: no aligned points")
            continue
        x = list(range(len(labels)))
        if x_labels_ref is None:
            x_labels_ref = labels
        ax.plot(x, w_vals, marker="o", linestyle="-",
                color=RUNTIME_COLORS[runtime], label=f"{runtime} Worker")
        ax.plot(x, k_vals, marker="o", linestyle="--",
                color=KNIT_COLORS[runtime], label=f"{runtime} Knitting")

    ax.set_yscale("log")
    ax.set_ylabel("Average Latency (µs, log scale)")
    ax.set_title("Multi Benchmark (4 threads): Worker vs Knitting")
    if x_labels_ref:
        ax.set_xticks(list(range(len(x_labels_ref))))
        ax.set_xticklabels(x_labels_ref)
    ax.legend(ncol=2)
    ax.grid(True, which="both", linestyle="--", alpha=0.5)
    plt.tight_layout()
    plt.savefig(args.out, dpi=160)
    print(f"[ok] wrote {args.out}")

if __name__ == "__main__":
    main()
