#!/usr/bin/env bash
set -euo pipefail

# Runs finite top-level benchmarks sequentially. HTTP/oha harnesses have their
# own runtime and lifecycle requirements and are run separately.
# ./run.sh [--json] [--bench=doorbell] [--runtime=node]
#          [--bench-dir=bench] [--results-dir=results]

BENCH_DIR="bench"
RESULTS_DIR="results"
OUT_EXT="md"
BENCH_EXTRA_ARGS=()
SELECTED_BENCH=""
SELECTED_RUNTIME=""

for arg in "$@"; do
  case "$arg" in
    --json) OUT_EXT="json"; BENCH_EXTRA_ARGS+=(--json) ;;
    --bench-dir=*) BENCH_DIR="${arg#*=}" ;;
    --results-dir=*) RESULTS_DIR="${arg#*=}" ;;
    --bench=*) SELECTED_BENCH="${arg#*=}" ;;
    --runtime=*) SELECTED_RUNTIME="${arg#*=}" ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

RUNTIMES=(node deno bun)
if [[ -n "$SELECTED_RUNTIME" ]]; then
  case "$SELECTED_RUNTIME" in
    node|deno|bun) RUNTIMES=("$SELECTED_RUNTIME") ;;
    *) echo "Unknown runtime: $SELECTED_RUNTIME" >&2; exit 1 ;;
  esac
fi

[[ -d "$BENCH_DIR" ]] || { echo "Missing benchmark directory: $BENCH_DIR" >&2; exit 1; }
BENCH_FILES=()
while IFS= read -r -d '' file; do
  filename="$(basename "$file")"
  stem="${filename%.ts}"
  case "$stem" in
    http-body-server|http-body-oha) continue ;;
  esac
  if [[ -n "$SELECTED_BENCH" && "$SELECTED_BENCH" != "$stem" ]]; then continue; fi
  BENCH_FILES+=("$file")
done < <(find "$BENCH_DIR" -maxdepth 1 -type f -name '*.ts' -print0 | sort -z)

if [[ ${#BENCH_FILES[@]} -eq 0 ]]; then
  echo "No finite benchmarks selected in $BENCH_DIR (bench=$SELECTED_BENCH)" >&2
  exit 1
fi

for file in "${BENCH_FILES[@]}"; do
  filename="$(basename "$file")"
  stem="${filename%.ts}"
  for runtime in "${RUNTIMES[@]}"; do
    output_dir="$RESULTS_DIR"
    if [[ "$OUT_EXT" == "json" ]]; then output_dir="$RESULTS_DIR/json/$runtime"; fi
    mkdir -p "$output_dir"
    output="$output_dir/${runtime}_${stem}.${OUT_EXT}"
    errors="$output_dir/${runtime}_${stem}.stderr.log"
    case "$runtime" in
      node) command=(node --no-warnings --experimental-transform-types) ;;
      deno) command=(deno run -A) ;;
      bun) command=(bun run) ;;
    esac
    echo "Running $filename with $runtime..."
    # Separate diagnostics from data, and publish only successful results.
    if ! "${command[@]}" "$file" "${BENCH_EXTRA_ARGS[@]}" > "$output.tmp" 2> "$errors"; then
      echo "Benchmark failed: $file ($runtime); see $errors and $output.tmp" >&2
      exit 1
    fi
    if [[ "$OUT_EXT" == "json" ]]; then
      if ! node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$output.tmp" 2>> "$errors"; then
        echo "Invalid JSON: $file ($runtime); see $errors and $output.tmp" >&2
        exit 1
      fi
    fi
    mv "$output.tmp" "$output"
  done
done

echo "All selected benchmarks completed. Results are in $RESULTS_DIR/"
