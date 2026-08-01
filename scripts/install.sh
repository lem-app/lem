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
# The Lem installer.
#
#   curl -fsSL https://raw.githubusercontent.com/lem-app/lem/main/scripts/install.sh | bash
#   ./scripts/install.sh --help
#
# LOCATION INDEPENDENCE
#   Nothing here is derived from $0 or ${BASH_SOURCE[0]}. Under `curl | bash`
#   the script has no path on disk: inside a function ${BASH_SOURCE[0]}
#   evaluates to the literal string "main", `dirname main` is ".", and `cd .`
#   SUCCEEDS -- so a script that locates itself that way silently adopts the
#   user's current directory as the repository root and then fails with a
#   confusing message. That is exactly what the previous installer did.
#
#   The source tree is resolved, in order, from:
#     1. --source DIR / $LEM_SOURCE
#     2. a verified Lem checkout at or above $PWD
#     3. a tarball downloaded from GitHub  (the `curl | bash` path)
#
# WHAT GETS INSTALLED
#   ~/.lem/src              Lem source (a symlink when installing from a checkout)
#   ~/.lem/harbor           Harbor CLI, pinned to $HARBOR_VERSION
#   ~/.lem/bin/lem          the CLI
#   ~/.lem/bin/lem-server   generated launcher; the ONLY place the server
#                           command line is spelled out
#   ~/.lem/config/          install.env (machine facts) + server.env (your knobs)
#   ~/.lem/{data,logs,run}/ runtime state
#   a systemd --user unit (Linux) or a LaunchAgent (macOS), unless --no-service
#
#   Nothing is installed as root. No sudo. Everything lands under $HOME, and
#   `--uninstall` removes all of it.
# ---------------------------------------------------------------------------

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

LEM_VERSION="0.1.0"

# Where the source comes from when it has to be downloaded.
LEM_REPO="${LEM_REPO:-lem-app/lem}"
LEM_REF="${LEM_REF:-main}"
LEM_SOURCE="${LEM_SOURCE:-}"

# Harbor (github.com/av/harbor) provides the compose definitions Lem drives.
HARBOR_VERSION="${HARBOR_VERSION:-v0.3.20}"

LEM_HOME="${LEM_HOME:-$HOME/.lem}"
LEM_PORT="${LEM_PORT:-5142}"

# Files that must exist for a directory to count as a Lem source tree.
readonly SOURCE_MARKERS=("server/pyproject.toml" "scripts/install.sh" "scripts/lem")

# Overridable so the test suite can point the WSL probe at a fixture.
LEM_PROC_VERSION="${LEM_PROC_VERSION:-/proc/version}"

# Marker fence around the PATH line we add to a shell rc file. Uninstall
# deletes exactly this block, and a re-install recognises it and adds nothing.
readonly PATH_BLOCK_BEGIN="# >>> lem >>>"
readonly PATH_BLOCK_END="# <<< lem <<<"

# Runtime flags, set by parse_args().
DRY_RUN=0
ASSUME_YES=0
MODE="install"
INSTALL_SERVICE=1
START_SERVER=1

# Filled in as the install progresses.
LEM_PLATFORM=""
LEM_IS_WSL=0
LEM_ARCH=""
LEM_SOURCE_MODE=""
LEM_SERVICE="none"
UV_BIN=""
SERVER_DIR=""
TMP_ROOT=""

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[1;33m'
  C_BLUE=$'\033[0;34m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_DIM=""; C_OFF=""
fi

info()    { printf '%s->%s %s\n' "$C_BLUE" "$C_OFF" "$1"; }
success() { printf '%s ok%s %s\n' "$C_GREEN" "$C_OFF" "$1"; }
warn()    { printf '%s  !%s %s\n' "$C_YELLOW" "$C_OFF" "$1" >&2; }
error()   { printf '%sERR%s %s\n' "$C_RED" "$C_OFF" "$1" >&2; }
detail()  { printf '%s    %s%s\n' "$C_DIM" "$1" "$C_OFF"; }

die() {
  error "$1"
  exit "${2:-1}"
}

# Run a mutating command, or describe it under --dry-run.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s    [dry-run] %s%s\n' "$C_DIM" "$*" "$C_OFF"
    return 0
  fi
  "$@"
}

# Write stdin to $1 with mode $2. Honours --dry-run.
write_file() {
  local path="$1" mode="${2:-644}" content
  content="$(cat)"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s    [dry-run] write %s (mode %s)%s\n' "$C_DIM" "$path" "$mode" "$C_OFF"
    return 0
  fi
  mkdir -p "${path%/*}"
  printf '%s\n' "$content" >"$path"
  chmod "$mode" "$path"
}

cleanup() {
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

usage() {
  cat <<'EOF'
Lem installer

USAGE
  curl -fsSL https://raw.githubusercontent.com/lem-app/lem/main/scripts/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/lem-app/lem/main/scripts/install.sh | bash -s -- --dry-run
  ./scripts/install.sh [OPTIONS]

OPTIONS
  -h, --help         Show this help and exit
      --version      Print the installer version and exit
      --dry-run      Show every step without changing anything
      --uninstall    Stop and remove Lem (services, ~/.lem, PATH entry, symlink)
      --no-service   Do not register a systemd/launchd service
      --no-start     Install but do not start the server
      --port PORT    Port for the local server (default: 5142)
      --ref REF      Git ref to download when not installing from a checkout
      --source DIR   Install from this checkout instead of downloading
  -y, --yes          Do not prompt (required for a non-interactive --uninstall)

ENVIRONMENT
  LEM_HOME           Install prefix (default: ~/.lem)
  LEM_PORT           Same as --port
  LEM_REF            Same as --ref
  LEM_SOURCE         Same as --source
  LEM_REPO           GitHub repo to download from (default: lem-app/lem)
  HARBOR_VERSION     Harbor tag to install (default: v0.3.20)

  LEM_HOST is deliberately NOT set by this installer. The server binds
  127.0.0.1 unless you opt in explicitly by editing ~/.lem/config/server.env.

NOTES
  Nothing is installed as root -- do not run this under sudo. On Linux the
  service is a systemd *user* unit, which needs no privileges and cannot
  leave a root-owned ~/.lem behind.
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help)    usage; exit 0 ;;
      --version)    printf 'lem installer %s\n' "$LEM_VERSION"; exit 0 ;;
      --dry-run)    DRY_RUN=1 ;;
      --uninstall)  MODE="uninstall" ;;
      --no-service) INSTALL_SERVICE=0 ;;
      --no-start)   START_SERVER=0 ;;
      -y|--yes)     ASSUME_YES=1 ;;
      --port)       shift; [ "$#" -gt 0 ] || die "--port needs a value"; LEM_PORT="$1" ;;
      --port=*)     LEM_PORT="${1#*=}" ;;
      --ref)        shift; [ "$#" -gt 0 ] || die "--ref needs a value"; LEM_REF="$1" ;;
      --ref=*)      LEM_REF="${1#*=}" ;;
      --source)     shift; [ "$#" -gt 0 ] || die "--source needs a value"; LEM_SOURCE="$1" ;;
      --source=*)   LEM_SOURCE="${1#*=}" ;;
      --systemd)
        die "--systemd was removed: the service is now a systemd user unit,
    which needs no privileges. Running the installer under sudo would only
    create a root-owned ~/.lem. Use --no-service to skip service registration."
        ;;
      -*)           die "Unknown option: $1 (try --help)" ;;
      *)            die "Unexpected argument: $1 (try --help)" ;;
    esac
    shift
  done

  case "$LEM_PORT" in
    ''|*[!0-9]*) die "Invalid port: $LEM_PORT" ;;
  esac
  if [ "$LEM_PORT" -lt 1 ] || [ "$LEM_PORT" -gt 65535 ]; then
    die "Invalid port: $LEM_PORT (must be 1-65535)"
  fi
}

# ---------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------

# Mirrors server/app/config/platform.py, which is the source of truth: Darwin
# is "macos", Linux is "linux", and WSL2 is a *flag* on linux rather than a
# platform of its own. The installer needs this before any Python exists, so
# one shell copy is unavoidable -- scripts/lem does NOT keep a second one, it
# reads the result out of ~/.lem/config/install.env. scripts/tests/install_test.sh
# asserts this function and the Python module agree.
detect_platform() {
  local os
  os="$(uname -s)"

  case "$os" in
    Darwin)
      LEM_PLATFORM="macos"
      LEM_IS_WSL=0
      ;;
    Linux)
      LEM_PLATFORM="linux"
      if grep -qi microsoft "$LEM_PROC_VERSION" 2>/dev/null; then
        LEM_IS_WSL=1
      else
        LEM_IS_WSL=0
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      die "Native Windows is not supported. Run Lem inside WSL2:

    1. Open PowerShell as Administrator
    2. Run: wsl --install
    3. Restart, open the Ubuntu terminal, and run this installer there"
      ;;
    *)
      die "Unsupported operating system: $os"
      ;;
  esac

  LEM_ARCH="$(uname -m)"
}

platform_label() {
  if [ "$LEM_IS_WSL" -eq 1 ]; then
    printf 'linux/wsl2 (%s)\n' "$LEM_ARCH"
  else
    printf '%s (%s)\n' "$LEM_PLATFORM" "$LEM_ARCH"
  fi
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

require_cmd() {
  have "$1" || die "$1 is required but was not found on PATH."
}

check_docker() {
  if ! have docker; then
    error "Docker is not installed."
    case "$LEM_PLATFORM" in
      macos)
        detail "Install Docker Desktop: https://docs.docker.com/desktop/install/mac-install/"
        detail "or: brew install --cask docker"
        ;;
      linux)
        if [ "$LEM_IS_WSL" -eq 1 ]; then
          detail "Install Docker Desktop for Windows and enable WSL2 integration:"
          detail "  https://docs.docker.com/desktop/install/windows-install/"
        else
          detail "curl -fsSL https://get.docker.com | sh"
          detail "sudo usermod -aG docker \$USER   # then log out and back in"
        fi
        ;;
    esac
    die "Install Docker, then re-run this installer. Nothing was installed."
  fi

  if ! docker info >/dev/null 2>&1; then
    error "Docker is installed but the daemon is not reachable."
    case "$LEM_PLATFORM" in
      macos) detail "Start Docker Desktop from your Applications folder." ;;
      linux)
        if [ "$LEM_IS_WSL" -eq 1 ]; then
          detail "Start Docker Desktop on Windows."
        else
          detail "sudo systemctl start docker"
          detail "If you use rootless Docker: systemctl --user start docker"
        fi
        ;;
    esac
    die "Start Docker, then re-run this installer. Nothing was installed."
  fi

  local version
  version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
  success "Docker $version, daemon reachable"
}

# Resolve uv, installing it if necessary. Sets $UV_BIN to an absolute path.
#
# The old installer wrote `ExecStart=$(which uv) ...` straight into a unit file;
# when uv had just been installed and was not yet on PATH that produced an
# invalid unit and enabled it anyway. Here the path is resolved once, verified
# non-empty, and baked into the generated launcher.
ensure_uv() {
  if ! have uv; then
    info "Installing uv (Python toolchain manager)"
    if [ "$DRY_RUN" -eq 1 ]; then
      detail "[dry-run] curl -LsSf https://astral.sh/uv/install.sh | sh"
    else
      # `set -o pipefail` is what makes this failure visible: without it the
      # exit status of curl is discarded and a failed download looks like a
      # successful install.
      curl -LsSf https://astral.sh/uv/install.sh | sh
      export PATH="$HOME/.local/bin:$PATH"
      hash -r 2>/dev/null || true
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ] && ! have uv; then
    UV_BIN="uv"
    return 0
  fi

  UV_BIN="$(command -v uv || true)"
  [ -n "$UV_BIN" ] || die "uv was installed but is not on PATH. Open a new shell and re-run."
  success "uv at $UV_BIN"
}

# ---------------------------------------------------------------------------
# Source tree
# ---------------------------------------------------------------------------

is_source_tree() {
  local dir="$1" marker
  for marker in "${SOURCE_MARKERS[@]}"; do
    [ -f "$dir/$marker" ] || return 1
  done
  return 0
}

# Walk up from $PWD looking for a Lem checkout. Deliberately parameter-free and
# based on the working directory, never on the script's own (nonexistent) path.
# Every candidate must carry all the marker files, so an unrelated directory can
# never be mistaken for the repository root.
find_checkout_root() {
  local dir="$PWD"
  while [ -n "$dir" ]; do
    if is_source_tree "$dir"; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="${dir%/*}"
  done
  if is_source_tree "/"; then
    printf '/\n'
    return 0
  fi
  return 1
}

download_source() {
  local url="https://codeload.github.com/$LEM_REPO/tar.gz/$LEM_REF"
  local dest="$LEM_HOME/src"

  info "Downloading $LEM_REPO@$LEM_REF"
  detail "$url"

  if [ "$DRY_RUN" -eq 1 ]; then
    detail "[dry-run] extract to $dest"
    return 0
  fi

  TMP_ROOT="$(mktemp -d)"
  local staged="$TMP_ROOT/src"
  mkdir -p "$staged"
  curl -fsSL "$url" -o "$TMP_ROOT/lem.tar.gz" ||
    die "Download failed: $url
    Check the ref exists (--ref) and that you have network access."
  tar -xzf "$TMP_ROOT/lem.tar.gz" -C "$staged" --strip-components=1 ||
    die "Could not extract the downloaded archive"

  is_source_tree "$staged" ||
    die "The downloaded archive does not look like a Lem source tree"

  # Swap the tree atomically enough that an interrupted install never leaves a
  # half-extracted src/ in place. The virtualenv is carried across so that
  # re-running the installer is fast instead of re-resolving every dependency.
  mkdir -p "$LEM_HOME"
  rm -rf "$LEM_HOME/src.previous"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    mv "$dest" "$LEM_HOME/src.previous"
  fi
  if [ -d "$LEM_HOME/src.previous/server/.venv" ]; then
    mv "$LEM_HOME/src.previous/server/.venv" "$staged/server/.venv"
  fi
  mv "$staged" "$dest"
  rm -rf "$LEM_HOME/src.previous"

  success "Source installed to $dest"
}

link_source() {
  local root="$1" dest="$LEM_HOME/src"

  is_source_tree "$root" || die "Not a Lem source tree: $root"
  # Absolute, or the symlink would resolve relative to ~/.lem and dangle.
  root="$(cd "$root" && pwd)"
  info "Installing from checkout $root"

  if [ "$DRY_RUN" -eq 1 ]; then
    detail "[dry-run] symlink $dest -> $root"
    return 0
  fi

  mkdir -p "$LEM_HOME"
  # A previous download leaves a real directory here; ln would refuse to
  # replace it (and -f without -n would follow it and link *inside*).
  if [ -d "$dest" ] && [ ! -L "$dest" ]; then
    rm -rf "$dest"
  fi
  ln -sfn "$root" "$dest"
  success "Source linked: $dest -> $root"
}

install_source() {
  local checkout
  if [ -n "$LEM_SOURCE" ]; then
    LEM_SOURCE_MODE="checkout"
    link_source "$LEM_SOURCE"
  elif checkout="$(find_checkout_root)"; then
    LEM_SOURCE_MODE="checkout"
    link_source "$checkout"
  else
    LEM_SOURCE_MODE="download"
    download_source
  fi
  SERVER_DIR="$LEM_HOME/src/server"
}

# Always re-sync. The old installer returned early whenever
# ~/.lem/server/pyproject.toml existed, so `uv sync` never ran again after an
# upgrade and the venv silently drifted from the lockfile.
install_python_deps() {
  info "Syncing Python dependencies (uv sync)"
  if [ "$DRY_RUN" -eq 1 ]; then
    detail "[dry-run] (cd $SERVER_DIR && $UV_BIN sync)"
    return 0
  fi
  (cd "$SERVER_DIR" && "$UV_BIN" sync) || die "uv sync failed in $SERVER_DIR"
  success "Python dependencies ready"
}

# ---------------------------------------------------------------------------
# Harbor
# ---------------------------------------------------------------------------

harbor_stamp_path() {
  printf '%s/.lem-harbor-version\n' "$1"
}

# True when $1 already holds a usable Harbor of version $2.
harbor_is_current() {
  local dir="$1" want="$2" stamp
  stamp="$(harbor_stamp_path "$dir")"
  [ -f "$stamp" ] || return 1
  [ -x "$dir/harbor.sh" ] || return 1
  [ "$(cat "$stamp")" = "$want" ]
}

install_harbor() {
  local dir="$LEM_HOME/harbor"

  if harbor_is_current "$dir" "$HARBOR_VERSION"; then
    success "Harbor $HARBOR_VERSION already installed"
    return 0
  fi

  info "Installing Harbor $HARBOR_VERSION"
  if [ "$DRY_RUN" -eq 1 ]; then
    detail "[dry-run] extract av/harbor@$HARBOR_VERSION to $dir"
    return 0
  fi

  # A tarball rather than a git clone: it keeps git off the prerequisite list
  # and pins the version by construction. Harbor only shells out to git for its
  # own `update`/version-switch commands, which Lem does not use.
  local tmp
  tmp="$(mktemp -d)"
  local staged="$tmp/harbor"
  mkdir -p "$staged"
  curl -fsSL "https://codeload.github.com/av/harbor/tar.gz/refs/tags/$HARBOR_VERSION" \
    -o "$tmp/harbor.tar.gz" || { rm -rf "$tmp"; die "Could not download Harbor $HARBOR_VERSION"; }
  tar -xzf "$tmp/harbor.tar.gz" -C "$staged" --strip-components=1 ||
    { rm -rf "$tmp"; die "Could not extract Harbor $HARBOR_VERSION"; }

  # Harbor writes its own .env on first run; keep the user's across upgrades.
  if [ -f "$dir/.env" ]; then
    cp "$dir/.env" "$staged/.env"
  fi

  mkdir -p "$LEM_HOME"
  rm -rf "$dir.previous"
  if [ -e "$dir" ]; then
    mv "$dir" "$dir.previous"
  fi
  mv "$staged" "$dir"
  rm -rf "$dir.previous" "$tmp"

  chmod +x "$dir/harbor.sh"
  printf '%s\n' "$HARBOR_VERSION" >"$(harbor_stamp_path "$dir")"

  "$dir/harbor.sh" --version >/dev/null 2>&1 ||
    die "Harbor installed but 'harbor.sh --version' failed"
  success "Harbor $HARBOR_VERSION installed to $dir"
}

# ---------------------------------------------------------------------------
# Port
# ---------------------------------------------------------------------------

port_is_free() {
  local port="$1"
  # The connect attempt runs in a subshell, so its descriptor dies with the
  # subshell and there is nothing to close here. Closing it in *this* shell
  # would need `exec 3<&- 2>/dev/null`, and an `exec` carrying a redirection
  # but no command makes that redirection permanent -- which silently sent
  # every later warning on stderr to /dev/null.
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    return 1
  fi
  return 0
}

# True when whatever is listening on $1 answers Lem's health endpoint.
port_is_lem() {
  curl -fsS -m 2 "http://127.0.0.1:$1/v1/health" 2>/dev/null | grep -q '"status"'
}

# "Port 5142 occupied -> pick the next free port and say so; never fail."
resolve_port() {
  if port_is_free "$LEM_PORT"; then
    return 0
  fi
  if port_is_lem "$LEM_PORT"; then
    success "A Lem server is already listening on port $LEM_PORT"
    return 0
  fi

  local candidate=$((LEM_PORT + 1)) limit=$((LEM_PORT + 20))
  while [ "$candidate" -le "$limit" ]; do
    if port_is_free "$candidate"; then
      warn "Port $LEM_PORT is in use by something else; using $candidate instead."
      LEM_PORT="$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
  done
  die "Ports $LEM_PORT-$limit are all in use. Free one, or pass --port."
}

# ---------------------------------------------------------------------------
# Generated files
# ---------------------------------------------------------------------------

# The server command line lives in exactly one place: this launcher. The
# systemd unit, the LaunchAgent and `lem start` all exec it, so none of them
# can drift from the others (the old installer spelled out five separate
# `uvicorn --host 0.0.0.0` invocations).
write_launcher() {
  local launcher="$LEM_HOME/bin/lem-server"

  if [ "$DRY_RUN" -eq 1 ] && [ ! -d "$SERVER_DIR" ]; then
    detail "[dry-run] write $launcher"
    return 0
  fi

  # `lem-serve` (server/app/serve.py) is the only supported entrypoint: it
  # binds the socket, reads the address back with getsockname(), and derives
  # the API's auth posture from what the kernel actually bound. Hand-rolling
  # `uvicorn app.main:app --host ...` splits that decision in two, which is how
  # a Docker control plane once ended up on the network while the log claimed
  # loopback. So there is no fallback here: an old source is refused, not
  # quietly started a less safe way.
  if [ ! -f "$SERVER_DIR/app/serve.py" ]; then
    die "This source has no server/app/serve.py, so it predates the lem-serve
    entrypoint (PR #25). Re-run with a newer ref, e.g. --ref main."
  fi

  write_file "$launcher" 755 <<EOF
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Generated by the Lem installer -- edit ~/.lem/config/server.env instead.
set -euo pipefail

export PATH="${UV_BIN%/*}:\$PATH"
export LEM_PORT="\${LEM_PORT:-$LEM_PORT}"

# Your knobs (LEM_HOST, LEM_PORT, LEM_ALLOWED_ORIGINS, ...). Read here and by
# the service unit, so both paths see the same configuration.
if [ -f "$LEM_HOME/config/server.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$LEM_HOME/config/server.env"
  set +a
fi

cd "$SERVER_DIR"
exec "$UV_BIN" run lem-serve
EOF
  success "Launcher written to $launcher"
}

# The one place a user opts into LAN exposure. Never overwritten on re-install:
# it is configuration, not managed state.
write_server_env() {
  local path="$LEM_HOME/config/server.env"
  if [ -f "$path" ]; then
    detail "Keeping existing $path"
    return 0
  fi
  write_file "$path" 600 <<EOF
# Lem server configuration. Sourced by ~/.lem/bin/lem-server and by the
# service unit. Restart with 'lem restart' after editing.

LEM_PORT=$LEM_PORT

# The server binds 127.0.0.1 by default: reaching it already requires access to
# this machine. Uncommenting the next line publishes a Docker control plane to
# your network. Do it only if you understand that, and note that the server
# then REQUIRES 'Authorization: Bearer <token>' on every /v1/* request, using
# the token in ~/.lem/api_token.
#LEM_HOST=0.0.0.0

# Extra browser origins allowed to drive the API (comma separated). Needed if
# you serve the dashboard from another host after setting LEM_HOST.
#LEM_ALLOWED_ORIGINS=http://192.168.1.10:5173
EOF
}

# Machine facts recorded once, read by scripts/lem. This is why the CLI carries
# no platform detection of its own. Values are quoted: an install prefix with a
# space in it must not turn into a syntax error when the CLI sources this.
write_install_env() {
  write_file "$LEM_HOME/config/install.env" 644 <<EOF
# Generated by the Lem installer. Regenerated on every install; do not edit.
LEM_INSTALL_FORMAT=1
LEM_INSTALLER_VERSION="$LEM_VERSION"
LEM_INSTALLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LEM_PLATFORM="$LEM_PLATFORM"
LEM_IS_WSL="$LEM_IS_WSL"
LEM_ARCH="$LEM_ARCH"
LEM_HOME="$LEM_HOME"
LEM_PORT="$LEM_PORT"
LEM_SERVER_DIR="$SERVER_DIR"
LEM_LAUNCHER="$LEM_HOME/bin/lem-server"
LEM_LOG_FILE="$LEM_HOME/logs/lem.log"
LEM_PID_FILE="$LEM_HOME/run/lem.pid"
LEM_SERVICE="$LEM_SERVICE"
LEM_SERVICE_NAME="$(service_name)"
LEM_SOURCE_MODE="$LEM_SOURCE_MODE"
EOF
}

service_name() {
  case "$LEM_SERVICE" in
    systemd-user) printf 'lem.service\n' ;;
    launchd)      printf 'gg.lem.server\n' ;;
    *)            printf '\n' ;;
  esac
}

# ---------------------------------------------------------------------------
# CLI on PATH
# ---------------------------------------------------------------------------

install_cli() {
  local bin_dir="$LEM_HOME/bin"

  info "Installing the lem CLI"
  if [ "$DRY_RUN" -eq 1 ]; then
    detail "[dry-run] install $bin_dir/lem"
  else
    mkdir -p "$bin_dir"
    cp "$LEM_HOME/src/scripts/lem" "$bin_dir/lem"
    chmod 755 "$bin_dir/lem"
  fi

  case ":$PATH:" in
    *":$bin_dir:"*)
      success "lem CLI at $bin_dir/lem (already on PATH)"
      return 0
      ;;
  esac

  # Prefer a symlink from a directory that is already on PATH: no shell rc file
  # is touched at all, and a new terminal is not required.
  local user_bin="$HOME/.local/bin"
  case ":$PATH:" in
    *":$user_bin:"*)
      if link_cli_into "$user_bin" "$bin_dir/lem"; then
        success "lem CLI linked into $user_bin"
        return 0
      fi
      ;;
  esac

  local rc_file status=0
  rc_file="$(shell_rc_file)"
  path_block_add "$rc_file" "$bin_dir" || status=$?
  case "$status" in
    0)
      success "Added $bin_dir to PATH in $rc_file"
      warn "Open a new terminal (or: source $rc_file) before using 'lem'."
      ;;
    1)
      success "PATH entry already present in $rc_file"
      ;;
    *)
      warn "Add $bin_dir to your PATH yourself, or run $bin_dir/lem directly."
      ;;
  esac
}

# Symlink $2 into directory $1, never clobbering a foreign binary.
link_cli_into() {
  local dir="$1" target="$2" existing="$1/lem"

  if [ -e "$existing" ] || [ -L "$existing" ]; then
    local resolved=""
    if [ -L "$existing" ]; then
      resolved="$(readlink "$existing")"
    fi
    if [ "$resolved" != "$target" ]; then
      warn "$existing already exists and is not ours; leaving it alone."
      return 1
    fi
  fi

  run ln -sfn "$target" "$existing"
  return 0
}

# The single rc file to edit, chosen from the user's login shell. The old
# installer appended to .bashrc AND .zshrc AND .profile, which double-adds the
# PATH entry for a bash login shell.
shell_rc_file() {
  local login_shell="${SHELL:-/bin/sh}"
  case "${login_shell##*/}" in
    zsh)
      printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc"
      ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        printf '%s\n' "$HOME/.bashrc"
      else
        printf '%s\n' "$HOME/.profile"
      fi
      ;;
    *)
      printf '%s\n' "$HOME/.profile"
      ;;
  esac
}

# Append the fenced PATH block to $1 unless it is already there.
# Returns 0 when it added the block, 1 when the fence is already present,
# 2 when the file mentions .lem/bin some other way (left untouched).
path_block_add() {
  local rc_file="$1" bin_dir="$2"

  if [ -f "$rc_file" ] && grep -qF "$PATH_BLOCK_BEGIN" "$rc_file"; then
    return 1
  fi
  if [ -f "$rc_file" ] && grep -qF '.lem/bin' "$rc_file"; then
    warn "$rc_file already mentions .lem/bin outside Lem's markers; leaving it alone."
    return 2
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    detail "[dry-run] append PATH block to $rc_file"
    return 0
  fi

  mkdir -p "${rc_file%/*}"
  # Start on a line of our own without adding a blank one: adding then
  # removing the block has to leave the file byte-identical, or every
  # install/uninstall cycle grows the rc file.
  if [ -s "$rc_file" ] && [ -n "$(tail -c 1 "$rc_file")" ]; then
    printf '\n' >>"$rc_file"
  fi
  {
    printf '%s\n' "$PATH_BLOCK_BEGIN"
    # shellcheck disable=SC2016  # $PATH must stay literal in the rc file.
    printf 'export PATH="%s:$PATH"\n' "$bin_dir"
    printf '%s\n' "$PATH_BLOCK_END"
  } >>"$rc_file"
  return 0
}

# Delete the fenced block (markers included) from $1.
# Returns 0 if something was removed.
path_block_remove() {
  local rc_file="$1" tmp

  [ -f "$rc_file" ] || return 1
  grep -qF "$PATH_BLOCK_BEGIN" "$rc_file" || return 1

  if [ "$DRY_RUN" -eq 1 ]; then
    detail "[dry-run] remove PATH block from $rc_file"
    return 0
  fi

  tmp="$(mktemp)"
  # Deletes the fence and everything between it. The markers contain no
  # regex metacharacters, so they are safe as sed addresses.
  sed "/^$PATH_BLOCK_BEGIN\$/,/^$PATH_BLOCK_END\$/d" "$rc_file" >"$tmp"
  # Truncate in place rather than mv: preserves the file's mode and, more
  # importantly, its inode -- an already-open shell rc keeps working.
  cat "$tmp" >"$rc_file"
  rm -f "$tmp"
  return 0
}

# ---------------------------------------------------------------------------
# Service registration
# ---------------------------------------------------------------------------

systemd_user_available() {
  have systemctl || return 1
  systemctl --user show-environment >/dev/null 2>&1
}

install_service() {
  if [ "$INSTALL_SERVICE" -eq 0 ]; then
    LEM_SERVICE="none"
    detail "Skipping service registration (--no-service)"
    return 0
  fi

  case "$LEM_PLATFORM" in
    linux)
      if systemd_user_available; then
        install_systemd_user_unit
      else
        LEM_SERVICE="none"
        warn "No usable systemd user session; the server will run under 'lem start'."
      fi
      ;;
    macos)
      install_launch_agent
      ;;
  esac
}

install_systemd_user_unit() {
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local unit="$unit_dir/lem.service"

  info "Registering systemd user service"
  [ -n "$UV_BIN" ] || die "Refusing to write a unit file without a resolved uv path"

  write_file "$unit" 644 <<EOF
# Generated by the Lem installer.
[Unit]
Description=Lem local server
Documentation=https://github.com/lem-app/lem
# Wants=, never Requires=: docker.service may be a system unit (rootful
# Docker), a user unit (rootless Docker), or absent entirely (Docker Desktop
# for Linux). Requires= turns every one of those into a hard start failure.
Wants=docker.service
After=docker.service network-online.target

[Service]
Type=simple
ExecStart=$LEM_HOME/bin/lem-server
EnvironmentFile=-$LEM_HOME/config/server.env
Restart=on-failure
RestartSec=5
# A SIGTERM stop leaves uvicorn with status 143, which systemd would otherwise
# record as a failure and leave the unit sitting in a failed state after every
# 'lem stop'.
SuccessExitStatus=143
StandardOutput=append:$LEM_HOME/logs/lem.log
StandardError=append:$LEM_HOME/logs/lem.log

[Install]
WantedBy=default.target
EOF

  run systemctl --user daemon-reload
  run systemctl --user enable lem.service >/dev/null 2>&1 || true
  LEM_SERVICE="systemd-user"
  success "systemd user unit installed: $unit"
  detail "Runs as you, no sudo, no root-owned files."
  detail "To start it at boot without logging in: sudo loginctl enable-linger ${USER:-$(id -un)}"
}

install_launch_agent() {
  local plist="$HOME/Library/LaunchAgents/gg.lem.server.plist"

  info "Registering launchd agent"
  write_file "$plist" 644 <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>gg.lem.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>$LEM_HOME/bin/lem-server</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LEM_HOME/logs/lem.log</string>
    <key>StandardErrorPath</key>
    <string>$LEM_HOME/logs/lem.log</string>
</dict>
</plist>
EOF

  LEM_SERVICE="launchd"
  success "LaunchAgent installed: $plist"
}

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

start_server() {
  if [ "$START_SERVER" -eq 0 ]; then
    detail "Not starting the server (--no-start). Run 'lem start' when ready."
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    detail "[dry-run] $LEM_HOME/bin/lem start"
    return 0
  fi

  info "Starting the Lem server"
  # Delegated to the CLI so that the installer and `lem start` can never
  # disagree about how the server is launched.
  if ! "$LEM_HOME/bin/lem" start; then
    error "The server did not become healthy."
    detail "Logs: $LEM_HOME/logs/lem.log"
    if [ -f "$LEM_HOME/logs/lem.log" ]; then
      tail -n 20 "$LEM_HOME/logs/lem.log" >&2 || true
    fi
    return 1
  fi
}

open_browser() {
  local url="$1"
  [ "$DRY_RUN" -eq 0 ] || return 0
  [ -t 1 ] || return 0

  case "$LEM_PLATFORM" in
    macos)
      open "$url" >/dev/null 2>&1 || true
      ;;
    linux)
      if [ "$LEM_IS_WSL" -eq 1 ]; then
        # `start` treats its first quoted argument as the window title, so the
        # empty string is mandatory -- without it the URL is swallowed and a
        # console window opens instead of a browser.
        cmd.exe /c start "" "$url" >/dev/null 2>&1 || true
      else
        (xdg-open "$url" >/dev/null 2>&1 || true) &
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

confirm() {
  local prompt="$1" reply

  [ "$ASSUME_YES" -eq 0 ] || return 0

  if [ -r /dev/tty ] && [ -t 0 ]; then
    printf '%s [y/N] ' "$prompt" >&2
    read -r reply </dev/tty || reply=""
    case "$reply" in
      y|Y|yes|YES) return 0 ;;
      *) return 1 ;;
    esac
  fi

  die "Refusing to continue without confirmation. Re-run with --yes."
}

uninstall() {
  printf '\n%sUninstalling Lem%s\n\n' "$C_BLUE" "$C_OFF"
  detect_platform

  if [ ! -d "$LEM_HOME" ]; then
    warn "$LEM_HOME does not exist; cleaning up stray entries only."
  fi

  if [ "$DRY_RUN" -eq 0 ]; then
    confirm "Remove $LEM_HOME (source, Harbor, logs, data, API token)?" ||
      die "Aborted; nothing was removed."
  fi

  # 1. Stop and deregister the service.
  if have systemctl; then
    run systemctl --user stop lem.service >/dev/null 2>&1 || true
    run systemctl --user disable lem.service >/dev/null 2>&1 || true
    # Without this the unit lingers in systemd's state as "failed" long after
    # its file is gone, and shows up in `systemctl --user status`.
    run systemctl --user reset-failed lem.service >/dev/null 2>&1 || true
  fi
  local unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/lem.service"
  if [ -f "$unit" ]; then
    run rm -f "$unit"
    run systemctl --user daemon-reload >/dev/null 2>&1 || true
    success "Removed systemd user unit"
  fi

  local plist="$HOME/Library/LaunchAgents/gg.lem.server.plist"
  if [ -f "$plist" ]; then
    if have launchctl; then
      run launchctl bootout "gui/$(id -u)/gg.lem.server" >/dev/null 2>&1 || true
      run launchctl unload "$plist" >/dev/null 2>&1 || true
    fi
    run rm -f "$plist"
    success "Removed LaunchAgent"
  fi

  # 2. Stop a detached server, by PID file -- never pkill.
  stop_by_pidfile

  # 3. Remove the symlink, but only when it is ours.
  local link="$HOME/.local/bin/lem"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$LEM_HOME/bin/lem" ]; then
    run rm -f "$link"
    success "Removed $link"
  elif [ -e "$link" ]; then
    warn "$link exists but does not point at Lem; leaving it alone."
  fi

  # 4. Remove the PATH block from every rc file that could carry it.
  local rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.profile"; do
    if path_block_remove "$rc"; then
      success "Removed the PATH block from $rc"
    fi
  done

  # 5. Remove the install prefix. src/ may be a symlink into a git checkout:
  #    rm -rf removes the link, never the checkout behind it.
  if [ -d "$LEM_HOME" ]; then
    run rm -rf "$LEM_HOME"
    success "Removed $LEM_HOME"
  fi

  printf '\n'
  success "Lem is uninstalled."
  detail "Docker containers and images created through Harbor are untouched."
  detail "Review them with: docker ps -a"
}

# Stop a nohup-launched server using the PID file the CLI writes.
stop_by_pidfile() {
  local pid_file="$LEM_HOME/run/lem.pid" pid

  [ -f "$pid_file" ] || return 0
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) return 0 ;;
  esac

  if kill -0 "$pid" 2>/dev/null; then
    run kill "$pid" 2>/dev/null || true
    success "Stopped the Lem server (pid $pid)"
  fi
  run rm -f "$pid_file"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

print_banner() {
  printf '\n%sLem installer%s  (v%s)\n\n' "$C_BLUE" "$C_OFF" "$LEM_VERSION"
}

print_completion() {
  local url="http://127.0.0.1:$LEM_PORT"

  printf '\n'
  success "Lem is installed."
  printf '\n'
  printf '  API          %s/v1/health\n' "$url"
  printf '  API docs     %s/docs\n' "$url"
  printf '  Logs         %s\n' "$LEM_HOME/logs/lem.log"
  printf '  Config       %s\n' "$LEM_HOME/config/server.env"
  printf '\n'
  printf '  Commands     lem status | lem logs | lem stop | lem --help\n'
  printf '\n'
  # Honest about what does not exist yet: the server has no static mount, so
  # the React dashboard is still a separate dev server. Do not print a URL
  # that would 404.
  if [ -d "$LEM_HOME/src/web/local" ]; then
    printf '  The dashboard is not yet served by the server. From your checkout:\n'
    printf '    cd web/local && pnpm install && pnpm run dev   -> http://localhost:5174\n\n'
  fi
  printf '  The server listens on 127.0.0.1 only. To reach it from your LAN,\n'
  printf '  read the comments in %s/config/server.env first.\n\n' "$LEM_HOME"
}

main() {
  parse_args "$@"

  if [ "$MODE" = "uninstall" ]; then
    uninstall
    return 0
  fi

  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    die "Do not run the installer under sudo: it would create a root-owned
    ~/.lem that your own user cannot write. Re-run it as yourself."
  fi

  print_banner
  detect_platform
  success "Platform      $(platform_label)"
  require_cmd curl
  require_cmd tar
  check_docker
  ensure_uv

  run mkdir -p "$LEM_HOME/data" "$LEM_HOME/logs" "$LEM_HOME/config" "$LEM_HOME/run"

  install_source
  install_python_deps
  install_harbor
  resolve_port
  write_server_env
  write_launcher
  install_cli
  install_service
  write_install_env

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\n'
    success "Dry run complete. Nothing was changed."
    return 0
  fi

  start_server
  open_browser "http://127.0.0.1:$LEM_PORT/docs"
  print_completion
}

# Sourced by scripts/tests/install_test.sh, which exercises the functions above
# without running an install. An env guard rather than the usual
# `[ "${BASH_SOURCE[0]}" = "$0" ]`: this script must not reference either.
if [ "${LEM_INSTALL_SH_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi
