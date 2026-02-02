#!/usr/bin/env python3
# ipc_plot.py — IPC benchmark (knitting vs worker vs websocket vs http)

import os, re, json, math, argparse
import matplotlib.pyplot as plt
from plot_style import apply_dark_style

apply_dark_style()

RUNTIME_FILES = {
    "Node.js": "node_ipc.json",
    "Deno":    "deno_ipc.json",
    "Bun":     "bun_ipc.json",
}

RUNTIME_DIRS = {"Node.js": "node", "Deno": "deno", "Bun": "bun"}
GROUP_ORDER = ["knitting", "worker", "websocket", "http"]
GROUP_COLORS = {
    "knitting": "#1f77b4",
    "worker": "#ff7f0e",
    "websocket": "#2ca02c",
    "http": "#d62728",
}

# capture "(10)" / "(100)" / "(1000)" or "→ 10"
COUNT_RE = re.compile(r"(?:→\s*|->\s*|\()\s*(\d{1,6})\b")
UNIT_RE  = re.compile(r"([-+]?\d*\.?\d+)\s*(ns|µs|us|ms|s)\b", re.IGNORECASE)

def to_ns(v):
    # Accept numbers (assume ns) or strings w/ units
    if isinstance(v, (int, float)):
        return float(v)
    if not isinstance(v, str):
        return math.nan
    s = v.replace("µ", "u")
    m = UNIT_RE.search(s)
    if not m:
        try:
            return float(s.strip())
        except:
            return math.nan
    num = float(m.group(1)); unit = m.group(2).lower()
    if unit == "ns": return num
    if unit in ("us",): return num * 1000.0
    if unit == "ms": return num * 1_000_000.0
    if unit == "s":  return num * 1_000_000_000.0
    return num

def label_to_count(label: str | None):
    if not label:
        return None
    m = COUNT_RE.search(label)
    return int(m.group(1)) if m else None

def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    if not text.strip():
        raise ValueError(f"empty json file: {path}")
    # Some runtimes print startup logs before JSON; skip to the first JSON token.
    first_obj = text.find("{")
    first_arr = text.find("[")
    starts = [p for p in (first_obj, first_arr) if p != -1]
    if not starts:
        raise ValueError(f"no json object found in: {path}")
    start = min(starts)
    decoder = json.JSONDecoder()
    obj, _ = decoder.raw_decode(text[start:])
    return obj

def resolve_runtime_path(input_dir, runtime, filename):
    runtime_dir = RUNTIME_DIRS.get(runtime, runtime.lower())
    candidates = [
        os.path.join(input_dir, "ms", runtime_dir, filename),
        os.path.join(input_dir, "json", runtime_dir, filename),
        os.path.join(input_dir, runtime_dir, filename),
        os.path.join(input_dir, filename),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None

def iter_sections(obj):
    if isinstance(obj, dict):
        yield obj
    elif isinstance(obj, list):
        for section in obj:
            if isinstance(section, dict):
                yield section

def extract_groups(obj):
    out = {g: {} for g in GROUP_ORDER}  # group -> {count: avg_ns}

    def scan_entries(group_key, entries):
        for entry in entries or []:
            if not isinstance(entry, dict):
                continue
            label = entry.get("label") or entry.get("name") or ""
            stats = entry.get("stats") or {}
            avg = stats.get("avg")
            count = label_to_count(str(label))
            if count is None:
                continue
            avg_ns = to_ns(avg)
            if not math.isnan(avg_ns):
                out[group_key][count] = avg_ns

    for section in iter_sections(obj):
        for key, entries in section.items():
            g = str(key).strip().lower()
            if g in out and isinstance(entries, list):
                scan_entries(g, entries)

    return out

def runtime_title_from_path(path):
    base = os.path.splitext(os.path.basename(path))[0].lower()
    if base.startswith("node_"):
        return "Node.js"
    if base.startswith("deno_"):
        return "Deno"
    if base.startswith("bun_"):
        return "Bun"
    return base.replace("_", " ").title()

def plot_one(path, out_path, title):
    obj = read_json(path)
    groups = extract_groups(obj)

    counts = sorted({c for g in GROUP_ORDER for c in groups[g].keys()})
    if not counts:
        print(f"[warn] {path}: no counts found")
        return False

    x = list(range(len(counts)))
    plt.figure(figsize=(8, 6))
    for group in GROUP_ORDER:
        values = [groups[group].get(c, math.nan) for c in counts]
        if all(math.isnan(v) for v in values):
            continue
        plt.plot(
            x,
            values,
            marker="o",
            linestyle="-",
            color=GROUP_COLORS.get(group),
            label=group,
        )

    plt.yscale("log")
    if 100 in counts:
        plt.axhline(100_000.0, color="#a0a0a0", linestyle=":", linewidth=1.0, alpha=0.7, zorder=0)
        plt.text(0.99, 100_000.0, "100 µs", transform=plt.gca().get_yaxis_transform(),
                 ha="right", va="bottom", fontsize=8, color="#b8b8b8")
    plt.xticks(x, [str(c) for c in counts])
    plt.xlabel("Message count")
    plt.ylabel("Average latency (ns, log scale)")
    plt.title(f"IPC Benchmark — {title}")
    plt.grid(True, which="both", linestyle="--", alpha=0.5)
    plt.legend()
    plt.tight_layout()

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    plt.savefig(out_path, dpi=160)
    plt.close()
    print(f"[ok] wrote {out_path}")
    return True

def plot_combined(items, out_path):
    # items: list of (runtime_title, groups_dict)
    if not items:
        print("[warn] no runtimes to combine")
        return False

    # Single chart: overlay all runtimes, vary marker per runtime and line style per group.
    markers = ["o", "s", "^", "D", "v", "P", "X"]  # cycles if more runtimes
    group_styles = {
        "knitting": "-",
        "worker": "--",
        "websocket": ":",
        "http": "-.",
    }
    fig, ax = plt.subplots(1, 1, figsize=(9, 6))

    all_counts = sorted(
        {c for _, groups in items for g in GROUP_ORDER for c in groups[g].keys()}
    )
    if not all_counts:
        print("[warn] combined chart has no data")
        return False
    x = list(range(len(all_counts)))

    for idx, (title, groups) in enumerate(items):
        marker = markers[idx % len(markers)]
        for group in GROUP_ORDER:
            values = [groups[group].get(c, math.nan) for c in all_counts]
            if all(math.isnan(v) for v in values):
                continue
            ax.plot(
                x,
                values,
                marker=marker,
                linestyle=group_styles.get(group, "-"),
                color=GROUP_COLORS.get(group),
                label=f"{title} — {group}",
            )

    ax.set_yscale("log")
    if 100 in all_counts:
        ax.axhline(100_000.0, color="#a0a0a0", linestyle=":", linewidth=1.0, alpha=0.7, zorder=0)
        ax.text(0.99, 100_000.0, "100 µs", transform=ax.get_yaxis_transform(),
                ha="right", va="bottom", fontsize=8, color="#b8b8b8")
    ax.set_xticks(x)
    ax.set_xticklabels([str(c) for c in all_counts])
    ax.set_xlabel("Message count")
    ax.set_ylabel("Average latency (ns, log scale)")
    ax.grid(True, which="both", linestyle="--", alpha=0.5)

    handles, labels = ax.get_legend_handles_labels()
    if handles:
        ax.legend(handles, labels, loc="upper left", ncol=2, fontsize=8)
    ax.set_title("IPC Benchmark — Combined")
    fig.tight_layout()

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    plt.savefig(out_path, dpi=160)
    plt.close()
    print(f"[ok] wrote {out_path}")
    return True

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", "-i", default="./results", help="File or folder with *_ipc.json")
    ap.add_argument("--out", "-o", default="./charts", help="Output file or directory")
    args = ap.parse_args()

    if os.path.isfile(args.input):
        title = runtime_title_from_path(args.input)
        out_path = args.out
        if not out_path.lower().endswith(".png"):
            os.makedirs(out_path, exist_ok=True)
            base = os.path.splitext(os.path.basename(args.input))[0]
            out_path = os.path.join(out_path, f"{base}.png")
        plot_one(args.input, out_path, title)
        return

    # input is a directory: try the standard runtime filenames
    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)
    any_plotted = False
    combined_items = []
    for runtime, filename in RUNTIME_FILES.items():
        path = resolve_runtime_path(args.input, runtime, filename)
        if not path:
            print(f"[warn] missing {filename} under {args.input}, skipping {runtime}")
            continue
        base = os.path.splitext(filename)[0]
        out_path = os.path.join(out_dir, f"{base}.png")
        ok = plot_one(path, out_path, runtime)
        try:
            combined_items.append((runtime, extract_groups(read_json(path))))
        except Exception as exc:
            print(f"[warn] failed to read {path} for combined plot: {exc}")
        any_plotted = any_plotted or ok

    if not any_plotted:
        print("[warn] no IPC json files found")
        return

    if len(combined_items) > 1:
        combined_out = os.path.join(out_dir, "ipc_combined.png")
        plot_combined(combined_items, combined_out)

if __name__ == "__main__":
    main()
