# Lem

**Your local AI infrastructure, securely accessible from anywhere.**

Lem is an open-source platform for managing and remotely accessing your local AI services (Ollama, Open WebUI, and more) through peer-to-peer WebRTC connections, with a relay fallback for networks that block them.

## 🌟 Features

- **🚀 One-Click Setup**: Install and manage Ollama + Open WebUI with a single command
- **🔒 Remote Access**: Reach your local AI from anywhere — direct WebRTC P2P, encrypted between the two peers with DTLS, where the network allows it; a relay fallback where it does not. **The relay fallback is not end-to-end encrypted: the relay terminates TLS and can see your traffic.** Read [Security](#-security) before you enable it
- **🏠 Local-First**: Your services and their data run on your machine, not in anyone's cloud. Remote access requires your explicit authentication
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
  it is trusted with your traffic — it forwards frames in the clear and meters
  their size ([`cloud/relay`](./cloud/relay/README.md#security)). End-to-end
  encryption on the relay path is on the roadmap, **not shipped**
  ([#12](https://github.com/lem-app/lem/issues/12))
- **JWT authentication**: account access to the cloud services (email/password).
  This authenticates the *account*; the device key below authenticates the
  *device*, and both are required
- **Device authentication**: ed25519 challenge/response, implemented on every
  client and verified by the server. A device signs a single-use challenge to
  register and signs a fresh one each time it connects to signaling; the
  signaling server checks both against the key on file and refuses otherwise
  ([`cloud/signaling`](./cloud/signaling/README.md#security)). The key is pinned
  on first registration — replacing it requires a second signature from the key
  already on file, so holding your account password is not enough to swap a
  device's identity
- **What device authentication does not yet cover**: a tunnel peer is authorized
  by asking the signaling server which devices your account owns, not by making
  the peer prove key possession directly to your machine. That check trusts the
  signaling server's answer. Peer-to-peer proof of possession is tracked in
  [#29](https://github.com/lem-app/lem/issues/29)
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
- **Session tokens for browsers**: the dashboard never holds the root token.
  It prompts on 401, the operator pastes `~/.lem/api_token` once, and it is
  traded at `POST /v1/auth/session` for a 12-hour token held in the server's
  memory only. Nothing is compiled into the bundle - a build-time `VITE_*`
  variable would be inlined as a plaintext literal into `dist/assets/*.js`,
  handing the credential to everyone who can load the page.
  `scripts/check-bundle-secrets.sh` builds both web apps in CI and scans them
  for forbidden build-variable names *and* for credential-shaped literals,
  proving on every run that its own rules still fire.
- **`LEM_REQUIRE_TOKEN=true`** forces the bearer requirement on even for a
  verified loopback bind. Use it whenever something in front of the socket
  republishes the API: a reverse proxy, a published container port, an SSH
  tunnel, or `pnpm run dev:lan`. The server reads its posture off the socket it
  bound and cannot see a hop it is not part of, so this is the one thing it
  needs told.

### Remote access peers

A tunnel peer is proxied into the same local API and is handed the local
server's own credentials, so peers must be authorized first: the offering
device is checked against the devices registered to your Lem account, and
unknown peers are denied. Ed25519 proof-of-possession is the endgame and is
tracked in [#29](https://github.com/lem-app/lem/issues/29);
`LEM_TUNNEL_ALLOW_UNVERIFIED_PEERS=1` is a deliberate, loudly-logged opt-out
that turns the check off.

### ⚠️ Services you view remotely run with the dashboard's privileges

**Only launch services you trust.**

When you open a service from the remote dashboard it is framed at
`/app/<deviceId>/<serviceId>/` — a path on **the dashboard's own origin**. That
is not an implementation detail we could avoid: a Service Worker can only
proxy a document it controls, and it can only control a same-origin one. The
alternative is the frame loading your *own* machine's `localhost`, which is the
bug this design exists to fix.

The consequence is that a framed service is **not sandboxed away from the
dashboard**. The `sandbox` attribute on the iframe does not change this:
`allow-scripts` together with `allow-same-origin` is the documented escape
hatch, and dropping `allow-same-origin` would stop the proxy working at all.
Hostile or compromised service code in that frame can reach the dashboard's
DOM and its storage. What we do about it:

- The signaling JWT is **never written to browser storage** — no
  `localStorage`, `sessionStorage`, IndexedDB, cookie or URL — so it does not
  outlive the page and cannot be lifted from a store without the dashboard
  running. The cost is that **a full page reload logs you out**; the `HttpOnly`
  refresh cookie that removes that cost is
  [#79](https://github.com/lem-app/lem/issues/79).

  It is also kept out of the **rendered page**. React stores component props
  and hook state on fiber nodes attached to DOM elements, so a token held in a
  component would be readable by a framed service walking `parent.document` —
  storage custody alone would have moved the exposure rather than removed it.
  Components receive `isAuthenticated`, never the token; code that needs the
  value reads it from module scope at the point of use
  ([#82](https://github.com/lem-app/lem/issues/82)).

  **None of this makes a hostile framed service safe.** It is same-origin with
  the dashboard and can act as the dashboard in other ways. Per-service origins
  is still the boundary; "only launch services you trust" still applies.
- Upstream `Content-Security-Policy`, `X-Frame-Options` and
  `Strict-Transport-Security` are stripped and replaced, so a framed app cannot
  pin *your dashboard's* origin to HTTPS-only or break the proxy.

**The real boundary is giving each service its own origin**
(`<serviceId>.apps.<dashboard-domain>`), which costs wildcard DNS and a
wildcard certificate. It is planned, not shipped. Until then, trust in a
service you launch remotely is the security control.

### Cookies for remotely-viewed services are held by Lem, not by your browser

`Set-Cookie` is a forbidden response-header name: a Service Worker cannot
attach a cookie to a response it synthesises, and the browser never runs the
step that would store one. So **no cookie from a service you view remotely ever
reaches your browser's cookie store.**

Instead the Service Worker keeps **its own cookie jar**, one per service, and
attaches the right cookies to that service's requests itself
([#72](https://github.com/lem-app/lem/issues/72)). Signing in to a remotely
viewed app therefore has a working code path — though **it has not yet been
confirmed against a real app end to end**
([#6](https://github.com/lem-app/lem/issues/6)).

Two consequences worth knowing:

- **An app whose own JavaScript reads a cookie by name will not find it.**
  `document.cookie` in the frame sees nothing. Session cookies marked
  `HttpOnly` — the overwhelming majority, and the ones logins rely on — are
  unaffected.
- **This is a functional partition, not a security boundary.** One service's
  cookies are genuinely unreachable from another service's frame, which is
  stronger than it was; but a hostile framed app still shares the dashboard's
  origin and is not contained by it. Per-service origins remain the actual
  boundary, as above.

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
- Run an unmodified Lem as a service for other people, including commercially

✅ **If you modify Lem and offer the modified version over a network**, you must:
- Offer those users the source of your version, from a network server, at no charge
- License your modifications under AGPL-3.0-or-later
- Do the same when you distribute modified copies

### Why AGPL?

AGPL-3.0's network clause (§13) is triggered by **modification**, not by hosting. Someone can run Lem verbatim as a paid service and owe nothing back; the license does not prevent that. What it does prevent is the usual way an open project gets strip-mined — the proprietary fork. Anyone who improves Lem and then puts those improvements in front of users, over a network or as a distributed copy, has to publish them under the same license. Improvements come back to the commons.

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
