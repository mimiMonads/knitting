
import os, re, json, math, glob, argparse
import matplotlib.pyplot as plt
from plot_style import apply_dark_style, DARK_BG_RGB

apply_dark_style()

COUNT_RE = re.compile(r"(?:\(|→\s*|->\s*)\s*(\d+)\s*\)?\s*$")
ARROW_SUFFIX_RE = re.compile(r"(?:->|→)\s*$")
UNIT_RE = re.compile(r"([-+]?\d*\.?\d+)\s*(ns|µs|us|ms|s)\b", re.IGNORECASE)

# Keep a stable, human-friendly order for type labels
PREFERRED_TYPE_ORDER = [
    "string", "large string",
    "number",
    "min bigint", "max bigint",
    "boolean true", "boolean false",
    "void",
    "small array", "big Array",
    "object", "big object",
]

from PIL import Image

GROUP_ORDER = ["Worker", "Knitting", "Knitting Fast"]
GROUP_COLORS = {
    "Worker": "#1f77b4",
    "Knitting": "#ff7f0e",
    "Knitting Fast": "#2ca02c",
}

def _stitch_images_horizontally(img_paths, out_path, padding=16, bg=DARK_BG_RGB):
    """Open images, scale to the same height, and stitch horizontally with padding."""
    images = []
    for p in img_paths:
        if os.path.exists(p):
            try:
                images.append(Image.open(p).convert("RGB"))
            except Exception as e:
                print(f"[warn] could not open {p}: {e}")
    if not images:
        print(f"[warn] montage: none of {img_paths} exists")
        return False

    # target height = min of heights to avoid upscaling; resize widths proportionally
    target_h = min(img.height for img in images)
    resized = []
    for img in images:
        if img.height != target_h:
            w = int(img.width * (target_h / img.height))
            img = img.resize((w, target_h), Image.BICUBIC)
        resized.append(img)

    total_w = sum(img.width for img in resized) + padding * (len(resized) - 1)
    canvas = Image.new("RGB", (total_w, target_h), bg)
    x = 0
    for i, img in enumerate(resized):
        canvas.paste(img, (x, 0))
        x += img.width + (padding if i < len(resized) - 1 else 0)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    canvas.save(out_path, quality=92)
    print(f"[ok] wrote {out_path}")
    return True

def parse_name(name: str):
    """
    Extract ("string", 10) from labels like:
      - "string -> (10)"
      - "string (10)"
      - "string → 10"
    """
    if not isinstance(name, str):
        name = str(name)
    s = name.strip()
    if not s:
        return ("", None)
    m = COUNT_RE.search(s)
    count = None
    base = s
    if m:
        try:
            count = int(m.group(1))
        except:
            count = None
        base = s[:m.start()].strip()
        base = ARROW_SUFFIX_RE.sub("", base).strip()
        if not base:
            base = s
    return (base, count)

def to_ns(v):
    # Mitata stats are in nanoseconds; keep in nanoseconds.
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

def read_types_file(path):
    with open(path, "r", encoding="utf-8") as f:
        obj = json.load(f)
    # Expected groups
    groups = {}
    for key in obj.keys():
        lk = key.lower().strip()
        if lk.startswith("knitting fast"):
            groups["knitting fast"] = obj[key]
        elif lk.startswith("knitting"):
            groups["knitting"] = obj[key]
        elif lk.startswith("worker"):
            groups["worker"] = obj[key]
    return groups

def runtime_title_from_path(path: str):
    base = os.path.splitext(os.path.basename(path))[0].lower()
    if base.startswith("node_"):
        return "Node.js"
    if base.startswith("deno_"):
        return "Deno"
    if base.startswith("bun_"):
        return "Bun"
    return base.replace("_", " ").title()

def collect_by_count(entries):
    """
    entries: list of dicts with fields name, stats.avg
    returns: dict[count] -> dict[type_label] -> avg_ns
    """
    out = {}
    for e in entries or []:
        name = e.get("name")
        stats = e.get("stats", {})
        avg = to_ns(stats.get("avg"))
        typ, cnt = parse_name(name or "")
        if cnt is None or math.isnan(avg):
            continue
        out.setdefault(cnt, {})[typ] = avg
    return out

def aligned_type_list(*dicts):
    """
    Given multiple dict[type] -> value, return a merged, stable-ordered list of types
    present in at least one dict, following PREFERRED_TYPE_ORDER first, then others.
    """
    all_types = set()
    for d in dicts:
        all_types.update(list(d.keys()))
    ordered = [t for t in PREFERRED_TYPE_ORDER if t in all_types]
    others = sorted([t for t in all_types if t not in PREFERRED_TYPE_ORDER])
    return ordered + others

def available_counts(*maps):
    counts = set()
    for m in maps:
        counts.update(m.keys())
    return sorted(counts)

def plot_one(runtime_title, count, data_map, out_path):
    """
    data_map: label -> dict[type] -> avg_ns, labels are Worker, Knitting, Knitting fast
    """
    types = aligned_type_list(*data_map.values())
    if not types:
        print(f"[warn] {runtime_title} (count={count}): no types to plot")
        return False

    x = list(range(len(types)))
    plt.figure(figsize=(10, 6))
    for label, tmap in data_map.items():
        y = [tmap.get(t, math.nan) for t in types]
        plt.plot(x, y, marker="o", linestyle="-", label=label)

    plt.yscale("log")
    if count == 1:
        plt.axhline(1_000.0, color="#a0a0a0", linestyle=":", linewidth=1.0, alpha=0.7, zorder=0)
        plt.text(0.99, 1_000.0, "1 µs", transform=plt.gca().get_yaxis_transform(),
                 ha="right", va="bottom", fontsize=8, color="#b8b8b8")
    elif count == 100:
        plt.axhline(100_000.0, color="#a0a0a0", linestyle=":", linewidth=1.0, alpha=0.7, zorder=0)
        plt.text(0.99, 100_000.0, "100 µs", transform=plt.gca().get_yaxis_transform(),
                 ha="right", va="bottom", fontsize=8, color="#b8b8b8")
    plt.xticks(x, types, rotation=30, ha="right")
    plt.ylabel("Average Latency (ns, log scale)")
    plt.title(f"{runtime_title} — Types Benchmark (count={count})")
    plt.grid(True, which="both", linestyle="--", alpha=0.5)
    plt.legend()
    plt.tight_layout()
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    plt.savefig(out_path, dpi=160)
    plt.close()
    print(f"[ok] wrote {out_path}")
    return True

def plot_combined(count, items, out_path):
    """
    items: list of (runtime_title, worker_by_count, knit_by_count, knitfast_by_count)
    """
    if not items:
        return False

    # Build maps for this count
    per_runtime = []
    for title, w_map, k_map, kf_map in items:
        dm = {}
        if count in w_map:
            dm["Worker"] = w_map[count]
        if count in k_map:
            dm["Knitting"] = k_map[count]
        if count in kf_map:
            dm["Knitting Fast"] = kf_map[count]
        if dm:
            per_runtime.append((title, dm))

    if not per_runtime:
        return False

    types = aligned_type_list(
        *[tmap for _, dm in per_runtime for tmap in dm.values()]
    )
    if not types:
        return False

    markers = ["o", "s", "^", "D", "v", "P", "X"]
    group_styles = {
        "Worker": "-",
        "Knitting": "--",
        "Knitting Fast": ":",
    }

    x = list(range(len(types)))
    fig, ax = plt.subplots(1, 1, figsize=(10, 6))
    for idx, (title, dm) in enumerate(per_runtime):
        marker = markers[idx % len(markers)]
        for group in GROUP_ORDER:
            tmap = dm.get(group)
            if not tmap:
                continue
            y = [tmap.get(t, math.nan) for t in types]
            if all(math.isnan(v) for v in y):
                continue
            ax.plot(
                x,
                y,
                marker=marker,
                linestyle=group_styles.get(group, "-"),
                color=GROUP_COLORS.get(group),
                label=f"{title} — {group}",
            )

    ax.set_yscale("log")
    if count == 1:
        ax.axhline(1_000.0, color="#a0a0a0", linestyle=":", linewidth=1.0, alpha=0.7, zorder=0)
        ax.text(0.99, 1_000.0, "1 µs", transform=ax.get_yaxis_transform(),
                ha="right", va="bottom", fontsize=8, color="#b8b8b8")
    elif count == 100:
        ax.axhline(100_000.0, color="#a0a0a0", linestyle=":", linewidth=1.0, alpha=0.7, zorder=0)
        ax.text(0.99, 100_000.0, "100 µs", transform=ax.get_yaxis_transform(),
                ha="right", va="bottom", fontsize=8, color="#b8b8b8")
    ax.set_xticks(x)
    ax.set_xticklabels(types, rotation=30, ha="right")
    ax.set_ylabel("Average Latency (ns, log scale)")
    ax.set_title(f"Types Benchmark — Combined (count={count})")
    ax.grid(True, which="both", linestyle="--", alpha=0.5)

    handles, labels = ax.get_legend_handles_labels()
    if handles:
        ax.legend(handles, labels, ncol=2, fontsize=8)

    fig.tight_layout()
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    plt.savefig(out_path, dpi=160)
    plt.close()
    print(f"[ok] wrote {out_path}")
    return True

def process_file(path, out_dir):
    groups = read_types_file(path)
    base = os.path.splitext(os.path.basename(path))[0]
    runtime_title = runtime_title_from_path(path)

    worker_by_count = collect_by_count(groups.get("worker", []))
    knit_by_count = collect_by_count(groups.get("knitting", []))
    knitfast_by_count = collect_by_count(groups.get("knitting fast", []))

    any_plotted = False
    out_paths = []

    counts = available_counts(worker_by_count, knit_by_count, knitfast_by_count)
    for count in counts:
        dm = {}
        if count in worker_by_count:
            dm["Worker"] = worker_by_count[count]
        if count in knit_by_count:
            dm["Knitting"] = knit_by_count[count]
        if count in knitfast_by_count:
            dm["Knitting Fast"] = knitfast_by_count[count]
        if not dm:
            continue
        out_path = os.path.join(out_dir, f"{base}_types_count{count}.png")
        ok = plot_one(runtime_title, count, dm, out_path)
        any_plotted = any_plotted or ok
        if ok:
            out_paths.append(out_path)

    if not any_plotted:
        print(f"[warn] {path}: nothing plotted (no counts found)")
        return

    # Build a “container” image that shows all counts at once (skip any missing)
    montage_out = os.path.join(out_dir, f"{base}_types_all.png")
    _stitch_images_horizontally(out_paths, montage_out)
    return (runtime_title, worker_by_count, knit_by_count, knitfast_by_count)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", "-i", default="./results", help="Folder with *_types.json files")
    ap.add_argument("--out", "-o", default="./charts", help="Output directory for charts")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    files = sorted(glob.glob(os.path.join(args.input, "*_types.json")))
    if not files:
        print(f"[warn] no *_types.json found in {args.input}")
        return

    combined_items = []
    for path in files:
        data = process_file(path, args.out)
        if data:
            combined_items.append(data)

    # Combined chart across runtimes (per count), plus montage across counts.
    if len(combined_items) > 1:
        all_maps = []
        for _, w_map, k_map, kf_map in combined_items:
            all_maps.extend([w_map, k_map, kf_map])
        all_counts = available_counts(*all_maps)
        combined_paths = []
        for count in all_counts:
            out_path = os.path.join(args.out, f"types_combined_count{count}.png")
            if plot_combined(count, combined_items, out_path):
                combined_paths.append(out_path)
        if combined_paths:
            montage_out = os.path.join(args.out, "types_combined_all.png")
            _stitch_images_horizontally(combined_paths, montage_out)

if __name__ == "__main__":
    main()
