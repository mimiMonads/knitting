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
RESULTS_JSON_DIR=""

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

if [[ "$OUT_EXT" == "json" ]]; then
  RESULTS_JSON_DIR="$RESULTS_DIR/json"
  mkdir -p "$RESULTS_JSON_DIR"/{node,deno,bun}
fi

# Find only files directly inside BENCH_DIR (ignore nested)
while IFS= read -r -d '' file; do
  filename="$(basename "$file")"
  stem="${filename%.*}"   # drop .ts/.js/etc

  if [[ "$OUT_EXT" == "json" ]]; then
    node_out="$RESULTS_JSON_DIR/node/node_${stem}.${OUT_EXT}"
    deno_out="$RESULTS_JSON_DIR/deno/deno_${stem}.${OUT_EXT}"
    bun_out="$RESULTS_JSON_DIR/bun/bun_${stem}.${OUT_EXT}"
  else
    node_out="$RESULTS_DIR/node_${stem}.${OUT_EXT}"
    deno_out="$RESULTS_DIR/deno_${stem}.${OUT_EXT}"
    bun_out="$RESULTS_DIR/bun_${stem}.${OUT_EXT}"
  fi

  echo "Running $filename with Node.js..."
  node --no-warnings --experimental-transform-types "$file" "${BENCH_EXTRA_ARGS[@]}" \
    > "$node_out" 2>&1

  echo "Running $filename with Deno..."
  deno run -A "$file" "${BENCH_EXTRA_ARGS[@]}" \
    > "$deno_out" 2>&1

  echo "Running $filename with Bun..."
  bun run "$file" "${BENCH_EXTRA_ARGS[@]}" \
    > "$bun_out" 2>&1

done < <(find "$BENCH_DIR" -maxdepth 1 -type f -print0)

if [[ "$OUT_EXT" == "json" ]]; then
  echo "✅ All benchmarks completed. Results are in $RESULTS_JSON_DIR/"
else
  echo "✅ All benchmarks completed. Results are in $RESULTS_DIR/"
fi
