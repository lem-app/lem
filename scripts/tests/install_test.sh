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
# called directly against temporary directories.
#
# The uninstall cases additionally run the REAL entrypoint
# (`bash install.sh --uninstall --yes`) as a subprocess, because a bug that
# only shows up through argument parsing and main() is invisible to a
# sourced-function test -- that is exactly how the nested-foreign-file case
# below was missed once. Those runs use `env -i` with HOME (and XDG_CONFIG_HOME
# and ZDOTDIR) pointing inside the temp directory and a stub PATH that shadows
# systemctl and launchctl, so nothing outside it can be reached.
#
# Nothing here touches the real $HOME, starts a server, or reaches the network.
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

# server/app/config/platform.py falls back to ~/.lem when LEM_HOME is unset, so
# a relocated install used to run against the *default* prefix: its database and
# API token landed in ~/.lem, outside anything --uninstall would clean up.
assert_contains "$launcher" "export LEM_HOME=\"$LEM_HOME\"" \
  "the launcher exports LEM_HOME so the server uses this prefix"

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
section "the install prefix is validated"
# ===========================================================================

# LEM_HOME is the argument to every later mkdir and rm. Checking it here rather
# than trusting the tools: GNU rm refuses `/` because of --preserve-root, and
# macOS ships BSD rm, which does not.
validate_status() {
  (
    LEM_HOME="$1"
    [ "$#" -lt 2 ] || HOME="$2"
    validate_lem_home
  ) >/dev/null 2>&1
}

validate_value() {
  (
    LEM_HOME="$1"
    validate_lem_home >/dev/null 2>&1 || exit 1
    printf '%s' "$LEM_HOME"
  )
}

validate_status "$WORK/lemhome"
assert_true $? "an absolute prefix is accepted"

assert_eq "$WORK/lem home 日本語 🎉" "$(validate_value "$WORK/lem home 日本語 🎉")" \
  "spaces and unicode are still fine"

assert_eq "/opt/lem" "$(validate_value "/opt/lem///")" "trailing slashes are collapsed"

validate_status ""
assert_false $? "an empty prefix is rejected"

validate_status "relative/lem"
assert_false $? "a relative prefix is rejected"

# Was: "mkdir: invalid option -- 'w'". Fails safely either way, but a raw tool
# error is not the script saying what is wrong.
out="$( (LEM_HOME="-weirdhome/.lem"; validate_lem_home) 2>&1 )"; status=$?
assert_false $status "a leading-dash prefix is rejected"
assert_contains "$out" "absolute path" "and the rejection explains why"

out="$( (LEM_HOME="/"; validate_lem_home) 2>&1 )"; status=$?
assert_false $status "LEM_HOME=/ is rejected by the script itself"
assert_contains "$out" "Refusing" "and says so in Lem's own words"

validate_status "//"
assert_false $? "LEM_HOME=// is rejected too"

validate_status "$WORK/fakehome" "$WORK/fakehome"
assert_false $? "LEM_HOME=\$HOME is rejected"

validate_status "$WORK/fakehome/" "$WORK/fakehome"
assert_false $? "...however it is spelled"

# ===========================================================================
section "uninstall refuses a directory Lem did not create"
# ===========================================================================

# The CRITICAL finding: --uninstall ran `rm -rf $LEM_HOME` with no check that
# Lem had ever put anything there. Pointed at a directory of documents, with
# --yes (what every scripted invocation uses), it deleted all of it.
foreign="$WORK/important_stuff"
mkdir -p "$foreign/Documents" "$foreign/.ssh"
printf 'PRIVATE KEY DATA\n' >"$foreign/.ssh/id_rsa"
printf 'my irreplaceable photos\n' >"$foreign/Documents/photo_manifest.txt"

is_lem_install "$foreign"
assert_false $? "a directory with no install.env is not a Lem install"

is_lem_install "$WORK/never-existed"
assert_false $? "a directory that does not exist is not a Lem install"

# A real install: install.env written by write_install_env, naming itself.
make_fake_install() {
  local root="$1"
  mkdir -p "$root/bin" "$root/config" "$root/data" "$root/logs" "$root/run" "$root/harbor"
  # A Harbor tree plus the manifest install_harbor() records for it: uninstall
  # removes exactly what the manifest lists, so a fixture without one would be
  # testing the "no record, keep everything" fallback instead.
  printf '#!/bin/sh\n' >"$root/harbor/harbor.sh"
  printf 'v0.3.20\n' >"$root/harbor/.lem-harbor-version"
  printf 'HARBOR_X=1\n' >"$root/harbor/.env"
  mkdir -p "$root/harbor/.scripts"
  printf 'shipped\n' >"$root/harbor/.scripts/seed.sh"
  printf 'services:\n' >"$root/harbor/compose.ollama.yml"
  (cd "$root/harbor" && find . ! -name . | sort) >"$root/config/harbor.manifest"
  (
    LEM_HOME="$root"
    SERVER_DIR="$root/src/server"
    LEM_PLATFORM="linux"
    LEM_IS_WSL=0
    LEM_ARCH="testarch"
    # shellcheck disable=SC2034  # read by write_install_env, from install.sh.
    LEM_SERVICE="none"
    # shellcheck disable=SC2034  # ditto.
    LEM_SOURCE_MODE="download"
    DRY_RUN=0
    write_install_env
  )
  printf 'token\n' >"$root/api_token"
  printf 'db\n' >"$root/lem.db"
  printf '#!/bin/sh\n' >"$root/bin/lem-server"
  printf '#!/bin/sh\n' >"$root/bin/lem"
  printf 'LEM_PORT=5142\n' >"$root/config/server.env"
  printf 'started\n' >"$root/logs/lem.log"
}

real="$WORK/realinstall"
make_fake_install "$real"

is_lem_install "$real"
assert_true $? "a directory carrying our install.env is recognised"

# An install.env copied in from somewhere else still names the other prefix.
cp "$real/config/install.env" "$foreign/config-install.env" 2>/dev/null
mkdir -p "$foreign/config"
cp "$real/config/install.env" "$foreign/config/install.env"
is_lem_install "$foreign"
assert_false $? "an install.env recording a different prefix does not count"
rm -rf "$foreign/config" "$foreign/config-install.env"

grep -v LEM_INSTALL_FORMAT "$real/config/install.env" >"$WORK/no-format.env"
mkdir -p "$WORK/noformat/config"
sed "s|^LEM_HOME=.*|LEM_HOME=\"$WORK/noformat\"|" "$WORK/no-format.env" \
  >"$WORK/noformat/config/install.env"
is_lem_install "$WORK/noformat"
assert_false $? "an install.env without a known format version does not count"

# --- the whole uninstall, end to end ---------------------------------------
#
# HOME (and everything that can point outside it) is redirected, and `have` is
# stubbed so systemctl/launchctl count as absent: the refusal has to happen
# before any of that, and this test must not be able to reach the developer's
# own session, service manager or rc files even when it does not.
run_uninstall_isolated() {
  (
    HOME="$WORK/fakehome"
    # shellcheck disable=SC2034  # both are read by uninstall(), from install.sh.
    XDG_CONFIG_HOME="$WORK/fakehome/.config"
    # shellcheck disable=SC2034  # ditto.
    ZDOTDIR="$WORK/fakehome"
    LEM_HOME="$1"
    ASSUME_YES=1
    DRY_RUN=0
    MODE="uninstall"
    # shellcheck disable=SC2317  # called indirectly, by uninstall().
    have() { case "$1" in systemctl|launchctl) return 1 ;; *) command -v "$1" >/dev/null 2>&1 ;; esac; }
    uninstall
  )
}

mkdir -p "$WORK/fakehome"
out="$(run_uninstall_isolated "$foreign" 2>&1)"; status=$?
assert_false $status "--uninstall on a foreign directory exits non-zero"
assert_contains "$out" "not a Lem install" "and says exactly why"
assert_file_test -f "$foreign/.ssh/id_rsa" "the foreign .ssh/id_rsa survives"
assert_file_test -f "$foreign/Documents/photo_manifest.txt" "the foreign document survives"
assert_eq "PRIVATE KEY DATA" "$(cat "$foreign/.ssh/id_rsa")" "byte-for-byte"
assert_not_contains "$out" "Removed" "nothing is reported as removed"

# A file where the prefix should be is refused rather than unlinked.
printf 'not a directory\n' >"$WORK/prefix-is-a-file"
out="$(run_uninstall_isolated "$WORK/prefix-is-a-file" 2>&1)"; status=$?
assert_false $status "--uninstall on a plain file exits non-zero"
assert_file_test -f "$WORK/prefix-is-a-file" "and the file is still there"

# ===========================================================================
section "uninstall removes only files Lem created"
# ===========================================================================

make_fake_install "$WORK/mixed"
printf 'not ours\n' >"$WORK/mixed/somebody-elses-notes.txt"
mkdir -p "$WORK/mixed/their_dir"

out="$(run_uninstall_isolated "$WORK/mixed" 2>&1)"; status=$?
assert_eq "2" "$status" "--uninstall exits 2 when it had to keep the prefix"
assert_not_file_test -e "$WORK/mixed/api_token" "the API token is removed"
assert_not_file_test -e "$WORK/mixed/lem.db" "the database is removed"
assert_not_file_test -e "$WORK/mixed/bin" "bin/ is removed"
assert_not_file_test -e "$WORK/mixed/config" "config/ is removed"
assert_file_test -f "$WORK/mixed/somebody-elses-notes.txt" "an unrecognised file is kept"
assert_file_test -d "$WORK/mixed/their_dir" "an unrecognised directory is kept"
assert_contains "$out" "files Lem did not create" "and the leftovers are reported"

# With nothing unrecognised in it, the prefix itself goes.
make_fake_install "$WORK/clean"
run_uninstall_isolated "$WORK/clean" >/dev/null 2>&1
assert_true $? "--uninstall on a clean install succeeds"
assert_not_file_test -e "$WORK/clean" "and the prefix is gone"

# ===========================================================================
section "uninstall keeps foreign files NESTED inside Lem's own directories"
# ===========================================================================

# The bug this closes: removal used to be `rm -rf` per manifest *name*, so a
# genuine, correctly-marked install whose prefix already carried an unrelated
# data/ or logs/ lost the contents. `data`, `logs`, `config`, `bin` and `run`
# are ordinary names and `mkdir -p` merges into whatever is already there.
#
# Driven through the REAL entrypoint (`bash install.sh --uninstall --yes`),
# not the sourced functions: that is how this was found, and a sourced-function
# test whose foreign files sat only at the top level did not catch it.
mkdir -p "$WORK/stubbin"
for stub in systemctl launchctl; do
  printf '#!/bin/sh\nexit 0\n' >"$WORK/stubbin/$stub"
  chmod 755 "$WORK/stubbin/$stub"
done

# env -i, a stub PATH shadowing systemctl/launchctl, and a HOME inside $WORK:
# the real script runs, but nothing outside $WORK can be reached.
run_real_uninstall() {
  env -i \
    PATH="$WORK/stubbin:/usr/bin:/bin" \
    HOME="$WORK/fakehome" \
    XDG_CONFIG_HOME="$WORK/fakehome/.config" \
    ZDOTDIR="$WORK/fakehome" \
    NO_COLOR=1 \
    LEM_HOME="$1" \
    bash "$INSTALL_SH" --uninstall --yes 2>&1
}

nested="$WORK/legit_nested"
make_fake_install "$nested"
printf 'REAL SCRIPT precious data\n' >"$nested/data/precious.txt"
printf 'their log\n' >"$nested/logs/their.log"
printf 'their config\n' >"$nested/config/their.conf"
mkdir -p "$nested/bin/theirtool"
printf 'their tool\n' >"$nested/bin/theirtool/run.sh"

out="$(run_real_uninstall "$nested")"; status=$?
assert_eq "2" "$status" "the real --uninstall exits 2, not 0, when foreign files survive"
assert_file_test -f "$nested/data/precious.txt" "a foreign file inside data/ survives"
assert_eq "REAL SCRIPT precious data" "$(cat "$nested/data/precious.txt")" "byte-for-byte"
assert_file_test -f "$nested/logs/their.log" "a foreign file inside logs/ survives"
assert_file_test -f "$nested/config/their.conf" "a foreign file inside config/ survives"
assert_file_test -f "$nested/bin/theirtool/run.sh" "a foreign file inside bin/ survives"
assert_file_test -d "$nested" "and the prefix itself survives"
assert_contains "$out" "data/precious.txt" "the survivors are listed by path"

# Lem's own files still go, at every level.
assert_not_file_test -e "$nested/api_token" "the API token is still removed"
assert_not_file_test -e "$nested/lem.db" "the database is still removed"
assert_not_file_test -e "$nested/harbor" "harbor/ is still removed"
assert_not_file_test -e "$nested/config/install.env" "config/install.env is still removed"
assert_not_file_test -e "$nested/config/server.env" "config/server.env is still removed"
assert_not_file_test -e "$nested/logs/lem.log" "logs/lem.log is still removed"
assert_not_file_test -e "$nested/bin/lem-server" "bin/lem-server is still removed"
assert_not_file_test -e "$nested/bin/lem" "bin/lem is still removed"

# The real entrypoint on a clean install: prefix gone, exit 0.
make_fake_install "$WORK/clean_real"
run_real_uninstall "$WORK/clean_real" >/dev/null 2>&1
assert_true $? "the real --uninstall on a clean install exits 0"
assert_not_file_test -e "$WORK/clean_real" "and the prefix is gone"

# The real entrypoint on a foreign directory: refuses, touches nothing.
foreign_real="$WORK/foreign_real"
mkdir -p "$foreign_real/.ssh"
printf 'PRIVATE KEY DATA\n' >"$foreign_real/.ssh/id_rsa"
out="$(run_real_uninstall "$foreign_real")"; status=$?
assert_false $status "the real --uninstall refuses a directory with no marker"
assert_eq "PRIVATE KEY DATA" "$(cat "$foreign_real/.ssh/id_rsa")" "and the key is untouched"

# A symlinked prefix: rmdir always refuses a symlink, so the leftover report
# used to claim "holds things Lem did not install" and then list nothing.
make_fake_install "$WORK/symtarget"
ln -s "$WORK/symtarget" "$WORK/symprefix"
out="$(run_real_uninstall "$WORK/symprefix")"; status=$?
assert_true $status "a symlinked prefix uninstalls cleanly"
assert_not_contains "$out" "files Lem did not create" "without claiming there are leftovers"
assert_eq "" "$(find "$WORK/symtarget/" -mindepth 1 2>/dev/null)" "the target really is empty"

# ===========================================================================
section "uninstall keeps a custom service added to harbor/"
# ===========================================================================

# The realistic user story, not a synthetic planted file: upstream Harbor
# documents adding a service by dropping a compose.*.yml into its checkout, and
# Lem's own catalog scanner discovers services by globbing exactly that
# (server/app/catalog/scanner.py). So harbor/ is a directory Lem SHARES with
# the user, and `rm -rf` on it destroyed their work silently, exit 0.
#
# Real entrypoint again -- this is the path the user takes.
custom="$WORK/harbor_custom"
make_fake_install "$custom"
printf 'services:\n  mine:\n    image: me/mine\n' >"$custom/harbor/compose.mine.yml"
mkdir -p "$custom/harbor/mine"
printf 'my override\n' >"$custom/harbor/mine/notes.txt"

out="$(run_real_uninstall "$custom")"; status=$?
assert_eq "2" "$status" "--uninstall exits 2 when a custom service is in harbor/"
assert_file_test -f "$custom/harbor/compose.mine.yml" "the custom compose file survives"
assert_eq "services:
  mine:
    image: me/mine" "$(cat "$custom/harbor/compose.mine.yml")" "byte-for-byte"
assert_file_test -f "$custom/harbor/mine/notes.txt" "and a directory the user added"
assert_contains "$out" "harbor/compose.mine.yml" "the survivor is reported by path"

# Harbor's own shipped files still go, including the ones its runtime wrote.
assert_not_file_test -e "$custom/harbor/harbor.sh" "Harbor's own harbor.sh is removed"
assert_not_file_test -e "$custom/harbor/compose.ollama.yml" "a shipped compose file is removed"
assert_not_file_test -e "$custom/harbor/.scripts" "a shipped subdirectory is removed"
assert_not_file_test -e "$custom/harbor/.env" "Harbor's runtime .env is removed"
assert_not_file_test -e "$custom/harbor/.lem-harbor-version" "the version stamp is removed"

# No manifest means no record of what Lem put there: keep everything.
noman="$WORK/harbor_nomanifest"
make_fake_install "$noman"
rm -f "$noman/config/harbor.manifest"
out="$(run_real_uninstall "$noman")"; status=$?
assert_eq "2" "$status" "an unrecorded harbor/ is kept, not guessed at"
assert_file_test -f "$noman/harbor/harbor.sh" "and nothing inside it is removed"

# ...and the same file survives a Harbor version bump, which swaps the tree.
# Preserving only .env, as this did before, lost every custom service on every
# upgrade -- the same silent loss, one step earlier.
upgrade="$WORK/harbor_upgrade"
make_fake_install "$upgrade"
printf 'services:\n' >"$upgrade/harbor/compose.mine.yml"
printf 'MY=1\n' >"$upgrade/harbor/.env"
staged_new="$WORK/harbor_staged"
mkdir -p "$staged_new"
printf '#!/bin/sh\n' >"$staged_new/harbor.sh"   # the new version's tree
(
  LEM_HOME="$upgrade"
  mkdir -p "$WORK/carrytmp"
  cp "$upgrade/harbor/.env" "$staged_new/.env"  # what install_harbor does first
  carry_over_harbor_extras "$upgrade/harbor" "$staged_new" "$WORK/carrytmp"
) >/dev/null 2>&1
assert_file_test -f "$staged_new/compose.mine.yml" "a custom compose file is carried into the new tree"
assert_file_test -f "$staged_new/.env" "and Harbor's .env still is too"
assert_not_file_test -e "$staged_new/compose.ollama.yml" "a shipped file is not carried over"
assert_not_file_test -e "$staged_new/.scripts" "nor a shipped subdirectory"

# ===========================================================================
section "the installer refuses to adopt a src/ or harbor/ it did not create"
# ===========================================================================

# install_source() and install_harbor() replace those trees wholesale, so
# adopting a user's directory of the same name destroys it at INSTALL time --
# before --uninstall ever gets a say. Refusing is also what makes "everything
# under src/ and harbor/ is Lem's" true, which is what lets uninstall remove
# them as units.
adopt="$WORK/adopt"
mkdir -p "$adopt/harbor"
printf 'their harbor notes\n' >"$adopt/harbor/notes.txt"

out="$( (LEM_HOME="$adopt"; assert_adoptable) 2>&1 )"; status=$?
assert_false $status "a pre-existing harbor/ that is not Harbor is refused"
assert_contains "$out" "Move it aside" "and the refusal says what to do"
assert_file_test -f "$adopt/harbor/notes.txt" "and nothing was touched"

printf '#!/bin/sh\n' >"$adopt/harbor/harbor.sh"
(LEM_HOME="$adopt"; assert_adoptable) >/dev/null 2>&1
assert_true $? "a real Harbor checkout is adopted"

mkdir -p "$adopt/src/theirs"
(LEM_HOME="$adopt"; assert_adoptable) >/dev/null 2>&1
assert_false $? "a pre-existing src/ that is not a Lem tree is refused"

make_fake_checkout "$adopt/src"
(LEM_HOME="$adopt"; assert_adoptable) >/dev/null 2>&1
assert_true $? "a real Lem source tree is adopted"

rm -rf "$adopt/src"
ln -s "$WORK/checkout" "$adopt/src"
(LEM_HOME="$adopt"; assert_adoptable) >/dev/null 2>&1
assert_true $? "a symlinked src/ (what --source writes) is fine"

# ===========================================================================
section "the start lock"
# ===========================================================================

# Two concurrent runs each saw "not healthy yet", each launched a server, and
# the PID file kept only the last writer: the other survived lem stop AND
# --uninstall, holding the port with its source deleted underneath it.
LEM_HOME="$WORK/locked"
DRY_RUN=0
LOCK_DIR=""
mkdir -p "$LEM_HOME/run"

lock_acquire
assert_true $? "the lock is acquired"
assert_file_test -d "$LEM_HOME/run/lock" "the lock directory exists"
assert_eq "$$" "$(cat "$LEM_HOME/run/lock/pid" 2>/dev/null)" "it records the holder's pid"

(LOCK_TIMEOUT=2; LOCK_DIR=""; lock_acquire) >/dev/null 2>&1
assert_false $? "a second run cannot take a lock that is held"

lock_release
assert_not_file_test -e "$LEM_HOME/run/lock" "releasing removes it"
lock_release
assert_true $? "releasing twice is harmless"

# A lock left behind by a killed process must not wedge every later run.
dead="$(sh -c 'printf "%s" "$$"')"
mkdir -p "$LEM_HOME/run/lock"
printf '%s\n' "$dead" >"$LEM_HOME/run/lock/pid"
# shellcheck disable=SC2034  # both are read by lock_acquire, from install.sh.
(LOCK_TIMEOUT=10; LOCK_DIR=""; lock_acquire) >/dev/null 2>&1
assert_true $? "a lock whose holder is gone is reclaimed"
rm -rf "$LEM_HOME/run/lock"

# ===========================================================================
section "the dead-holder reclaim is atomic"
# ===========================================================================

# "Re-read the pid, then rm -rf" is two operations. Another reclaimer can
# delete the directory and recreate it with its own live pid in that gap, and
# the rm -rf then destroys *its* lock -- leaving two runs both believing they
# hold one. These drive that exact interleaving by hand, deterministically,
# rather than hoping a timing test loses the race.
reclaim="$WORK/reclaim/lock"

mkdir -p "$reclaim"
printf '%s\n' "$dead" >"$reclaim/pid"
lock_reclaim "$reclaim" "$dead"
assert_true $? "a lock still held by the gone pid is reclaimed"
assert_not_file_test -e "$reclaim" "and the directory is removed"

# The race: by the time this reclaimer acts, someone else has already
# reclaimed and relocked, so the directory now carries a live pid.
mkdir -p "$reclaim"
printf '%s\n' "$$" >"$reclaim/pid"
lock_reclaim "$reclaim" "$dead"
assert_false $? "a lock relocked in the meantime is NOT reclaimed"
assert_file_test -e "$reclaim" "the new holder's lock survives"
assert_eq "$$" "$(cat "$reclaim/pid" 2>/dev/null)" "with its pid untouched"
assert_not_file_test -e "$reclaim/claim" "and no claim marker is left behind"

# Two reclaimers at the same instant: the claim marker lets exactly one act.
printf '%s\n' "$dead" >"$reclaim/pid"
mkdir "$reclaim/claim"
lock_reclaim "$reclaim" "$dead"
assert_false $? "a reclaim already claimed by another run is declined"
assert_file_test -e "$reclaim" "and the directory is left to the claimant"
rm -rf "$WORK/reclaim"

# A holder that died between mkdir and writing its pid leaves no pid at all.
mkdir -p "$reclaim"
lock_reclaim "$reclaim" ""
assert_true $? "a lock with no pid at all is reclaimable"
assert_not_file_test -e "$reclaim" "and is removed"
rm -rf "$WORK/reclaim"

# ---------------------------------------------------------------------------
# install.sh has to stay self-contained -- under `curl | bash` there is nothing
# on disk to source -- so the reclaim exists in both scripts. The fence turns
# that copy from a drift risk into an enforced invariant.
extract_reclaim() {
  sed -n '/^# >>> lock-reclaim/,/^# <<< lock-reclaim/p' "$1"
}
reclaim_install="$(extract_reclaim "$INSTALL_SH")"
reclaim_cli="$(extract_reclaim "$LEM_CLI")"

[ -n "$reclaim_install" ]
assert_true $? "install.sh carries the fenced reclaim block"
[ -n "$reclaim_cli" ]
assert_true $? "the CLI carries it too"
assert_eq "$reclaim_install" "$reclaim_cli" \
  "the reclaim block is byte-identical in both scripts"

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
