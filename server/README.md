# Lem Local Server

Local server for Lem v0.1 - AI launcher with remote access.

## Quick Start

```bash
# Install dependencies
uv sync

# Run server (loopback only by default)
uv run lem-serve

# Test health endpoint
curl http://localhost:5142/v1/health
```

`lem-serve` (equivalently `python -m app.serve`) is the supported entrypoint.
**Do not start the server with `uvicorn app.main:app --host ...`**: `lem-serve`
is the single place the bind address is chosen, and the API's auth posture is
derived from the socket it actually binds. Started any other way, the server
cannot see its own listening socket and **fails closed** - it requires the
bearer token on every `/v1/*` request and says so on startup.

## Network exposure & auth

This API controls Docker, so it binds to loopback by default.

```bash
# Default: reachable from this machine only
uv run lem-serve

# Opt in to LAN exposure
LEM_HOST=0.0.0.0 LEM_PORT=5142 uv run lem-serve
```

The startup line reports what was **verified**, never what was assumed:

```
✓ Lem local API verified listening on 127.0.0.1:5142 (loopback only); bearer token accepted but not required on /v1/*
⚠ Lem local API verified listening on 0.0.0.0:5142 (network-reachable): bearer token REQUIRED on /v1/*
⚠ Lem local API bind address NOT verified (...). Failing closed: bearer token REQUIRED on /v1/*
```

- **Bearer token** (`~/.lem/api_token`, mode 0600, generated on first start) is
  required on every `/v1/*` request unless a loopback-only bind was positively
  verified. Unknown or undeterminable bind ⇒ token required.
- **CSRF**: any request whose method is not GET/HEAD/OPTIONS must send
  `X-Lem-Client: <name>`; if it sends an `Origin`, that origin must be
  allowlisted (`app.security.ALLOWED_ORIGINS`, plus `LEM_ALLOWED_ORIGINS`).
- **`LEM_ALLOWED_ORIGINS`**: comma-separated extra browser origins, needed when
  a dashboard is served from anything other than localhost. `*` is refused.

```bash
curl -X POST http://127.0.0.1:5142/v1/services/ollama/start \
     -H "X-Lem-Client: curl" \
     -H "Authorization: Bearer $(cat ~/.lem/api_token)"
```

### Using the dashboard over the LAN

A browser cannot read `~/.lem/api_token`, so hand it to the dashboard and
allowlist the dashboard's origin:

```bash
# server
LEM_HOST=0.0.0.0 LEM_ALLOWED_ORIGINS=http://192.168.1.10:5174 uv run lem-serve

# dashboard (web/local)
VITE_LEM_API_TOKEN="$(cat ~/.lem/api_token)" pnpm dev --port 5174
```

Anyone who can read that token has full Docker control of the machine; treat
LAN exposure as a deliberate choice, not a default.

## Tunnel peer authorization

Remote access proxies peer requests into this same API and presents the local
server's own credentials, so a peer must be authorized first. The offering
peer's `sender_device_id` is checked against the devices registered to this
machine's Lem account, and **unknown peers are denied** - no SDP answer, no
credentials, no proxying.

`LEM_TUNNEL_ALLOW_UNVERIFIED_PEERS=1` restores the old permissive behavior. It
is off by default, logs loudly when set, and hands the local API to any peer
that reaches the device. Do not set it.

Full Ed25519 proof-of-possession (peer signs a challenge with the key behind
its registered pubkey) is tracked on #29; the device-registration check is the
interim gate and the verification backend plugs into
`app/tunnel/peer_auth.py::build_peer_verifier`.

## Development

### Type Checking

```bash
uv run mypy app/
```

### Linting & Formatting

```bash
# Format code
uv run ruff format app/

# Lint code
uv run ruff check app/

# Auto-fix lint issues
uv run ruff check --fix app/
```

### Testing

```bash
# Run tests
uv run pytest

# Run tests with coverage
uv run pytest --cov=app --cov-report=term-missing
```

## API Documentation

Once the server is running, visit:
- **Interactive docs**: http://localhost:5142/docs
- **ReDoc**: http://localhost:5142/redoc

## Project Structure

```
server/
├── app/
│   ├── main.py           # FastAPI app entry point
│   ├── api/v1/           # API endpoints
│   ├── drivers/          # Harbor CLI wrappers
│   │   ├── runners/      # Runner drivers (Ollama, etc.)
│   │   └── clients/      # Client drivers (Open WebUI, etc.)
│   └── tunnel/           # WebRTC + relay clients
├── pyproject.toml        # Project config & dependencies
└── README.md             # This file
```

## Current Status (v0.1 Day 1)

✅ FastAPI skeleton created
✅ Health endpoint working (`GET /v1/health`)
✅ Server runs on port 5142
⏳ Harbor CLI integration (next)
⏳ Ollama driver (next)
⏳ Open WebUI driver (next)

## References

- [Implementation Plan](../docs/implementation_plan.md)
- [API Specification](../docs/api.md)
- [Harbor Integration Guide](../docs/harbor_integration.md)
- [Coding Standards](../CLAUDE.md)
