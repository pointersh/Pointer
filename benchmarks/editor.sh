#!/usr/bin/env bash
# Runs a test file inside a real VS Code with Pointer loaded: opens a throwaway window and closes it.
#   benchmarks/editor.sh                                  review engine (editor.test.cjs) in an empty workspace
#   benchmarks/editor.sh benchmarks/live.test.cjs <flask> live Tasks A and C and cancel (needs TrueForge running)
# VS Code from /Applications, or set VSCODE_BIN.
set -u
repo=$(cd "$(dirname "$0")/.." && pwd)
tests=$(cd "$(dirname "${1:-$repo/benchmarks/editor.test.cjs}")" && pwd)/$(basename "${1:-editor.test.cjs}")
code=${VSCODE_BIN:-"/Applications/Visual Studio Code.app/Contents/MacOS/Code"}
[ -x "$code" ] || { echo "VS Code not found at $code; set VSCODE_BIN."; exit 2; }
base=$(mktemp -d)
trap 'rm -rf "$base"' EXIT
workspace=${2:-$base/ws}
mkdir -p "$workspace"
POINTER_RESULTS="$base/results.txt" POINTER_REPO="$repo" "$code" --extensionDevelopmentPath="$repo" --extensionTestsPath="$tests" \
  --user-data-dir="$base/user" --extensions-dir="$base/extensions" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --disable-telemetry "$workspace" >"$base/log" 2>&1
status=$?
cat "$base/results.txt" 2>/dev/null || cat "$base/log"
exit $status
