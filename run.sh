#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./run.sh            # writes *.md
#   ./run.sh --json     # writes *.json and passes --json to the benches
#
# Flags:
#   --bench-dir=<path>          # default: bench
#   --results-dir=<path>        # default: results

BENCH_DIR="bench"
RESULTS_DIR="results"
OUT_EXT="md"
BENCH_EXTRA_ARGS=()

# ---- parse flags -------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --json)
      OUT_EXT="json"
      BENCH_EXTRA_ARGS+=(--json)
      shift
      ;;
    --bench-dir=*)
      BENCH_DIR="${arg#*=}"
      shift
      ;;
    --results-dir=*)
      RESULTS_DIR="${arg#*=}"
      shift
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

# mkdir -p "$RESULTS_DIR"/{node,deno,bun}

# Find only files directly inside BENCH_DIR (ignore nested)
while IFS= read -r -d '' file; do
  filename="$(basename "$file")"
  stem="${filename%.*}"   # drop .ts/.js/etc

  echo "Running $filename with Node.js..."
  node --no-warnings --experimental-transform-types "$file" "${BENCH_EXTRA_ARGS[@]}" \
    > "$RESULTS_DIR/node_${stem}.${OUT_EXT}" 2>&1

  echo "Running $filename with Deno..."
  deno run -A "$file" "${BENCH_EXTRA_ARGS[@]}" \
    > "$RESULTS_DIR/deno_${stem}.${OUT_EXT}" 2>&1

  echo "Running $filename with Bun..."
  bun run "$file" "${BENCH_EXTRA_ARGS[@]}" \
    > "$RESULTS_DIR/bun_${stem}.${OUT_EXT}" 2>&1

done < <(find "$BENCH_DIR" -maxdepth 1 -type f -print0)

echo "✅ All benchmarks completed. Results are in $RESULTS_DIR/"
