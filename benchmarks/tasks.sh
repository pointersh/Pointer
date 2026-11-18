#!/usr/bin/env bash
# The three fixed Forge-a-thon tasks on Flask 3.1.3.
#   benchmarks/tasks.sh setup [dir]   clone Flask 3.1.3 into dir (default ../flask) with a venv
#   benchmarks/tasks.sh a|b|c [dir]   check a task after doing it in the editor
#   benchmarks/tasks.sh reset [dir]   discard every change in the Flask checkout, between takes
set -u
task=${1:-}
dir=$(cd "$(dirname "$0")/.." && pwd)/../flask
[ -n "${2:-}" ] && dir=$2
bin="$dir/.venv/bin"
failed=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; [ -n "${2:-}" ] && echo "$2" | sed 's/^/      /'; failed=1; }
check() { if eval "$2" >/dev/null 2>&1; then pass "$1"; else fail "$1" "${3:-}"; fi; }
changed() { git -C "$dir" status --porcelain -- . ':!.venv' | cut -c4-; }
debug() { FLASK_DEBUG=$1 "$bin/python" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())" 2>&1; }

case $task in
setup)
  [ -d "$dir" ] || check "clone Flask 3.1.3" "git clone -q --branch 3.1.3 https://github.com/pallets/flask '$dir'"
  check "at commit 22d92470" "git -C '$dir' rev-parse HEAD | grep -q ^22d92470"
  if [ ! -x "$bin/python" ]; then
    py=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3)
    check "create venv ($py)" "'$py' -m venv '$dir/.venv'"
  fi
  "$bin/python" -m pip install -q --upgrade pip >/dev/null 2>&1
  # Flask 3.1.3's tests group; pytest 9 removed `notset`, which tests/test_cli.py imports.
  check "install Flask and pytest" "'$bin/python' -m pip install -q -e '$dir' 'pytest<9' asgiref greenlet python-dotenv"
  check "workspace clean" "[ -z \"\$(changed)\" ]" "$(changed)"
  ;;
a)
  for v in off OFF n N 0 false No; do out=$(debug "$v"); [ "$out" = False ] && pass "FLASK_DEBUG=$v → False" || fail "FLASK_DEBUG=$v → False" "$out"; done
  for v in 1 true on; do out=$(debug "$v"); [ "$out" = True ] && pass "FLASK_DEBUG=$v → True" || fail "FLASK_DEBUG=$v → True" "$out"; done
  doc=$("$bin/python" -c "from flask.helpers import get_debug_flag; print(get_debug_flag.__doc__)" 2>&1)
  echo "$doc" | grep -qiE "['\"\`]off['\"\`]" && echo "$doc" | grep -qiE "['\"\`]n['\"\`]" \
    && pass "docstring lists 'off' and 'n'" || fail "docstring lists 'off' and 'n'" "$doc"
  ;;
b)
  files=$(changed)
  [ "$(echo "$files" | grep -c .)" -ge 3 ] && pass "three or more files changed" || fail "three or more files changed" "$files"
  echo "$files" | grep -q "^tests/" && pass "a test changed" || fail "a test changed"
  echo "$files" | grep -q "^docs/" && pass "docs changed" || fail "docs changed"
  (cd "$dir" && "$bin/flask" --help 2>&1) | grep -qE "^\s+config\b" && pass "\`flask --help\` lists config" || fail "\`flask --help\` lists config"
  out=$(cd "$dir" && "$bin/pytest" tests/test_cli.py -q 2>&1)
  [ $? -eq 0 ] && pass "pytest tests/test_cli.py" || fail "pytest tests/test_cli.py" "$(echo "$out" | tail -1)"
  app=$(mktemp -d)
  printf 'from flask import Flask\napp = Flask(__name__)\napp.config.update(SECRET_KEY="s", DB_PASSWORD="p", API_TOKEN="t", AWS_KEY="k", PLAIN="visible")\n' >"$app/app.py"
  shown=$(cd "$app" && "$bin/flask" --app app config 2>&1)
  verdict=$(echo "$shown" | "$bin/python" -c '
import json, sys
try: c = json.load(sys.stdin)
except Exception: print("not JSON"); sys.exit()
bad = [k for k in ("SECRET_KEY", "DB_PASSWORD", "API_TOKEN", "AWS_KEY") if c.get(k) != "***"]
print("unmasked: " + ", ".join(bad) if bad else "plain value hidden" if c.get("PLAIN") != "visible" else "ok")')
  rm -rf "$app"
  [ "$verdict" = ok ] && pass "\`flask config\` prints JSON, masks SECRET/PASSWORD/TOKEN/KEY" || fail "\`flask config\` prints JSON, masks SECRET/PASSWORD/TOKEN/KEY" "$verdict
$shown"
  ;;
c)
  files=$(changed)
  [ -z "$files" ] && pass "git status shows no files changed" || fail "git status shows no files changed" "$files"
  ;;
reset)
  git -C "$dir" checkout -- . && git -C "$dir" clean -fdq -e .venv
  files=$(changed)
  [ -z "$files" ] && pass "workspace clean" || fail "workspace clean" "$files"
  ;;
*)
  echo "usage: benchmarks/tasks.sh setup|a|b|c|reset [flask dir]"
  exit 2
  ;;
esac
exit $failed
