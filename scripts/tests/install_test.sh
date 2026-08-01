#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2025 Lem
#
# This file is part of Lem.
#
# Lem is free software: you can redistribute it and/or modify it under
# the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Lem is distributed in the hope that it will be useful, but WITHOUT
# ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
# or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General
# Public License for more details.
#
# ---------------------------------------------------------------------------
# Tests for scripts/install.sh and scripts/lem.
#
#   ./scripts/tests/install_test.sh
#
# No bats, no fixtures directory: the installer is sourced with
# LEM_INSTALL_SH_SOURCE_ONLY=1 (which suppresses main) and its functions are
# called directly against temporary directories. Nothing here touches $HOME,
# starts a server, or reaches the network.
#
# The end-to-end install/re-install/uninstall run is a separate, manual
# exercise -- see the PR that introduced this file for the transcript.
# ---------------------------------------------------------------------------

set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
INSTALL_SH="$REPO_ROOT/scripts/install.sh"
LEM_CLI="$REPO_ROOT/scripts/lem"

PASS=0
FAIL=0
SKIP=0
WORK=""

# --- tiny harness ----------------------------------------------------------

ok() {
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}

no() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
  [ "$#" -lt 2 ] || printf '       %s\n' "$2"
}

skip() {
  SKIP=$((SKIP + 1))
  printf '  skip %s (%s)\n' "$1" "$2"
}

section() {
  printf '\n%s\n' "$1"
}

assert_eq() {
  local want="$1" got="$2" name="$3"
  if [ "$want" = "$got" ]; then
    ok "$name"
  else
    no "$name" "want [$want], got [$got]"
  fi
}

assert_true() {
  if [ "$1" -eq 0 ]; then ok "$2"; else no "$2" "expected success, got status $1"; fi
}

assert_false() {
  if [ "$1" -ne 0 ]; then ok "$2"; else no "$2" "expected failure, got status 0"; fi
}

assert_contains() {
  local haystack="$1" needle="$2" name="$3"
  case "$haystack" in
    *"$needle"*) ok "$name" ;;
    *) no "$name" "expected to find [$needle]" ;;
  esac
}

assert_file_test() {
  local flag="$1" path="$2" name="$3" status
  test "$flag" "$path"
  status=$?
  if [ "$status" -eq 0 ]; then ok "$name"; else no "$name" "test $flag $path failed"; fi
}

assert_not_file_test() {
  local flag="$1" path="$2" name="$3" status
  test "$flag" "$path"
  status=$?
  if [ "$status" -ne 0 ]; then ok "$name"; else no "$name" "test $flag $path unexpectedly true"; fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" name="$3"
  case "$haystack" in
    *"$needle"*) no "$name" "did not expect to find [$needle]" ;;
    *) ok "$name" ;;
  esac
}

# Code with comments stripped. Used by the greps below so that a rule ("never
# bind 0.0.0.0") is not tripped by the comment explaining the rule.
code_lines() {
  sed 's/#.*//' "$1"
}

# --- load the installer ----------------------------------------------------

# shellcheck source=../install.sh disable=SC1091
LEM_INSTALL_SH_SOURCE_ONLY=1 . "$INSTALL_SH"
set +e  # the installer turns on -e; the harness checks statuses itself

# After sourcing: the installer installs its own EXIT trap, which would
# otherwise replace ours and leak the work directory.
WORK="$(mktemp -d)"
cleanup_tests() {
  [ -z "$WORK" ] || rm -rf "$WORK"
}
trap cleanup_tests EXIT

# ===========================================================================
section "syntax"
# ===========================================================================

bash -n "$INSTALL_SH"
assert_true $? "install.sh parses (bash -n)"
bash -n "$LEM_CLI"
assert_true $? "lem parses (bash -n)"

for script in "$INSTALL_SH" "$LEM_CLI"; do
  head -n 60 "$script" | grep -qF 'set -euo pipefail'
  assert_true $? "$(basename "$script") uses 'set -euo pipefail'"
done

# ===========================================================================
section "location independence (the curl | bash defect)"
# ===========================================================================

# Under a pipe, ${BASH_SOURCE[0]} inside a function is the literal string
# "main": `dirname main` is ".", `cd .` succeeds, and a script that locates
# itself that way silently adopts the caller's working directory as the
# repository root. The installer must therefore never mention either name.
# shellcheck disable=SC2016  # the literal strings are the point of the search.
code_lines "$INSTALL_SH" | grep -nE '\$0|BASH_SOURCE'
assert_false $? "install.sh never references \$0 or BASH_SOURCE"

code_lines "$INSTALL_SH" | grep -n 'dirname'
assert_false $? "install.sh never shells out to dirname"

# ===========================================================================
section "no non-loopback bind anywhere"
# ===========================================================================

code_lines "$INSTALL_SH" | grep -n '0\.0\.0\.0'
assert_false $? "install.sh never writes a 0.0.0.0 bind"

code_lines "$LEM_CLI" | grep -n '0\.0\.0\.0'
assert_false $? "the CLI never writes a 0.0.0.0 bind"

code_lines "$INSTALL_SH" | grep -n -- '--host'
assert_false $? "install.sh never passes --host to anything"

code_lines "$INSTALL_SH" | grep -n 'uvicorn'
assert_false $? "install.sh never invokes uvicorn directly (lem-serve only)"

code_lines "$LEM_CLI" | grep -n 'pkill'
assert_false $? "the CLI does not pkill (it uses a PID file)"

# ===========================================================================
section "argument parsing"
# ===========================================================================

out="$(parse_args --help 2>&1)"; status=$?
assert_true $status "--help exits 0"
assert_contains "$out" "--uninstall" "--help documents --uninstall"
assert_contains "$out" "--dry-run" "--help documents --dry-run"

out="$(parse_args --nope 2>&1)"; status=$?
assert_false $status "an unknown option is rejected"
assert_contains "$out" "Unknown option" "the rejection names the option"

out="$(parse_args positional 2>&1)"; status=$?
assert_false $status "an unexpected positional argument is rejected"

# The old installer printed 'sudo ./scripts/install.sh --systemd' but parsed
# no arguments at all. The flag is gone; saying so beats silently ignoring it.
out="$(parse_args --systemd 2>&1)"; status=$?
assert_false $status "--systemd is rejected"
assert_contains "$out" "user unit" "--systemd explains the replacement"

(
  parse_args --dry-run --no-service --no-start --yes
  [ "$DRY_RUN" = 1 ] && [ "$INSTALL_SERVICE" = 0 ] &&
    [ "$START_SERVER" = 0 ] && [ "$ASSUME_YES" = 1 ]
)
assert_true $? "flags set their variables"

out="$(parse_args --port 7000 >/dev/null 2>&1; printf '%s' "$LEM_PORT")"
assert_eq "7000" "$out" "--port PORT"

out="$(parse_args --port=7001 >/dev/null 2>&1; printf '%s' "$LEM_PORT")"
assert_eq "7001" "$out" "--port=PORT"

out="$(parse_args --ref=v9 --source=/tmp/x >/dev/null 2>&1; printf '%s %s' "$LEM_REF" "$LEM_SOURCE")"
assert_eq "v9 /tmp/x" "$out" "--ref= and --source="

(parse_args --port abc) >/dev/null 2>&1
assert_false $? "a non-numeric port is rejected"

(parse_args --port 99999) >/dev/null 2>&1
assert_false $? "an out-of-range port is rejected"

(parse_args --port) >/dev/null 2>&1
assert_false $? "--port without a value is rejected"

(parse_args --uninstall >/dev/null 2>&1; [ "$MODE" = uninstall ])
assert_true $? "--uninstall selects the uninstall mode"

# ===========================================================================
section "platform detection"
# ===========================================================================

# A shell function shadows the external command, so detect_platform can be
# driven without a VM.
detect_with_uname() {
  local kernel="$1" proc_version="${2:-}"
  (
    # shellcheck disable=SC2317  # called indirectly, by detect_platform.
    uname() { [ "${1:-}" = "-s" ] && printf '%s\n' "$kernel" || printf 'testarch\n'; }
    # shellcheck disable=SC2034  # read by detect_platform, from install.sh.
    LEM_PROC_VERSION="$proc_version"
    detect_platform
    printf '%s %s %s\n' "$LEM_PLATFORM" "$LEM_IS_WSL" "$LEM_ARCH"
  )
}

printf 'Linux version 6.8.0-generic\n' >"$WORK/proc_version_linux"
printf 'Linux version 5.15.0-microsoft-standard-WSL2\n' >"$WORK/proc_version_wsl"

assert_eq "macos 0 testarch" "$(detect_with_uname Darwin)" "Darwin -> macos"
assert_eq "linux 0 testarch" "$(detect_with_uname Linux "$WORK/proc_version_linux")" \
  "Linux -> linux"
assert_eq "linux 1 testarch" "$(detect_with_uname Linux "$WORK/proc_version_wsl")" \
  "Linux under WSL2 -> linux, IS_WSL=1"
assert_eq "linux 0 testarch" "$(detect_with_uname Linux /nonexistent/proc/version)" \
  "an unreadable /proc/version is not fatal"

out="$(detect_with_uname MINGW64_NT 2>&1)"; status=$?
assert_false $status "MINGW (native Windows) is rejected"
assert_contains "$out" "WSL2" "the Windows rejection points at WSL2"

out="$(detect_with_uname Plan9 2>&1)"; status=$?
assert_false $status "an unknown kernel is rejected"

# One source of truth: server/app/config/platform.py. The shell copy exists
# only because the installer runs before any Python does, so it has to agree.
if command -v python3 >/dev/null 2>&1; then
  py_out="$(python3 - "$REPO_ROOT/server/app/config/platform.py" <<'PY'
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("lem_platform", sys.argv[1])
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(f"{module.PLATFORM} {int(module.IS_WSL)}")
PY
)"
  detect_platform
  assert_eq "$py_out" "$LEM_PLATFORM $LEM_IS_WSL" \
    "shell detection agrees with server/app/config/platform.py"
else
  skip "shell detection agrees with platform.py" "python3 not available"
fi

# ===========================================================================
section "source tree discovery"
# ===========================================================================

make_fake_checkout() {
  local root="$1"
  mkdir -p "$root/server" "$root/scripts" "$root/deep/nested"
  touch "$root/server/pyproject.toml" "$root/scripts/install.sh" "$root/scripts/lem"
}

make_fake_checkout "$WORK/checkout"
mkdir -p "$WORK/elsewhere/sub"

is_source_tree "$WORK/checkout"
assert_true $? "a complete tree is recognised"

rm "$WORK/checkout/scripts/lem"
is_source_tree "$WORK/checkout"
assert_false $? "a tree missing a marker file is rejected"
touch "$WORK/checkout/scripts/lem"

out="$(cd "$WORK/checkout/deep/nested" && find_checkout_root)"
assert_eq "$WORK/checkout" "$out" "the root is found from a nested directory"

out="$(cd "$WORK/checkout" && find_checkout_root)"
assert_eq "$WORK/checkout" "$out" "the root is found from the root itself"

# The heart of the old bug: outside a checkout the answer must be "no", not
# "the current directory".
(cd "$WORK/elsewhere/sub" && find_checkout_root >/dev/null 2>&1)
assert_false $? "an unrelated directory is NOT mistaken for a checkout"

# ===========================================================================
section "idempotency: Harbor version stamp"
# ===========================================================================

harbor_dir="$WORK/harbor"
mkdir -p "$harbor_dir"

harbor_is_current "$harbor_dir" v0.3.20
assert_false $? "no stamp -> reinstall"

printf 'v0.3.20\n' >"$harbor_dir/.lem-harbor-version"
harbor_is_current "$harbor_dir" v0.3.20
assert_false $? "stamp but no executable harbor.sh -> reinstall"

printf '#!/bin/sh\n' >"$harbor_dir/harbor.sh"
chmod +x "$harbor_dir/harbor.sh"
harbor_is_current "$harbor_dir" v0.3.20
assert_true $? "matching stamp + harbor.sh -> skip"

harbor_is_current "$harbor_dir" v0.4.0
assert_false $? "a version bump -> reinstall"

# ===========================================================================
section "idempotency: PATH block"
# ===========================================================================

rc="$WORK/rc"
printf 'export EDITOR=vi\n' >"$rc"
cp "$rc" "$WORK/rc.orig"

path_block_add "$rc" "$WORK/lemhome/bin"
assert_true $? "the first add reports a change"
assert_eq "1" "$(grep -cF "$PATH_BLOCK_BEGIN" "$rc")" "exactly one begin marker"

path_block_add "$rc" "$WORK/lemhome/bin"
assert_false $? "a second add is a no-op"
assert_eq "1" "$(grep -cF "$PATH_BLOCK_BEGIN" "$rc")" "still exactly one begin marker"

path_block_remove "$rc"
assert_true $? "remove reports a change"
cmp -s "$rc" "$WORK/rc.orig"
assert_true $? "the rc file is byte-identical to the original"

path_block_remove "$rc"
assert_false $? "a second remove is a no-op"

# A file with no trailing newline must not get the marker glued to its last line.
printf 'export EDITOR=vi' >"$rc"
path_block_add "$rc" "$WORK/lemhome/bin" >/dev/null
head -n 1 "$rc" | grep -qx 'export EDITOR=vi'
assert_true $? "an rc file with no trailing newline keeps its last line intact"
path_block_remove "$rc" >/dev/null
assert_eq "export EDITOR=vi" "$(cat "$rc")" "and its content survives the removal"

# A hand-rolled PATH entry (e.g. from the old installer) is reported, not
# silently duplicated.
# shellcheck disable=SC2016  # written verbatim, as the old installer did.
printf 'export PATH="$HOME/.lem/bin:$PATH"\n' >"$rc"
out="$(path_block_add "$rc" "$WORK/lemhome/bin" 2>&1)"; status=$?
assert_eq "2" "$status" "an unfenced .lem/bin entry is reported distinctly"
assert_contains "$out" "leaving it alone" "and the user is told"
grep -qF "$PATH_BLOCK_BEGIN" "$rc"
assert_false $? "and nothing was appended"

# ===========================================================================
section "the CLI symlink never clobbers"
# ===========================================================================

bindir="$WORK/userbin"
mkdir -p "$bindir"
printf '#!/bin/sh\n' >"$bindir/lem"  # somebody else's lem
chmod +x "$bindir/lem"

out="$(link_cli_into "$bindir" "$WORK/lemhome/bin/lem" 2>&1)"; status=$?
assert_false $status "a foreign 'lem' is not replaced"
assert_contains "$out" "not ours" "and the user is told"
assert_not_file_test -L "$bindir/lem" "the foreign file is still a plain file"

rm -f "$bindir/lem"
link_cli_into "$bindir" "$WORK/lemhome/bin/lem"
assert_true $? "an empty directory gets the symlink"
link_cli_into "$bindir" "$WORK/lemhome/bin/lem"
assert_true $? "re-linking our own symlink is fine"
assert_eq "$WORK/lemhome/bin/lem" "$(readlink "$bindir/lem")" "the symlink points at our CLI"

# ===========================================================================
section "the generated launcher"
# ===========================================================================

LEM_HOME="$WORK/lemhome"
# shellcheck disable=SC2034  # read by write_launcher, from install.sh.
UV_BIN="/usr/bin/uv"
DRY_RUN=0
mkdir -p "$LEM_HOME/bin"

SERVER_DIR="$WORK/src/server"
mkdir -p "$SERVER_DIR/app"
touch "$SERVER_DIR/app/serve.py"
write_launcher >/dev/null 2>&1
launcher="$(cat "$LEM_HOME/bin/lem-server")"
assert_contains "$launcher" "run lem-serve" "the launcher execs lem-serve"
assert_not_contains "$launcher" "--host" "no --host is hand-rolled around it"
assert_not_contains "$launcher" "uvicorn" "uvicorn is never invoked directly"
assert_contains "$launcher" "config/server.env" "the launcher reads server.env"
assert_file_test -x "$LEM_HOME/bin/lem-server" "the launcher is executable"

bash -n "$LEM_HOME/bin/lem-server"
assert_true $? "the generated launcher parses"

# A source predating PR #25 is refused rather than started a less safe way.
SERVER_DIR="$WORK/oldsrc/server"
mkdir -p "$SERVER_DIR/app"
out="$( (write_launcher) 2>&1 )"; status=$?
assert_false $status "a source without app/serve.py is refused"
assert_contains "$out" "--ref main" "and the refusal says how to fix it"

# ===========================================================================
section "server.env is configuration, not managed state"
# ===========================================================================

write_server_env >/dev/null 2>&1
printf '\n# my own note\n' >>"$LEM_HOME/config/server.env"
write_server_env >/dev/null 2>&1
grep -qF "my own note" "$LEM_HOME/config/server.env"
assert_true $? "a re-install does not overwrite server.env"
grep -qE '^[[:space:]]*LEM_HOST=' "$LEM_HOME/config/server.env"
assert_false $? "LEM_HOST is commented out by default"

# ===========================================================================
section "install.env survives an awkward prefix"
# ===========================================================================

# The CLI sources this file, so an unquoted value with a space in it would be a
# syntax error rather than a path.
LEM_HOME="$WORK/lem home"
SERVER_DIR="$LEM_HOME/src/server"
LEM_PLATFORM="linux"
LEM_IS_WSL=0
LEM_ARCH="testarch"
# shellcheck disable=SC2034  # read by write_install_env, from install.sh.
LEM_SERVICE="none"
# shellcheck disable=SC2034  # ditto.
LEM_SOURCE_MODE="download"
write_install_env
(
  # shellcheck disable=SC1090,SC1091  # generated above, path known only at runtime.
  . "$LEM_HOME/config/install.env"
  [ "$LEM_HOME" = "$WORK/lem home" ] && [ "$LEM_LAUNCHER" = "$WORK/lem home/bin/lem-server" ]
)
assert_true $? "install.env round-trips a prefix containing a space"

# ===========================================================================
section "port probing"
# ===========================================================================

if command -v python3 >/dev/null 2>&1; then
  python3 - "$WORK/port" <<'PY' &
import socket
import sys
import time

sock = socket.socket()
sock.bind(("127.0.0.1", 0))
sock.listen(1)
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    handle.write(str(sock.getsockname()[1]))
time.sleep(10)
PY
  listener=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$WORK/port" ] && break
    sleep 0.3
  done
  busy="$(cat "$WORK/port" 2>/dev/null || true)"
  if [ -n "$busy" ]; then
    port_is_free "$busy"
    assert_false $? "a listening port is reported busy"
    port_is_free 1
    assert_true $? "an unused port is reported free"

    # Regression: probing a busy port must not swallow the shell's stderr.
    # `exec 3<&- 2>/dev/null` (an exec with a redirection but no command)
    # made that redirection permanent, and every later warning vanished.
    out="$( (port_is_free "$busy"; warn "still audible") 2>&1 >/dev/null )"
    assert_contains "$out" "still audible" "stderr survives a busy-port probe"
  else
    skip "port probing" "the test listener did not start"
  fi
  kill "$listener" 2>/dev/null
  wait "$listener" 2>/dev/null
else
  skip "port probing" "python3 not available"
fi

# ===========================================================================
section "the CLI refuses to guess"
# ===========================================================================

out="$(LEM_HOME="$WORK/no-such-install" "$LEM_CLI" status 2>&1)"; status=$?
assert_false $status "the CLI fails without an install.env"
assert_contains "$out" "install.sh" "and points at the installer"

out="$(LEM_HOME="$WORK/no-such-install" "$LEM_CLI" bogus 2>&1)"; status=$?
assert_false $status "an unknown CLI command fails"

# ---------------------------------------------------------------------------

printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
