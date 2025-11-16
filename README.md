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
- **Node.js 18+** and [pnpm](https://pnpm.io/)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/lem-gg/lem.git
cd lem/lem-app

# Start the local server
cd server
uv sync
uv run uvicorn app.main:app --host 0.0.0.0 --port 5142

# In another terminal, start the web dashboard
cd web/local
pnpm install
pnpm run dev
```

Open http://localhost:5173 in your browser.

## 🏗️ Architecture

Lem consists of four main components:

1. **Local Server** (`/server`): FastAPI server running on your machine (port 5142)
2. **Local Dashboard** (`/web/local`): React web UI for managing local services
3. **Cloud Signaling** (`/cloud/signaling`): WebRTC signaling for P2P connections
4. **Cloud Relay** (`/cloud/relay`): Fallback relay for restricted networks

See [docs/architecture.md](./docs/architecture.md) for detailed architecture information.

## 🔐 Security

- **P2P by default**: Direct WebRTC connections when possible
- **End-to-end encryption**: All remote traffic is encrypted
- **JWT authentication**: Secure access to cloud services
- **Device registration**: ed25519 public key authentication
- **Open source**: Full transparency, audit the code yourself

## 📖 Documentation

- [Architecture Overview](./docs/architecture.md)
- [Implementation Plan](./docs/implementation_plan.md)
- [API Reference](./docs/api.md)
- [Platform Guide](./docs/platform.md)
- [Contributing Guide](./CONTRIBUTING.md)
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

- [License FAQ](./LICENSE-FAQ.md)
- [Full License Text](./LICENSE)
- [Copyright Notice](./NOTICE)

## 🛠️ Development

### Project Structure

```
lem-app/
├── server/           # Local FastAPI server (Python)
├── cloud/
│   ├── signaling/    # WebRTC signaling server (Python)
│   └── relay/        # WebSocket relay server (Python)
├── web/
│   ├── local/        # Local dashboard (React + TypeScript)
│   └── remote/       # Remote web app (React + TypeScript)
├── docs/             # Architecture and implementation docs
└── CLAUDE.md         # Coding standards
```

### Tech Stack

- **Backend**: Python 3.11+, FastAPI, Pydantic, SQLite
- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite
- **Networking**: WebRTC (aiortc), WebSocket, HTTP/2
- **Infrastructure**: Docker, Harbor CLI (for container management)

### Running Tests

```bash
# Python tests
cd server
uv run pytest --cov=app

# TypeScript tests
cd web/remote
pnpm run test
```

### Code Quality

```bash
# Python linting and formatting
uv run ruff check server/
uv run ruff format server/
uv run mypy server/

# TypeScript linting and formatting
cd web/local
pnpm run lint
pnpm run format
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

See [docs/implementation_plan.md](./docs/implementation_plan.md) for detailed roadmap.

## 🐛 Bug Reports & Feature Requests

Please use [GitHub Issues](https://github.com/lem-gg/lem/issues) to report bugs or request features.

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
