
import os, re, json, math, glob, argparse
import matplotlib.pyplot as plt

COUNT_RE = re.compile(r"\((\d+)\)")
ARROW_SPLIT_RE = re.compile(r"\s*->\s*")

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

def parse_name(name: str):
    """
    Split "string -> (10)" into ("string", 10).
    If not match, returns (cleaned_name, None).
    """
    if not isinstance(name, str):
        return (str(name), None)
    parts = ARROW_SPLIT_RE.split(name.strip(), maxsplit=1)
    base = parts[0].strip()
    count = None
    if len(parts) > 1:
        m = COUNT_RE.search(parts[1])
        if m:
            try:
                count = int(m.group(1))
            except:
                count = None
    return (base, count)

def to_us(v):
    # Values look like raw microseconds already; keep numeric as-is.
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v))
    except:
        return math.nan

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

def collect_by_count(entries):
    """
    entries: list of dicts with fields name, stats.avg
    returns: dict[count] -> dict[type_label] -> avg_us
    """
    out = {}
    for e in entries or []:
        name = e.get("name")
        stats = e.get("stats", {})
        avg = to_us(stats.get("avg"))
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

def plot_one(runtime_title, count, data_map, out_path):
    """
    data_map: label -> dict[type] -> avg_us, labels are Worker, Knitting, Knitting fast
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
    plt.xticks(x, types, rotation=30, ha="right")
    plt.ylabel("Average Latency (µs, log scale)")
    plt.title(f"{runtime_title} — Types Benchmark (count={count})")
    plt.grid(True, which="both", linestyle="--", alpha=0.5)
    plt.legend()
    plt.tight_layout()
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    plt.savefig(out_path, dpi=160)
    plt.close()
    print(f"[ok] wrote {out_path}")
    return True

def process_file(path, out_dir):
    groups = read_types_file(path)
    base = os.path.splitext(os.path.basename(path))[0]  # e.g., node_types
    runtime_title = base.replace("_", " ").title()      # "Node_Types" -> "Node Types"

    worker_by_count   = collect_by_count(groups.get("worker", []))
    knit_by_count     = collect_by_count(groups.get("knitting", []))
    knitfast_by_count = collect_by_count(groups.get("knitting fast", []))

    any_plotted = False
    for count in (1, 10, 100):
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

    if not any_plotted:
        print(f"[warn] {path}: nothing plotted (no counts found)")

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

    for path in files:
        process_file(path, args.out)

if __name__ == "__main__":
    main()

