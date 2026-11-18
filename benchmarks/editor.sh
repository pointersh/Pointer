#!/usr/bin/env bash
# The review engine inside a real VS Code: opens a throwaway window, runs editor.test.cjs, closes it.
#   benchmarks/editor.sh            (VS Code from /Applications, or set VSCODE_BIN)
set -u
repo=$(cd "$(dirname "$0")/.." && pwd)
code=${VSCODE_BIN:-"/Applications/Visual Studio Code.app/Contents/MacOS/Code"}
[ -x "$code" ] || { echo "VS Code not found at $code; set VSCODE_BIN."; exit 2; }
base=$(mktemp -d)
trap 'rm -rf "$base"' EXIT
mkdir "$base/ws"
"$code" --extensionDevelopmentPath="$repo" --extensionTestsPath="$repo/benchmarks/editor.test.cjs" \
  --user-data-dir="$base/user" --extensions-dir="$base/extensions" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --disable-telemetry "$base/ws" >"$base/log" 2>&1
status=$?
cat "$base/editor-results.txt" 2>/dev/null || cat "$base/log"
exit $status
