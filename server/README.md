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

**Not supported today.** The dashboard works against a loopback-bound server;
against any other bind it will get 401 on every request, because it has no way
to obtain the bearer token.

A browser cannot read `~/.lem/api_token`, and the obvious shortcut - baking the
token into the dashboard build with a `VITE_*` variable - is not a fix. Vite
inlines those as plaintext string literals into `dist/assets/*.js`, so the
token would be readable by anyone who can load the dashboard page. That is the
same LAN population the token exists to keep out, and a token extracted from
the bundle grants full Docker control from anywhere that can reach port 5142,
bypassing the `Origin`/`X-Lem-Client` layer entirely (a raw bearer holder has
nothing to spoof). "Read a 0600 file on a machine you already have an account
on" and "load a webpage" are very different bars.

Doing this properly needs credential delivery that never puts the secret in a
static bundle - the operator supplies the token at runtime, it is held in
memory/session state rather than compiled in, and the dashboard prompts for it
on 401. That is tracked on
[#48](https://github.com/lem-app/lem/issues/48) and is not in this repo yet.

Until then:

- **Run the dashboard on the same machine as the server**, against the default
  loopback bind. This is the supported path and needs no token.
- `LEM_HOST=0.0.0.0` remains useful for non-browser clients (`curl`, scripts),
  which can send `Authorization: Bearer $(cat ~/.lem/api_token)` themselves.
- `LEM_ALLOWED_ORIGINS` is still needed, and still correct, for any browser
  origin other than localhost - it just is not sufficient on its own.

### Known limitation: proxies in front of the bind

The posture check reads the address off the socket this process actually bound.
It cannot see a second hop it is not part of. Put a reverse proxy, port
forward, container port publish or SSH tunnel in front of a verified-loopback
bind and the API becomes reachable off-host while the server correctly reports
`loopback only` and does not require a token - it *is* bound to loopback; the
exposure was added downstream.

This is inherent to any self-`getsockname()` check, not something the server can
detect. If you front the local API with a proxy, either bind it with
`LEM_HOST=0.0.0.0` so the token is enforced, or make the proxy authenticate.
`web/local`'s own `pnpm run dev:lan` is exactly this shape: it publishes the
Vite dev server on every interface while proxying `/v1/*` to loopback.

## Tunnel peer authorization

Remote access proxies peer requests into this same API and presents the local
server's own credentials, so a peer must be authorized first. The offering
peer's `sender_device_id` is checked against the devices registered to this
machine's Lem account, and **unknown peers are denied** - no SDP answer, no
credentials, no proxying.

`LEM_TUNNEL_ALLOW_UNVERIFIED_PEERS=1` restores the old permissive behavior. It
is off by default, logs loudly when set, and hands the local API to any peer
that reaches the device. Do not set it.

Two things this check does **not** do. It trusts the signaling server's word on
which device sent the offer - a compromised signaling server could assert an
identity this device would accept. And the device list is only as current as
the registry lookup; a peer that would be authorized is always re-checked
against signaling rather than served from cache, so deregistering a device
takes effect on the next connection attempt.

Full Ed25519 proof-of-possession (peer signs a challenge with the key behind
its registered pubkey) is what closes the first of those, and is tracked on
[#29](https://github.com/lem-app/lem/issues/29). It is unbuilt: no such
challenge protocol exists yet on either side of the tunnel, and
`app/crypto.py`'s Ed25519 helpers still have no call sites. The
device-registration check is the interim gate;
`app/tunnel/peer_auth.py::build_peer_verifier` is where a stronger verifier
would be swapped in.

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
