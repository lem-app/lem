# Lem

**Your local AI infrastructure, securely accessible from anywhere.**

Lem is an open-source platform for managing and remotely accessing your local AI services (Ollama, Open WebUI, and more) through secure peer-to-peer connections.

## 🌟 Features

- **🚀 One-Click Setup**: Install and manage Ollama + Open WebUI with a single command
- **🔒 Secure Remote Access**: Access your local AI from anywhere using WebRTC P2P or encrypted relay
- **🏠 Privacy-First**: Your data stays local. Remote access requires your explicit authentication
- **🐳 Docker-Based**: Clean, isolated environments for each service
- **🌐 Cross-Platform**: Works on macOS, Linux, and Windows (WSL2)
- **📱 Web Dashboard**: Beautiful, responsive UI built with React and Tailwind CSS

## 🎯 Use Cases

- Access your home AI setup from work or travel
- Share your local models with trusted collaborators (coming in v1.0)
- Centralize AI infrastructure without cloud vendor lock-in
- Self-host everything with full control

## 📦 Installation

### Prerequisites

- **Docker** and Docker Compose
- **Python 3.11+** (recommended: [uv](https://github.com/astral-sh/uv))
- **[Node.js](https://nodejs.org/) 20+** and [pnpm](https://pnpm.io/)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/lem-app/lem.git
cd lem

# Start the local server (loopback only - see "Network exposure" below)
cd server
uv sync
uv run lem-serve

# In another terminal, from the repository root, start the web dashboard
cd web/local
pnpm install
pnpm run dev
```

Open http://localhost:5174 in your browser.

## 🏗️ Architecture

Lem consists of five main components:

1. **Local Server** (`/server`): FastAPI server running on your machine (port 5142)
2. **Local Dashboard** (`/web/local`): React web UI for managing local services
3. **Remote Dashboard** (`/web/remote`): React web app for accessing your local AI remotely
4. **Cloud Signaling** (`/cloud/signaling`): WebRTC signaling for P2P connections
5. **Cloud Relay** (`/cloud/relay`): Fallback relay for restricted networks


## 🔐 Security

- **P2P by default**: Direct WebRTC connections when possible, with DTLS
  encryption on that path
- **Encryption in transit**: TLS to the cloud services, DTLS on the P2P path.
  On the relay fallback path the relay terminates TLS and sees plaintext, so
  it is trusted with your traffic. End-to-end encryption on the relay path is
  on the roadmap, not shipped
- **JWT authentication**: Account access to the cloud services
- **Device authentication**: ed25519 challenge/response — a device proves
  possession of its private key when it registers and when it connects to
  signaling
- **Session authorization**: relay sessions are bound by a signed grant to two
  devices of one account; signaling only routes between devices you own
- **Open source**: Full transparency, audit the code yourself

### Network exposure

The local server can install, start, stop and remove Docker services, so it
binds to **127.0.0.1 only** unless you opt in. Always start it with `lem-serve`
- it is the single place the bind address is chosen, and the API's auth posture
is derived from the socket it actually binds rather than from configuration:

```bash
# Default: reachable from this machine only
uv run lem-serve

# Opt in to LAN access (bearer token then required on every /v1/* request)
LEM_HOST=0.0.0.0 uv run lem-serve
curl -H "X-Lem-Client: curl" \
     -H "Authorization: Bearer $(cat ~/.lem/api_token)" \
     http://<host>:5142/v1/services
```

- **Fails closed**: the bearer token is required unless a loopback-only bind was
  positively verified from the listening socket. Starting the app some other
  way (`uvicorn app.main:app --host ...`) means the socket was never seen, so
  the token is required and the startup log says the bind is unverified.
- **API token**: generated on first start at `~/.lem/api_token` (mode 0600).
- **CSRF protection**: every state-changing request must send the
  `X-Lem-Client` header, and any `Origin` it sends must be allowlisted. This
  holds on loopback too - it is what stops a web page you are visiting from
  POSTing to `http://localhost:5142`. Add non-localhost dashboard origins with
  `LEM_ALLOWED_ORIGINS` (comma-separated; `*` refused).
- **Secrets at rest**: `~/.lem` is mode 0700 and `lem.db` (plus its WAL/SHM
  sidecars) and `api_token` are mode 0600.

Two things this deliberately does **not** do yet:

- **The dashboard over the LAN does not work.** `web/local` sends no bearer
  token, so against a non-loopback bind it gets 401 on every request. A browser
  cannot read `~/.lem/api_token`, and baking it into the build with a `VITE_*`
  variable is not a fix - Vite inlines those as plaintext literals into
  `dist/assets/*.js`, handing the token to everyone who can load the page.
  Run the dashboard on the same machine as the server; `LEM_HOST=0.0.0.0` is
  for non-browser clients that can present the token themselves. Proper
  credential delivery is tracked in
  [#48](https://github.com/lem-app/lem/issues/48).
- **A proxy in front of a loopback bind still exposes it.** The posture is read
  off the socket this process bound; it cannot see a hop it is not part of. A
  reverse proxy, published container port, or `pnpm run dev:lan` in front of a
  verified-loopback server makes it reachable off-host while the server
  correctly reports "loopback only" and requires no token. Bind with
  `LEM_HOST=0.0.0.0` (so the token is enforced) or authenticate at the proxy.

### Remote access peers

A tunnel peer is proxied into the same local API and is handed the local
server's own credentials, so peers must be authorized first: the offering
device is checked against the devices registered to your Lem account, and
unknown peers are denied. Ed25519 proof-of-possession is the endgame and is
tracked in [#29](https://github.com/lem-app/lem/issues/29);
`LEM_TUNNEL_ALLOW_UNVERIFIED_PEERS=1` is a deliberate, loudly-logged opt-out
that turns the check off.

## 📖 Documentation

- [Coding Standards](./CLAUDE.md)

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

**Key requirements:**
- All commits must be signed off (DCO)
- Follow coding standards in [CLAUDE.md](./CLAUDE.md)
- Include tests for new features
- Update documentation as needed

## 📜 License

Lem is open source software licensed under the **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**.

### What this means for you:

✅ **You can:**
- Run Lem locally for personal or commercial use
- Modify the code for your own needs
- Self-host all components (local server + cloud services)
- Fork and experiment with the code
- Audit the source code for security

✅ **If you run Lem's cloud services publicly**, you must:
- Open source any modifications you make
- Use the same AGPL-3.0-or-later license
- Provide source code to your users

### Why AGPL?

We chose AGPL to keep Lem truly open source while ensuring that improvements benefit the entire community. If someone offers Lem as a hosted service, they must share their code—preventing proprietary forks.

### Commercial Licensing

Need a different license for embedded use or commercial distribution? Contact us at: **blake@lem.gg**

### More Information

- [License FAQ](./AGPL-FAQ.md)
- [Full License Text](./LICENSE)
- [Copyright Notice](./NOTICE)

## 🛠️ Development

### Project Structure

```
lem/
├── server/           # Local FastAPI server (Python)
├── cloud/
│   ├── signaling/    # WebRTC signaling server (Python)
│   └── relay/        # WebSocket relay server (Python)
├── web/
│   ├── local/        # Local dashboard (React + TypeScript)
│   └── remote/       # Remote web app (React + TypeScript)
└── CLAUDE.md         # Coding standards
```

### Tech Stack

- **Backend**: Python 3.11+, FastAPI, Pydantic, SQLite
- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite
- **Networking**: WebRTC (aiortc), WebSocket, HTTP/2
- **Infrastructure**: Docker, Harbor CLI (for container management)

### Running Tests

```bash
# From the repository root:

# Python tests (uv sync installs the dev group, including pytest)
cd server
uv sync
uv run pytest --cov=app

# Cloud service tests
cd cloud/signaling
uv sync
uv run pytest

# TypeScript tests
cd web/remote
pnpm install
pnpm test
```

### Code Quality

```bash
# From the repository root:

# Python linting and formatting
cd server
uv run ruff check app/
uv run ruff format app/
uv run mypy app/

# TypeScript linting and formatting
cd web/local
pnpm lint
pnpm format
pnpm tsc --noEmit
```

## 🗺️ Roadmap

### v0.1 (Current - MVP)
- [x] Local Ollama + Open WebUI management
- [x] WebRTC P2P remote access
- [x] Relay fallback for restricted networks
- [x] Basic authentication and device registration
- [ ] Production-ready deployment scripts

### v1.0 (Future)
- [ ] Device sharing (invite collaborators)
- [ ] Multi-runner support (multiple Ollama instances)
- [ ] Advanced metering and usage tracking
- [ ] Mobile app (iOS/Android)
- [ ] Browser extension


## 🐛 Bug Reports & Feature Requests

Please use [GitHub Issues](https://github.com/lem-app/lem/issues) to report bugs or request features.

For security vulnerabilities, please email: **blake@lem.gg**

## 💬 Community

- **Discord**: [Join our Discord](https://discord.gg/xY4XXKJDZZ)

## 🙏 Acknowledgments

Lem is built on top of excellent open source projects:

- [Harbor CLI](https://github.com/av/harbor) - Docker container orchestration
- [Ollama](https://ollama.ai/) - Local LLM runtime
- [Open WebUI](https://github.com/open-webui/open-webui) - Web interface for LLMs
- [FastAPI](https://fastapi.tiangolo.com/) - Modern Python web framework
- [React](https://react.dev/) - UI framework
- [Tailwind CSS](https://tailwindcss.com/) - Utility-first CSS
- [shadcn/ui](https://ui.shadcn.com/) - Beautiful UI components

## 📧 Contact

- **Website**: https://lem.gg
- **Email**: blake@lem.gg

---

Made with ❤️ by the Lem team

**⭐ If you find Lem useful, please consider starring the repository!**
