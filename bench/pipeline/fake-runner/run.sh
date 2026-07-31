#!/usr/bin/env bash
# Fake agent runner — deterministic, no LLM, no API key.
# Receives the augmented prompt as $1 (promptInArgs: true).
# Extracts the completion marker from the prompt and prints it to stdout
# so VerdictEngine detects it, kills the session, and advances the pipeline.
set -euo pipefail
prompt="$1"

# The prompt gives the marker in two halves (`<<<ORDEWELL_` + `DONE_<uuid>>>>`)
# so the joined token never appears in echoed prompts. Assemble it like a
# real agent following the instruction would.
marker=$(printf '%s' "$prompt" | grep -oE '<<<ORDEWELL_DONE_[A-Za-z0-9_-]+>>>' | head -1 || true)
if [ -z "$marker" ]; then
  half=$(printf '%s' "$prompt" | grep -oE 'DONE_[A-Za-z0-9_-]+>>>' | head -1 || true)
  [ -n "$half" ] && marker="<<<ORDEWELL_${half}"
fi

echo "[fake-runner] starting task..."
sleep 0.2
echo "[fake-runner] doing work..."

# Simulate a real agent: write a file to the workspace (cwd)
ts=$(date +%s)
echo "fake-runner output at ${ts}" > "fake-runner-output-${ts}.txt"

echo "[fake-runner] work complete."

if [ -n "$marker" ]; then
  echo "$marker"
else
  echo "ERROR: no completion marker found in prompt" >&2
  exit 1
fi
