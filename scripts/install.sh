#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2025 Lem
#
# Lem Installation Script
#
# Usage:
#   curl -sSf https://lem.gg/install | bash
#   # or
#   ./scripts/install.sh
#
# This script:
# 1. Detects your platform (macOS, Linux, Windows WSL2)
# 2. Checks for Docker
# 3. Installs Harbor CLI
# 4. Creates Lem directories
# 5. Installs and starts the Lem server
# 6. Opens the dashboard in your browser

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
LEM_VERSION="${LEM_VERSION:-0.1.0}"
HARBOR_VERSION="${HARBOR_VERSION:-v0.3.20}"
LEM_HOME="$HOME/.lem"
LEM_PORT="${LEM_PORT:-5142}"

# Logging functions
info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

die() {
    error "$1"
    exit 1
}

# Platform detection
detect_platform() {
    local os
    os="$(uname -s)"

    case "$os" in
        Darwin)
            PLATFORM="macos"
            ;;
        Linux)
            # Check if running in WSL
            if grep -qi microsoft /proc/version 2>/dev/null; then
                PLATFORM="wsl"
            else
                PLATFORM="linux"
            fi
            ;;
        MINGW*|MSYS*|CYGWIN*)
            die "Please run this script inside WSL2 on Windows.

To install WSL2:
  1. Open PowerShell as Administrator
  2. Run: wsl --install
  3. Restart your computer
  4. Run this script inside the WSL2 terminal"
            ;;
        *)
            die "Unsupported operating system: $os"
            ;;
    esac

    ARCH="$(uname -m)"
    success "Detected platform: $PLATFORM ($ARCH)"
}

# Check for required commands
check_command() {
    if ! command -v "$1" &> /dev/null; then
        return 1
    fi
    return 0
}

# Check Docker installation
check_docker() {
    info "Checking Docker installation..."

    if ! check_command docker; then
        error "Docker is not installed."
        echo ""
        case "$PLATFORM" in
            macos)
                echo "Install Docker Desktop for Mac:"
                echo "  https://docs.docker.com/desktop/install/mac-install/"
                echo ""
                echo "Or with Homebrew:"
                echo "  brew install --cask docker"
                ;;
            linux)
                echo "Install Docker Engine:"
                echo "  https://docs.docker.com/engine/install/"
                echo ""
                echo "For Ubuntu/Debian:"
                echo "  curl -fsSL https://get.docker.com | sh"
                echo "  sudo usermod -aG docker \$USER"
                echo "  # Log out and back in"
                ;;
            wsl)
                echo "Install Docker Desktop for Windows with WSL2 backend:"
                echo "  https://docs.docker.com/desktop/install/windows-install/"
                echo ""
                echo "Make sure to enable WSL2 integration in Docker Desktop settings."
                ;;
        esac
        exit 1
    fi

    # Check if Docker daemon is running
    if ! docker info &> /dev/null; then
        error "Docker is installed but not running."
        echo ""
        case "$PLATFORM" in
            macos)
                echo "Start Docker Desktop from your Applications folder."
                ;;
            linux)
                echo "Start Docker with:"
                echo "  sudo systemctl start docker"
                ;;
            wsl)
                echo "Start Docker Desktop on Windows."
                ;;
        esac
        exit 1
    fi

    # Check Docker Compose
    if ! docker compose version &> /dev/null; then
        if ! check_command docker-compose; then
            warn "Docker Compose not found. Some features may not work."
        fi
    fi

    success "Docker is installed and running"
}

# Check for Git
check_git() {
    info "Checking Git installation..."

    if ! check_command git; then
        error "Git is not installed."
        echo ""
        case "$PLATFORM" in
            macos)
                echo "Install Git with Homebrew:"
                echo "  brew install git"
                ;;
            linux|wsl)
                echo "Install Git:"
                echo "  sudo apt install git"
                ;;
        esac
        exit 1
    fi

    success "Git is installed"
}

# Install Harbor CLI
install_harbor() {
    info "Installing Harbor CLI ${HARBOR_VERSION}..."

    local harbor_dir="$LEM_HOME/harbor"

    if [ -d "$harbor_dir/.git" ]; then
        # Check if correct version
        local current_version
        current_version=$(cd "$harbor_dir" && git describe --tags 2>/dev/null || echo "unknown")

        if [ "$current_version" = "$HARBOR_VERSION" ]; then
            success "Harbor CLI ${HARBOR_VERSION} already installed"
            return 0
        fi

        info "Updating Harbor CLI from ${current_version} to ${HARBOR_VERSION}..."
        (cd "$harbor_dir" && git fetch --tags && git checkout "$HARBOR_VERSION") || {
            warn "Failed to update Harbor, reinstalling..."
            rm -rf "$harbor_dir"
        }
    fi

    if [ ! -d "$harbor_dir/.git" ]; then
        git clone --depth 1 --branch "$HARBOR_VERSION" \
            https://github.com/av/harbor.git "$harbor_dir" || \
            die "Failed to clone Harbor CLI"
    fi

    # Make script executable
    chmod +x "$harbor_dir/harbor.sh"

    # Verify installation
    if ! "$harbor_dir/harbor.sh" --version &> /dev/null; then
        die "Harbor CLI installation verification failed"
    fi

    success "Harbor CLI ${HARBOR_VERSION} installed to $harbor_dir"
}

# Create Lem directories
create_directories() {
    info "Creating Lem directories..."

    mkdir -p "$LEM_HOME"/{data,logs,config}

    success "Created directories in $LEM_HOME"
}

# Check for Python and uv
check_python() {
    info "Checking Python installation..."

    # Check for uv (preferred)
    if check_command uv; then
        success "uv is installed"
        PYTHON_RUNNER="uv run"
        return 0
    fi

    # Check for Python 3.11+
    local python_cmd=""
    for cmd in python3.12 python3.11 python3; do
        if check_command "$cmd"; then
            local version
            version=$($cmd -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
            local major minor
            major=$(echo "$version" | cut -d. -f1)
            minor=$(echo "$version" | cut -d. -f2)

            if [ "$major" -ge 3 ] && [ "$minor" -ge 11 ]; then
                python_cmd="$cmd"
                break
            fi
        fi
    done

    if [ -z "$python_cmd" ]; then
        warn "Python 3.11+ not found."
        echo ""
        echo "Installing uv (recommended Python manager)..."
        curl -LsSf https://astral.sh/uv/install.sh | sh

        # Source the shell config to get uv in PATH
        export PATH="$HOME/.local/bin:$PATH"

        if ! check_command uv; then
            die "Failed to install uv. Please install Python 3.11+ manually."
        fi

        PYTHON_RUNNER="uv run"
        success "uv installed successfully"
    else
        success "Python $version found ($python_cmd)"
        PYTHON_RUNNER="$python_cmd"
    fi
}

# Install Lem server
install_lem_server() {
    info "Setting up Lem server..."

    # For now, we run from the source directory
    # In future, we'll support pip install or Docker

    local server_dir="$LEM_HOME/server"

    # Check if already installed from source
    if [ -d "$server_dir" ] && [ -f "$server_dir/pyproject.toml" ]; then
        success "Lem server already installed"
        return 0
    fi

    # Check if running from git checkout
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local repo_root="$(dirname "$script_dir")"

    if [ -f "$repo_root/server/pyproject.toml" ]; then
        info "Running from source repository..."

        # Symlink server to LEM_HOME
        if [ ! -e "$server_dir" ]; then
            ln -sf "$repo_root/server" "$server_dir"
        fi

        # Install dependencies
        if check_command uv; then
            (cd "$server_dir" && uv sync) || die "Failed to install dependencies"
        else
            (cd "$server_dir" && pip install -e .) || die "Failed to install dependencies"
        fi

        success "Lem server configured from source"
        return 0
    fi

    # TODO: Support installation from PyPI or Docker
    warn "Source installation only supported for now."
    echo ""
    echo "Clone the repository first:"
    echo "  git clone https://github.com/lem-app/lem.git"
    echo "  cd lem/lem-app/scripts"
    echo "  ./install.sh"
    exit 1
}

# Create systemd service (Linux only)
create_systemd_service() {
    if [ "$PLATFORM" != "linux" ]; then
        return 0
    fi

    info "Creating systemd service..."

    local service_file="/etc/systemd/system/lem.service"
    local server_dir="$LEM_HOME/server"

    # Check if we have sudo access
    if ! sudo -n true 2>/dev/null; then
        warn "Skipping systemd service (no sudo access)"
        echo "To create a systemd service later, run:"
        echo "  sudo ./scripts/install.sh --systemd"
        return 0
    fi

    sudo tee "$service_file" > /dev/null << EOF
[Unit]
Description=Lem Local Server
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$server_dir
ExecStart=$(which uv) run uvicorn app.main:app --host 0.0.0.0 --port $LEM_PORT
Restart=on-failure
RestartSec=5
Environment=HOME=$HOME

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable lem.service

    success "Systemd service created"
}

# Create launchd service (macOS only)
create_launchd_service() {
    if [ "$PLATFORM" != "macos" ]; then
        return 0
    fi

    info "Creating launchd service..."

    local plist_file="$HOME/Library/LaunchAgents/gg.lem.server.plist"
    local server_dir="$LEM_HOME/server"
    local uv_path
    uv_path="$(which uv 2>/dev/null || echo "$HOME/.local/bin/uv")"

    mkdir -p "$HOME/Library/LaunchAgents"

    cat > "$plist_file" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>gg.lem.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>$uv_path</string>
        <string>run</string>
        <string>uvicorn</string>
        <string>app.main:app</string>
        <string>--host</string>
        <string>0.0.0.0</string>
        <string>--port</string>
        <string>$LEM_PORT</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$server_dir</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LEM_HOME/logs/lem.log</string>
    <key>StandardErrorPath</key>
    <string>$LEM_HOME/logs/lem.error.log</string>
</dict>
</plist>
EOF

    success "Launchd service created at $plist_file"
}

# Start Lem server
start_server() {
    info "Starting Lem server..."

    local server_dir="$LEM_HOME/server"

    # Check if already running
    if curl -s "http://localhost:$LEM_PORT/v1/health" &> /dev/null; then
        success "Lem server is already running on port $LEM_PORT"
        return 0
    fi

    case "$PLATFORM" in
        macos)
            # Try launchd first
            if [ -f "$HOME/Library/LaunchAgents/gg.lem.server.plist" ]; then
                launchctl load "$HOME/Library/LaunchAgents/gg.lem.server.plist" 2>/dev/null || true
                launchctl start gg.lem.server 2>/dev/null || true
            else
                # Start in background
                (cd "$server_dir" && nohup uv run uvicorn app.main:app --host 0.0.0.0 --port "$LEM_PORT" > "$LEM_HOME/logs/lem.log" 2>&1 &)
            fi
            ;;
        linux)
            # Try systemd first
            if systemctl is-enabled lem.service &> /dev/null; then
                sudo systemctl start lem.service
            else
                # Start in background
                (cd "$server_dir" && nohup uv run uvicorn app.main:app --host 0.0.0.0 --port "$LEM_PORT" > "$LEM_HOME/logs/lem.log" 2>&1 &)
            fi
            ;;
        wsl)
            # Start in background
            (cd "$server_dir" && nohup uv run uvicorn app.main:app --host 0.0.0.0 --port "$LEM_PORT" > "$LEM_HOME/logs/lem.log" 2>&1 &)
            ;;
    esac

    # Wait for server to start
    info "Waiting for server to start..."
    local retries=0
    while [ $retries -lt 30 ]; do
        if curl -s "http://localhost:$LEM_PORT/v1/health" &> /dev/null; then
            success "Lem server started on port $LEM_PORT"
            return 0
        fi
        sleep 1
        retries=$((retries + 1))
    done

    warn "Server may still be starting. Check logs at $LEM_HOME/logs/lem.log"
}

# Open browser
open_browser() {
    local url="http://localhost:$LEM_PORT"

    info "Opening browser..."

    case "$PLATFORM" in
        macos)
            open "$url" 2>/dev/null || true
            ;;
        linux)
            xdg-open "$url" 2>/dev/null || sensible-browser "$url" 2>/dev/null || true
            ;;
        wsl)
            # Use Windows browser from WSL
            cmd.exe /c start "$url" 2>/dev/null || true
            ;;
    esac
}

# Print completion message
print_completion() {
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Lem v${LEM_VERSION} installed successfully!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "Dashboard:  http://localhost:$LEM_PORT"
    echo "API Docs:   http://localhost:$LEM_PORT/docs"
    echo "Logs:       $LEM_HOME/logs/lem.log"
    echo ""
    echo "Quick start:"
    echo "  1. Install Ollama from the dashboard"
    echo "  2. Pull a model (e.g., llama3.2:1b)"
    echo "  3. Install Open WebUI to chat with your model"
    echo ""
    echo "Remote access:"
    echo "  1. Register at https://app.lem.gg"
    echo "  2. Login from the dashboard"
    echo "  3. Access your AI from anywhere!"
    echo ""
    echo "Commands:"
    echo "  lem start    - Start the server"
    echo "  lem stop     - Stop the server"
    echo "  lem status   - Check server status"
    echo "  lem logs     - View logs"
    echo ""
}

# Main installation flow
main() {
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  Lem Installer v${LEM_VERSION}${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""

    detect_platform
    check_docker
    check_git
    check_python
    create_directories
    install_harbor
    install_lem_server

    # Create platform-specific service
    case "$PLATFORM" in
        macos)
            create_launchd_service
            ;;
        linux)
            create_systemd_service
            ;;
    esac

    start_server
    open_browser
    print_completion
}

# Run main
main "$@"
