#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Build frozen sources and compare buffer IPC with Unix domain sockets."""

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shlex
import shutil
import statistics
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CORE = ["mapping.cpp", "buffer.cpp", "sender.cpp", "receiver.cpp"]
FLAGS = ["-O3", "-std=c++20", "-Wall", "-Wextra", "-Wpedantic", "-Werror"]
METRICS = [
    "calls_per_second",
    "batch_p50_us",
    "batch_p99_us",
    "cpu_us_per_call",
    "seconds",
]


@dataclass(frozen=True)
class Variant:
    name: str
    binary: str
    driver_mode: str
    queue_slots: int | None


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def version(command):
    return subprocess.check_output(command, text=True).splitlines()[0]


def options():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, required=True, help="new artifact directory"
    )
    parser.add_argument(
        "--wide", action="store_true", help="include 64-slot IPC and batches of 64"
    )
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument(
        "--lto", action="store_true", help="enable C++ link-time optimization"
    )
    parser.add_argument(
        "--seconds", type=float, default=0.35, help="target measured seconds per run"
    )
    parser.add_argument(
        "--cpus", help="host,worker CPU IDs; defaults to first two permitted CPUs"
    )
    parser.add_argument(
        "--smoke", action="store_true", help="short correctness runs; no speed claims"
    )
    args = parser.parse_args()
    if args.repetitions < 1 or not math.isfinite(args.seconds) or args.seconds <= 0:
        parser.error("repetitions and seconds must be positive and finite")
    allowed = sorted(os.sched_getaffinity(0))
    try:
        cpus = list(map(int, args.cpus.split(","))) if args.cpus else allowed[:2]
    except ValueError:
        parser.error("--cpus expects two integer CPU IDs separated by a comma")
    if len(cpus) != 2 or cpus[0] == cpus[1] or any(cpu not in allowed for cpu in cpus):
        parser.error("select two distinct CPUs in the process affinity mask")
    args.output = args.output.resolve()
    return args, cpus, allowed


def prepare(args, cpus, allowed):
    args.output.mkdir(parents=True, exist_ok=False)
    source = args.output / "source"
    sources = [*ROOT.glob("*.hpp"), *ROOT.glob("*.cpp"), ROOT / "Makefile"]
    sources += [
        *Path(__file__).parent.glob("*.cpp"),
        *Path(__file__).parent.glob("*.hpp"),
        *Path(__file__).parent.glob("*.py"),
    ]
    hashes = {}
    for path in sorted(sources):
        relative = path.relative_to(ROOT)
        destination = source / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
        hashes[str(relative)] = digest(destination)

    compiler = shlex.split(os.environ.get("CXX", "g++"))
    binaries = args.output / "binaries"
    binaries.mkdir()
    widths = [32, 64] if args.wide else [32]
    commands, variants = [], []
    with (args.output / "build.log").open("w") as log:
        for width in widths:
            binary = binaries / f"ipc{width}"
            command = [
                *compiler,
                *FLAGS,
                *(["-flto"] if args.lto else []),
                f"-DKNITTING_IPC_QUEUE_SLOTS={width}",
                "-I",
                str(source),
                *[str(source / name) for name in CORE],
                str(source / "benchmarks/benchmark.cpp"),
                str(source / "benchmarks/checksum.cpp"),
                "-o",
                str(binary),
            ]
            commands.append(command)
            subprocess.run(command, stdout=log, stderr=log, check=True)
            strategies = ["copy", "direct"]
            for strategy in strategies:
                variants.append(
                    Variant(
                        f"ipc{width}-{strategy}", str(binary), f"ipc-{strategy}", width
                    )
                )
        for strategy in ["copy", "direct"]:
            variants.append(
                Variant(f"uds-{strategy}", str(binaries / "ipc32"), f"uds-{strategy}", 32)
            )

    metadata = {
        "schema_version": 1,
        "utc": datetime.now(timezone.utc).isoformat(),
        "platform": platform.platform(),
        "cpuinfo": Path("/proc/cpuinfo").read_text(),
        "cpus": cpus,
        "allowed_cpus": allowed,
        "compiler": version([*compiler, "--version"]),
        "build_commands": commands,
        "source_sha256": hashes,
        "binary_sha256": {p.name: digest(p) for p in binaries.iterdir()},
        "variants": [asdict(v) for v in variants],
        "commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip(),
        "git_status": subprocess.check_output(
            ["git", "status", "--short"], cwd=ROOT, text=True
        ),
        "options": {**vars(args), "output": str(args.output)},
    }
    (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    return variants, metadata


def measure(args, cpus, variants):
    runs = args.output / "runs"
    runs.mkdir()
    sequence = 0

    def run(variant, size, window, rounds, phase, repetition=None):
        nonlocal sequence
        sequence += 1
        prefix = runs / f"{sequence:05d}"
        command = [
            variant.binary,
            variant.driver_mode,
            str(size),
            str(window),
            str(rounds),
            *map(str, cpus),
        ]
        record = {"command": command, "phase": phase, "repetition": repetition}
        prefix.with_suffix(".json").write_text(json.dumps(record, indent=2) + "\n")
        with prefix.with_suffix(".stdout.log").open("w") as out, prefix.with_suffix(
            ".stderr.log"
        ).open("w") as err:
            completed = subprocess.run(command, stdout=out, stderr=err, timeout=95)
        if completed.returncode:
            raise RuntimeError(
                f"run {sequence} failed ({completed.returncode}); see {prefix}.stderr.log"
            )
        row = json.loads(prefix.with_suffix(".stdout.log").read_text())
        if (
            row["mode"],
            row["bytes"],
            row["window"],
            row["rounds"],
            row["validated_calls"],
        ) != (variant.driver_mode, size, window, rounds, rounds * window):
            raise RuntimeError(f"run {sequence}: result does not match invocation")
        if (
            variant.queue_slots is not None
            and row["queue_slots"] != variant.queue_slots
        ):
            raise RuntimeError(f"run {sequence}: incorrect queue width")
        if any(not math.isfinite(row[key]) or row[key] <= 0 for key in METRICS):
            raise RuntimeError(f"run {sequence}: invalid timing metrics")
        row.update(mode=variant.name, repetition=repetition)
        record["result"] = row
        prefix.with_suffix(".json").write_text(json.dumps(record, indent=2) + "\n")
        return row

    sizes = [64, 512, 513, 4096, 1048576]
    cases = [
        (size, window)
        for size in sizes
        for window in ([1, 32, 64] if args.wide else [1, 32])
    ]
    counts = {}
    for size, window in cases:
        for variant in variants:
            count = (
                3
                if args.smoke
                else max(8, min(2000, 16 * 1024 * 1024 // (size * window)))
            )
            pilot = run(variant, size, window, count, "pilot")
            counts[variant.name, size, window] = (
                5
                if args.smoke
                else max(
                    32, min(10000000, round(count * args.seconds / pilot["seconds"]))
                )
            )

    rows = []
    for repetition in range(args.repetitions):
        offset = repetition % len(variants)
        order = variants[offset:] + variants[:offset]
        if repetition % 2:
            order = order[::-1]
        offset = repetition % len(cases)
        for size, window in cases[offset:] + cases[:offset]:
            for variant in order:
                row = run(
                    variant,
                    size,
                    window,
                    counts[variant.name, size, window],
                    "measured",
                    repetition,
                )
                rows.append(row)
                with (args.output / "runs.jsonl").open("a") as log:
                    log.write(json.dumps(row) + "\n")
            print(
                f"run {repetition + 1}/{args.repetitions}: {size} B, batch {window}",
                flush=True,
            )
    return cases, rows


def report(args, variants, cases, rows):
    summary = []
    for size, window in cases:
        for variant in variants:
            selected = [
                r
                for r in rows
                if (r["bytes"], r["window"], r["mode"]) == (size, window, variant.name)
            ]
            summary.append(
                {
                    "bytes": size,
                    "window": window,
                    "mode": variant.name,
                    **{
                        key: statistics.median(r[key] for r in selected)
                        for key in METRICS
                    },
                    "calls_per_second_min": min(
                        r["calls_per_second"] for r in selected
                    ),
                    "calls_per_second_max": max(
                        r["calls_per_second"] for r in selected
                    ),
                }
            )
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    lines = [
        "# Buffer IPC benchmark",
        "",
        f"{args.repetitions} runs per configuration; medians of independent run metrics.",
        "Calls/s counts completed request/reply pairs. Batches above one report batch latency.",
        "CPU includes both processes. IPC spins; Unix sockets block.",
        "",
    ]
    if args.smoke:
        lines += [
            "Smoke run: correctness only; timings are not performance evidence.",
            "",
        ]
    lines += [
        "| Bytes | Batch | Variant | Calls/s | Min–max calls/s | Batch p50 µs | Batch p99 µs | CPU µs/call |",
        "| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for r in summary:
        lines.append(
            f"| {r['bytes']} | {r['window']} | {r['mode']} | {r['calls_per_second']:,.0f} | "
            f"{r['calls_per_second_min']:,.0f}–{r['calls_per_second_max']:,.0f} | "
            f"{r['batch_p50_us']:.3f} | {r['batch_p99_us']:.3f} | {r['cpu_us_per_call']:.3f} |"
        )
    (args.output / "report.md").write_text("\n".join(lines) + "\n")


def main():
    args, cpus, allowed = options()
    variants, metadata = prepare(args, cpus, allowed)
    cases, rows = measure(args, cpus, variants)
    # Results always describe the frozen snapshot, even if the workspace changes.
    for name, expected in metadata["source_sha256"].items():
        if digest(args.output / "source" / name) != expected:
            raise RuntimeError(f"benchmark source snapshot changed: {name}")
    report(args, variants, cases, rows)
    print(args.output / "report.md")


if __name__ == "__main__":
    main()
