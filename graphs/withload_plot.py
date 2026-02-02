import os, re, json, argparse
import math
import matplotlib.pyplot as plt
from plot_style import apply_dark_style

apply_dark_style()

RUNTIME_FILES = {
    "Node.js": "node_withload.json",
    "Deno":    "deno_withload.json",
    "Bun":     "bun_withload.json",
}

RUNTIME_DIRS = {"Node.js": "node", "Deno": "deno", "Bun": "bun"}
# Patterns
BENCH_KEY_RE = re.compile(r"^knitting:\s*primes", re.IGNORECASE)
EXTRA_THREADS_RE = re.compile(r"main\s*\+\s*(\d+)\s*extra\s*threads", re.IGNORECASE)

def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

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

def ns_to_seconds(v):
    # avg values are in ns here
    if isinstance(v, (int, float)):
        return float(v) / 1_000_000_000.0
    try:
        return float(str(v)) / 1_000_000_000.0
    except:
        return math.nan

def extract_series(obj):

    times = {}  # total_threads -> avg seconds

    def scan_rows(rows):
        for r in rows:
            if not isinstance(r, dict): continue
            name = str(r.get("name") or "")
            stats = r.get("stats") or {}
            avg_ns = stats.get("avg")
            t = ns_to_seconds(avg_ns)
            if "main" == name.strip().lower():
                total_threads = 1
            else:
                m = EXTRA_THREADS_RE.search(name)
                if not m: 
                    continue
                extra = int(m.group(1))
                total_threads = 1 + extra
            if not math.isnan(t):
                times[total_threads] = t

    if isinstance(obj, list):
        for section in obj:
            if isinstance(section, dict):
                for k, v in section.items():
                    if BENCH_KEY_RE.search(str(k)) and isinstance(v, list):
                        scan_rows(v)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            if BENCH_KEY_RE.search(str(k)) and isinstance(v, list):
                scan_rows(v)

    return times

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", "-i", default="./results", help="Folder with *_withload.json files")
    ap.add_argument("--out", "-o", default="./charts", help="Output folder for PNGs")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    # Collect per-runtime series
    per_runtime_times = {}  # runtime -> {threads: seconds}
    for runtime, fname in RUNTIME_FILES.items():
        path = resolve_runtime_path(args.input, runtime, fname)
        if not path:
            print(f"[warn] missing {fname} under {args.input}, skipping {runtime}")
            continue
        obj = read_json(path)
        times = extract_series(obj)
        if not times:
            print(f"[warn] no usable rows in {fname}")
            continue
        per_runtime_times[runtime] = dict(sorted(times.items()))

    if not per_runtime_times:
        print("[warn] no runtimes loaded; nothing to plot")
        return

    # Compute speedup & efficiency vs threads for each runtime
    speedup = {}    # runtime -> (threads_list, speedup_list)
    efficiency = {} # runtime -> (threads_list, efficiency_list)
    all_threads = set()

    for runtime, tmap in per_runtime_times.items():
        if 1 not in tmap:
            print(f"[warn] {runtime}: no 'main' baseline found (threads=1); skipping")
            continue
        t1 = tmap[1]
        thr = sorted(tmap.keys())
        spd = [t1 / tmap[n] if (n in tmap and tmap[n] > 0) else math.nan for n in thr]
        eff = [ (t1 / tmap[n]) / n if (n in tmap and tmap[n] > 0) else math.nan for n in thr]
        speedup[runtime] = (thr, spd)
        efficiency[runtime] = (thr, eff)
        all_threads.update(thr)

    if not speedup:
        print("[warn] no speedup data to plot")
        return

    # Plot SPEEDUP
    fig1, ax1 = plt.subplots(figsize=(8, 6))
    for runtime, (thr, spd) in speedup.items():
        ax1.plot(thr, spd, marker="o", linestyle="-", label=runtime)
    # Ideal linear speedup reference
    ideal_thr = sorted(all_threads)
    ax1.plot(ideal_thr, ideal_thr, linestyle="--", label="Ideal linear", alpha=0.7)
    ax1.set_xlabel("Total threads (main + extra)")
    ax1.set_ylabel("Speedup vs 1 thread (×)")
    ax1.set_title("With Load: Speedup vs Threads (primes benchmark)")
    ax1.grid(True, which="both", linestyle="--", alpha=0.5)
    ax1.legend()
    plt.tight_layout()
    out1 = os.path.join(args.out, "withload_speedup.png")
    plt.savefig(out1, dpi=160)
    plt.close()
    print(f"[ok] wrote {out1}")

    # Plot EFFICIENCY
    fig2, ax2 = plt.subplots(figsize=(8, 6))
    for runtime, (thr, eff) in efficiency.items():
        ax2.plot(thr, [e * 100 for e in eff], marker="o", linestyle="-", label=runtime)
    ax2.axhline(100, linestyle="--", alpha=0.7)
    ax2.set_ylim(0, max(110, ax2.get_ylim()[1]))
    ax2.set_xlabel("Total threads (main + extra)")
    ax2.set_ylabel("Parallel efficiency (%)")
    ax2.set_title("With Load: Efficiency vs Threads (primes benchmark)")
    ax2.grid(True, which="both", linestyle="--", alpha=0.5)
    ax2.legend()
    plt.tight_layout()
    out2 = os.path.join(args.out, "withload_efficiency.png")
    plt.savefig(out2, dpi=160)
    plt.close()
    print(f"[ok] wrote {out2}")

if __name__ == "__main__":
    main()
