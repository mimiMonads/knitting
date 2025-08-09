#!/usr/bin/env bash
set -euo pipefail

BENCH_DIR="bench"
RESULTS_DIR="results"

mkdir -p "$RESULTS_DIR"/{node,deno,bun}

# Find only files in BENCH_DIR and its first-level subfolders
find "$BENCH_DIR" -maxdepth 1 -type f | while read -r file; do
    filename=$(basename "$file")

    echo "Running $filename with Node.js..."
    node --no-warnings --experimental-transform-types "$file" \
        > "$RESULTS_DIR/node/$filename.md" 2>&1

    echo "Running $filename with Deno..."
    deno run -A "$file" \
        > "$RESULTS_DIR/deno/$filename.md" 2>&1

    echo "Running $filename with Bun..."
    bun run "$file" \
        > "$RESULTS_DIR/bun/$filename.md" 2>&1
done

echo "✅ All benchmarks completed. Results are in $RESULTS_DIR/"

