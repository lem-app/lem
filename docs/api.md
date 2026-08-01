# Lem API Reference

**Scope**: every HTTP and WebSocket endpoint in this repository as it exists on `main`. Each
entry names the file and line it comes from.

| Service | Base URL (default) | Endpoints |
|---|---|---|
| Local server | `http://127.0.0.1:5142` | 30 (26 in `server/app/main.py`, 4 in `server/app/api/v1/auth.py`) |
| Cloud signaling | `http://localhost:8000` | 5 HTTP + 1 WebSocket |
| Cloud relay | `http://localhost:8001` | 1 HTTP + 1 WebSocket |

Interactive schemas for the local server are served at `/docs` and `/redoc`
(`server/app/main.py:134-135`).

---

## 1. Error format

The local server raises `fastapi.HTTPException` with an RFC 7807-shaped `detail` object:

```python
raise HTTPException(
    status_code=404,
    detail={
        "type": "https://lem.gg/errors/service-not-found",
        "title": "Service Not Found",
        "detail": f"Service '{service_id}' not found in catalog",
    },
)
```
— `server/app/main.py:516-523`, `:718-724`; `server/app/services/lifecycle.py:99-122`, `:143-164`.

**Important, and easy to get wrong**: FastAPI serialises `HTTPException` as
`{"detail": <your value>}` with `Content-Type: application/json`. The wire body is therefore

```json
{
  "detail": {
    "type": "https://lem.gg/errors/service-not-found",
    "title": "Service Not Found",
    "detail": "Service 'nope' not found in catalog"
  }
}
```

— a problem detail *nested under* `detail`, not a bare `application/problem+json` document.
Clients must read `body.detail.type`. Making this a true RFC 7807 response (custom exception
handler + `application/problem+json`) is a small, worthwhile follow-up; it is not done today.

Some raises pass extra keys alongside the three standard ones — `service` and `stderr`
(truncated to 500 chars) on Harbor failures (`lifecycle.py:100-108`), `job_id` on a 409
(`lifecycle.py:157-164`). RFC 7807 permits these extensions.

A few paths return a **plain string** `detail` instead of the object form:
`POST /v1/auth/register` and `POST /v1/auth/login` (`api/v1/auth.py:238`, `:245`, `:287`,
`:325`, `:332`, `:374`) and `POST /v1/tunnel/enable` (`main.py:409-412`). Clients must tolerate
both shapes.

This is **two** of the four `/v1/auth/*` endpoints, not all four: `logout()` (`auth.py:378-406`)
and `get_status()` (`:408-436`) contain zero `raise HTTPException` calls and return
unconditionally, so a claim about their error shape is vacuous rather than demonstrated. All 9
`raise HTTPException` sites in the file — `:121`, `:143`, `:155` in the shared device-enrolment
helper, `:236`, `:243`, `:285` in `register()`, and `:323`, `:330`, `:372` in `login()` — use the
string form consistently.

### Error `type` URIs in use

| URI | Status | Raised by |
|---|---|---|
| `https://lem.gg/errors/service-not-found` | 404 | `main.py:519`, `lifecycle.py:147`, `:236`, `:284`, `:327` |
| `https://lem.gg/errors/job-not-found` | 404 | `main.py:721` |
| `https://lem.gg/errors/job-in-progress` | 409 | `lifecycle.py:159`, `:339` |
| `https://lem.gg/errors/service-not-installed` | 400 | `lifecycle.py:247` |
| `https://lem.gg/errors/harbor-command-failed` | 503 | `lifecycle.py:102` |
| `https://lem.gg/errors/harbor-unavailable` | 503 | `ollama.py:110`, `:154`, `:183`; `openwebui.py:77`, `:123`, `:153` |
| `https://lem.gg/errors/harbor-timeout` | 504 | `ollama.py:100`, `:144`; `openwebui.py:67`, `:113` |
| `https://lem.gg/errors/timeout` | 504 | `lifecycle.py:117` |
| `https://lem.gg/errors/ollama-unavailable` | 503 | `ollama.py:291`, `:392` |
| `https://lem.gg/errors/ollama-api-error` | 503 | `ollama.py:302`, `:424` |
| `https://lem.gg/errors/ollama-timeout` | 504 | `ollama.py:403` |
| `https://lem.gg/errors/invalid-model-ref` | 400 | `ollama.py:346` |
| `https://lem.gg/errors/internal-error` | 500 | `ollama.py:313`, `:435` |

---

## 2. Local server authentication

PR [#25](https://github.com/lem-app/lem/pull/25) is merged; what follows is `main`. Two
independent controls, both in `server/app/security.py`:

| Control | Rule |
|---|---|
| **CSRF header** (always on) | Every state-changing request must send `X-Lem-Client: <anything>`. Any `Origin` header it does send must be in the allowlist (the same tuple the CORS config uses, so the two cannot drift). Safe methods — `GET`, `HEAD`, `OPTIONS` — are exempt. A browser cannot attach a custom header cross-origin without passing a CORS preflight, which is what stops a hostile page from POSTing to `http://localhost:5142`. |
| **Bearer token** (conditional, fails closed) | Required on `/v1/*` unless the process has *positively verified*, by reading the bound socket, that it listens on loopback only (`security.py:206-212`, `:301-354`). Generated on first start at `~/.lem/api_token`, mode 0600. Start the server any way other than `lem-serve` and the socket is never inspected, so the posture stays unverified and the token is required. |

The posture is derived from the socket the process actually bound, not from `$LEM_HOST` — the
decoupling reported in [#29](https://github.com/lem-app/lem/issues/29) is fixed. Origins can be
extended with `LEM_ALLOWED_ORIGINS` (`security.py:131-160`); `*` is refused.

```bash
curl -H "X-Lem-Client: curl" \
     -H "Authorization: Bearer $(cat ~/.lem/api_token)" \
     http://127.0.0.1:5142/v1/services
```

### After issue [#48](https://github.com/lem-app/lem/issues/48) (`feat/lan-dashboard-auth`)

Either credential is accepted as the bearer on `/v1/*`: the root token above, or
a **session token** traded for it. Browsers use the second, so the permanent
secret never has to reach one. See §11b.

`LEM_REQUIRE_TOKEN=true` forces the bearer requirement on even for a *verified
loopback* bind. It can only add the requirement; nothing switches the token off
on a network-reachable bind.

**Two limits worth knowing.** The tunnel presents the local server's own credentials rather
than the remote peer's when proxying to the local API, so a peer is gated by
`server/app/tunnel/peer_auth.py` — a registration check against the signaling server, not
ed25519 proof of possession, and it takes the signaling server's word for who sent an offer
([#29](https://github.com/lem-app/lem/issues/29)). And the posture cannot see a hop this
process is not part of: a reverse proxy or published container port in front of a
verified-loopback bind exposes it while the server still correctly reports loopback-only and
requires no token — which is exactly what `LEM_REQUIRE_TOKEN` exists for, since only the
operator knows what sits in front of the socket. It is a declaration, not a detection: left
unset in front of a proxy, the API is still open.

---

## 3. Local server — general

### `GET /`
`main.py:177-185`. Returns `{"message": "Lem Local Server v0.1.0", "docs": "/docs", "health": "/v1/health"}`. 200.

### `GET /v1/health`
`main.py:160-174`.

```json
{
  "status": "ok",
  "components": { "docker": "ok", "runners": {}, "clients": {}, "tunnel": "offline" }
}
```

**This response is hardcoded.** It reports `"docker": "ok"` and `"tunnel": "offline"`
unconditionally, even while every Docker call is failing and the tunnel is connected. Branch
`fix/platform-and-docker-correctness` replaces it with a real probe that returns a `platform`
block (`os`, `arch`, `platform`, `wsl`, `docker_host`), a `harbor` component, live runner and
client status, and `status: "ok" | "degraded" | "error"`. Treat the current response as a
liveness ping only.

Always 200.

---

## 4. Local server — catalog (static)

### `GET /v1/catalog`
`main.py:476-497`. Query: `category` ∈ `backend` | `frontend` | `satellite` (optional).
Returns an array of `ServiceDefinition` (`server/app/catalog/models.py:82-102`):

```json
[{
  "id": "ollama",
  "name": "Ollama",
  "category": "backend",
  "description": "…",
  "container_port": 11434,
  "image": "ollama/ollama:${HARBOR_OLLAMA_VERSION}",
  "tags": ["llm", "inference"],
  "depends_on": [],
  "has_api": true,
  "has_ui": false
}]
```

Sorted backend → frontend → satellite, then by name (`registry.py:696-703`).
200. An invalid `category` yields FastAPI's 422 validation error.

### `GET /v1/catalog/{service_id}`
`main.py:500-524`. One `ServiceDefinition`. 200, or 404 `service-not-found`.

---

## 5. Local server — services (runtime)

### `GET /v1/services`
`main.py:532-555`. Query: `category` (optional). Returns `Service`
(`catalog/models.py:105-125`) — a `ServiceDefinition` plus:

| Field | Type | Notes |
|---|---|---|
| `status` | `not_installed` \| `stopped` \| `running` \| `error` | `services/status.py:252-304` |
| `host_port` | `int \| null` | mapped host port when running |
| `endpoint` | `string \| null` | `http://127.0.0.1:<host_port>` when running |
| `error_message` | `string \| null` | always `null` today; never populated |

`endpoint` is a **local-machine** URL. A remote client must not load it directly — see
[`tunnel-proxy-spec.md`](./tunnel-proxy-spec.md).

200. Every call shells out to `docker ps -a` and, per not-running service, `docker images`
(`status.py:59-88`, `:98-152`), so latency scales with catalog size.

### `GET /v1/services/{service_id}`
`main.py:558-590`. One service. 200, or 404 `service-not-found`.

### `POST /v1/services/{service_id}/install`
`main.py:593-615` → `lifecycle.py:125-170`. **Asynchronous.**

```json
{ "job_id": "6f1c…", "status": "pending", "message": "Installation of webui queued" }
```

200 with the job id · 404 `service-not-found` · 409 `job-in-progress` (body carries `job_id`).
The worker installs dependencies first (`lifecycle.py:186-215`), running
`harbor.sh up --no-defaults <id>` with a 600 s timeout per step (`lifecycle.py:51`).

### `POST /v1/services/{service_id}/start`
`main.py:618-632` → `lifecycle.py:218-263`. **Synchronous**, up to 300 s.
`{"status": "ok"}` · 404 `service-not-found` · 400 `service-not-installed` ·
503 `harbor-command-failed` · 504 `timeout`.

### `POST /v1/services/{service_id}/stop`
`main.py:635-649` → `lifecycle.py:266-301`. **Synchronous**, up to 60 s.
`{"status": "ok"}` · 404 · 503 · 504.

### `POST /v1/services/{service_id}/remove`
`main.py:652-673` → `lifecycle.py:304-350`. **Asynchronous**, same envelope as install.
200 · 404 · 409.

---

## 6. Local server — jobs

### `GET /v1/jobs`
`main.py:681-699`. Query: `status` ∈ `pending`|`running`|`completed`|`failed`,
`service_id`, `limit` (default 20). Most recent first (`jobs/db.py:182-216`).

```json
[{
  "id": "6f1c…", "type": "install", "service_id": "webui",
  "status": "running", "progress": 85, "message": "Installing webui...",
  "error": null, "created_at": "2026-08-01T09:00:00", "updated_at": "…",
  "extra": {}
}]
```

`type` ∈ `install` | `remove` | `pull_model`; `progress` is 0–100
(`jobs/models.py:26-65`). 200.

### `GET /v1/jobs/{job_id}`
`main.py:702-726`. One job. 200, or 404 `job-not-found`.

**Note**: `JobType.PULL_MODEL` is declared (`jobs/models.py:40`) but no handler is registered
(`lifecycle.py:421-430`), so a `pull_model` job would fail with
`No handler registered for job type: pull_model` (`jobs/queue.py:183`). Model pulls use the
synchronous endpoint in §8 instead.

---

## 7. Local server — runners (legacy, Ollama-only)

Predates the catalog. Kept for the local dashboard's `RunnersList`.

### `GET /v1/runners`
`main.py:191-217`. Always a single-element array:

```json
[{ "id": "ollama", "name": "Ollama", "status": "running",
   "capabilities": ["chat", "embeddings"], "endpoint": "http://127.0.0.1:33821",
   "harbor_service": "ollama", "version": "latest" }]
```

`version` is the literal string `"latest"` — a `TODO` at `main.py:215`. 200.

### `POST /v1/runners/ollama/install`
`main.py:223-237`. `{"status": "ok", "message": "…"}` · 503 `harbor-unavailable` ·
504 `harbor-timeout`.

### `POST /v1/runners/ollama/start`
`main.py:240-253`. Idempotent. `{"status": "ok"}` · 503 · 504.

### `POST /v1/runners/ollama/stop`
`main.py:256-267`. `{"status": "ok"}` · 503.

### `GET /v1/runners/ollama/health`
`main.py:270-281` → `ollama.py:250-256`.

```json
{ "status": "ok", "uptime_sec": 0, "details": { "note": "Health check not yet implemented" } }
```

**Placeholder.** It never probes Ollama and never fails. Implemented for real on branch
`fix/platform-and-docker-correctness`.

---

## 8. Local server — models

### `GET /v1/runners/ollama/models`
`main.py:433-446` → `ollama.py:259-316`. Proxies Ollama's `GET /api/tags` and returns its
`models` array verbatim (`name`, `size`, `digest`, `modified_at`, …).
200 · 503 `ollama-unavailable` / `ollama-api-error` · 500 `internal-error`.

### `POST /v1/runners/ollama/models/pull`
`main.py:449-468` → `ollama.py:320+`. Body `{"model_ref": "llama3.2:1b"}`.
**Synchronous** — blocks for the whole download.

```json
{ "status": "ok", "model_ref": "llama3.2:1b", "message": "…" }
```

200 · 400 `invalid-model-ref` · 503 `ollama-unavailable` / `ollama-api-error` ·
504 `ollama-timeout` · 500 `internal-error`.
A missing `model_ref` becomes `""` (`main.py:467`) and is rejected as invalid.

---

## 9. Local server — tunnel

### `GET /v1/tunnel/status`
`main.py:371-382` → `tunnel/manager.py:164-212`. Three shapes:

```json
{ "mode": "offline", "authenticated": false }
```
```json
{ "mode": "offline", "authenticated": true, "device_id": "local-server-1a2b3c4d" }
```
```json
{ "mode": "connected", "authenticated": true, "device_id": "local-server-1a2b3c4d",
  "connection_state": "connected", "data_channel_state": "open", "connection_mode": "webrtc" }
```

`mode` ∈ `offline` | `connecting` | `connected` | `failed` | `relay-ws` (the last when
`connection_mode == "relay"`, `manager.py:209-210`). `connection_state` is the raw
`ConnectionState` (`webrtc_client.py:61-90`); `data_channel_state` is the `RTCDataChannel`
`readyState` or `"none"` (`webrtc_client.py:1036-1044`). Always 200.

### `POST /v1/tunnel/enable`
`main.py:385-412`. `{"status": "ok", "mode": "connecting"}` ·
401 (string detail) when not logged in · 503 when `TunnelManager` is missing.
Also raises if `LEM_SIGNAL_URL` disagrees with the stored `signaling_url`
(`manager.py:92-99`) — surfaced as the 401.

### `POST /v1/tunnel/disable`
`main.py:415-427`. Always `{"status": "ok", "mode": "offline"}`, 200.

---

## 10. Local server — clients (legacy, Open WebUI-only)

### `GET /v1/clients`
`main.py:287-313`.

```json
[{ "id": "openwebui", "name": "Open WebUI", "status": "running",
   "url": "http://127.0.0.1:33801", "binds_to_runner": "ollama",
   "harbor_service": "webui", "version": "latest" }]
```

`url` is again a local-machine URL. 200.

### `POST /v1/clients/openwebui/install` · `/start` · `/stop`
`main.py:319-365`. `{"status": "ok"}` (install adds `message`) ·
503 `harbor-unavailable` · 504 `harbor-timeout`.

---

## 11. Local server — auth proxy

`server/app/api/v1/auth.py`, mounted at `/v1` (`main.py:157`). These endpoints **proxy** the
signaling server and persist the result locally; they do not authenticate the local API itself.

### `POST /v1/auth/register`
`auth.py:203-289`. Request:

```json
{ "email": "you@example.com", "password": "…", "signaling_url": "https://signal.lem.gg" }
```

Sequence: `POST {signaling_url}/auth/register` → JWT → get-or-create the local device and
Ed25519 keypair (`auth.py:62-88`) → `POST {signaling_url}/devices/register` →
persist `AuthState` → `TunnelManager.start()`.

Device enrolment is `enrol_device_with_signaling` (`auth.py:89-160`): it asks
`POST /devices/challenge` for a nonce, signs it with the stored private key
(`app/crypto.py::sign_challenge`, `:108-125`), and posts the signature to
`POST /devices/register`. A **401** from the signaling server means a *different* key is on file
for this device id and this machine cannot prove possession of it; that case is surfaced with an
actionable message rather than reported as a generic outage (`auth.py:136-150`).

Response `{"status": "ok", "device_id": "local-server-1a2b3c4d", "tunnel_status": "connecting"}`.
`tunnel_status` ∈ `connecting` | `failed` | `offline`.
400 (email taken, string detail) · 503 (signaling unreachable or device registration failed).

### `POST /v1/auth/login`
`auth.py:291-376`. Same body and same response. 401 on bad credentials · 503 as above.

### `POST /v1/auth/logout`
`auth.py:378-406`. Stops the tunnel, deletes the `auth` row.
`{"status": "ok", "tunnel_status": "offline"}`. Always 200. The `device` row and its keypair are
**not** deleted.

### `GET /v1/auth/status`
`auth.py:408-436`.

```json
{ "authenticated": true, "email": "you@example.com",
  "device_id": "local-server-1a2b3c4d", "tunnel_status": "connected" }
```
or `{"authenticated": false, "tunnel_status": "offline"}`. Always 200.

---

## 11b. Local server — browser sessions

`server/app/api/v1/session.py`, mounted at `/v1`. Unrelated to §11 despite the
shared prefix: §11 signs in to the *cloud*, this authenticates the machine's
operator to their *own* local API. Store: `server/app/sessions.py`.

### `POST /v1/auth/session`

Trades the root API token for a short-lived session token.

```bash
curl -X POST http://127.0.0.1:5142/v1/auth/session \
     -H "X-Lem-Client: curl" \
     -H "Authorization: Bearer $(cat ~/.lem/api_token)"
```

```json
{ "token": "…", "expires_at": "2026-08-02T09:14:00+00:00" }
```

201 · 401 (missing or wrong root token) · 403 (no `X-Lem-Client`, or a
disallowed `Origin`) · 503 (the server cannot load its own token).

**Only the root token is accepted.** The security middleware will happily let a
session token reach this route — it is a valid credential for `/v1/*` — so the
handler checks the root token itself. Without that, a stolen session could mint
an unbroken chain of successors and the TTL would protect nothing. The check
also applies on a loopback bind, where the middleware demands no credential at
all.

Sessions live in the server process's memory and nowhere else: **a restart
invalidates every one of them.** TTL is a fixed 12 hours with no refresh
endpoint and no sliding window. Expired entries are deleted on the next mint or
verification rather than merely refused.

### `DELETE /v1/auth/session`

Revokes the session token presented in the `Authorization` header. 204 with an
empty body, whether or not the token was known — deliberately, so it cannot be
used to probe for live sessions.

---

## 12. Cloud signaling (`cloud/signaling/`, default `:8000`)

> **PRs [#45](https://github.com/lem-app/lem/pull/45) (`fix/cloud-authz`) and
> [#68](https://github.com/lem-app/lem/pull/68) (`feat/ed25519-proof-of-possession`) are both
> merged; this section is `main`.** #45 was a breaking protocol change and #68 taught every
> client to speak it. Net contract: `/signal` has an ed25519 challenge/response that must be
> answered before `connected` arrives; device registration is two-step (`POST /devices/challenge`
> then `POST /devices/register` with a signature over the nonce, and `pubkey` must be base64 of
> 32 raw ed25519 bytes); `connect-request` no longer accepts a client-chosen `relay_session_id`
> and answers with a `connect-request-sent` message carrying a server-minted session id plus a
> per-side, single-use, 120 s relay grant; and the relay refuses account tokens outright. There
> is still **no refresh-token concept and no refresh endpoint** — the 24 h access token in the
> JSON body below is unchanged.
>
> Both Lem clients implement the whole of it: the local server at
> `server/app/api/v1/auth.py:89-160` and `server/app/tunnel/webrtc_client.py:754-793`, the
> browser at `web/remote/src/api/auth.ts:151-183` and `web/remote/src/lib/webrtc.ts:521-536`,
> with the keypairs in `server/app/crypto.py` and `web/remote/src/api/device-key.ts`. That
> closed the client half of [#17](https://github.com/lem-app/lem/issues/17). What remains open
> is peer-to-peer proof of possession over the tunnel —
> [#29](https://github.com/lem-app/lem/issues/29); see §2.

### `GET /health`
`app/api/health.py:27-34`. `{"status": "ok", "timestamp": "<ISO-8601 UTC>"}`. 200.

### `POST /auth/register`
`app/api/auth.py:27-93`. Body `{"email": EmailStr, "password": str}` — password
`min_length=8` (`models/schemas.py:24-28`).
**201** `{"access_token": "<jwt>", "token_type": "bearer"}` · 400 `Email already registered`.

### `POST /auth/login`
`app/api/auth.py:96-135`. Same body without the length constraint.
200 with the same token envelope · 401 `Incorrect email or password`
(with `WWW-Authenticate: Bearer`).

Tokens are HS256, 24 h expiry, signed with `settings.secret_key`
(`core/config.py`). The default secret `dev-secret-key-change-in-production` is rejected only
when `ENV=production` — [#18](https://github.com/lem-app/lem/issues/18).

### `POST /devices/challenge`
`app/api/devices.py:95-118`. `Authorization: Bearer <jwt>` required.
Body `{"device_id": str}`. Returns a single-use, TTL-bounded nonce to sign:

```json
{ "device_id": "device-123", "challenge": "base64…",
  "context": "lem-device-register-v1", "expires_in": 120 }
```

### `POST /devices/register`
`app/api/devices.py:175-282`. `Authorization: Bearer <jwt>` required.
Body `{"device_id": str, "pubkey": str, "challenge": str, "signature": str}`, all four required,
plus optional `previous_signature` (`models/schemas.py:82-101`). `pubkey` must be base64 of the
32 raw ed25519 public key bytes; anything else is a 422.

Signed messages are `b":".join((context, *fields))` (`core/crypto.py:116-133`), with the fields
UTF-8 encoded and the challenge used exactly as issued:

| Proof | Context | Fields |
|---|---|---|
| Registration (`signature`) | `lem-device-register-v1` | `device_id`, `challenge` |
| Signaling connect (`signature`) | `lem-signaling-connect-v1` | `device_id`, `challenge` |
| Key rotation (`previous_signature`) | `lem-device-rotate-v1` | `device_id`, `challenge`, **new** `pubkey` |

**Trust on first use, then the key is pinned.** The first registration of a device id establishes
which key owns it — the caller proves possession of the key it offers and nothing more can be
asked. Afterwards, presenting a *different* `pubkey` is a key rotation and additionally requires
`previous_signature` from the key already on file, over a payload naming the new pubkey
(`app/api/devices.py:241-265`). The new pubkey is inside the signed payload, so a rotation proof
cannot be lifted and replayed to install a third key. This matters: registration used to write
`excluded.pubkey` unconditionally, so anyone holding the account JWT could overwrite a device's
key with their own and pass every downstream device check. Proof of possession of the *new* key
alone does not close that, because the attacker generates the new key.

The challenge is redeemed *before* the signature is checked (`app/api/devices.py:222-239`), so a
failed attempt cannot be retried against the same nonce.

```json
{ "id": "local-server-1a2b3c4d", "user_id": 1, "pubkey": "base64…",
  "created_at": "…", "last_seen": "…" }
```

200 · 401 `Invalid device challenge signature` when the challenge is missing, expired, already
redeemed, or the signature does not verify, and 401 `Device already has a registered key…` when
a rotation is unauthorized · 403 `Device ID belongs to another user` · 422 malformed `pubkey`, or
a body missing any of the four required fields · 500 if the row vanishes.

### `GET /devices/`
`app/api/devices.py:285-323`. Bearer required. Array of the caller's devices. 200 · 401.
Note the **trailing slash** — the route is registered as `"/"` under `prefix="/devices"`.

### `WS /signal`
`app/api/signal.py:575-658` (endpoint), with the handshake in `authenticate_connection`
(`:315-413`) and routing in `route_message` (`:452-513`).

Authentication is a three-step handshake. **There is no `?token=` query parameter** — it was
removed because uvicorn's access log and nginx's default log format both record the query
string, so every documented deployment wrote credentials to a plaintext log. A request carrying
one is refused with `reason: "unsupported-client"`.

1. Client sends `{"type": "auth", "token": "…", "device_id": "…"}` as the first text frame,
   within 10 s. The token must be account-scoped, and the device must belong to the token's
   user (`signal.py:257-284`); otherwise `reason: "auth-failed"` and a 1008 close.
2. Server answers `{"type": "challenge", "device_id": "…", "challenge": "<b64>",
   "context": "lem-signaling-connect-v1"}`.
3. Client answers `{"type": "auth-response", "signature": "<b64 ed25519 signature>"}` over
   `<context> ":" <device_id> ":" <challenge>`. The signature is verified against the device's
   registered pubkey (`signal.py:401-413`); a failure is
   `reason: "device-key-verification-failed"` and a 1008 close. The challenge is fresh per
   connection and never reusable.

On success the server sends:

```json
{ "type": "connected", "device_id": "…", "message": "Connected to signaling server",
  "ice_servers": [{"urls": "stun:stun.l.google.com:19302"}] }
```

Thereafter every client frame must be JSON with `type` and `target_device_id`, and must be
≤ 64 KiB, checked before parsing (`signal.py:306-307`).

| Client `type` | Server behaviour |
|---|---|
| `connect-request` | The server mints the relay session; any client-supplied `relay_session_id` is ignored. The target gets `connect-request-received` with `from_device_id`, `preferred_transport`, `relay_session_id`, `relay_url`, `relay_token`, `relay_token_expires_in`; the sender then gets the mirror-image `connect-request-sent` with its own grant (`signal.py:544-571`). Each side's `relay_token` is single-use and names only that side. |
| `connect-ack` | Rewritten to `connect-ack-received` with `from_device_id`, `transport`, `relay_session_id`, `status` (`signal.py:496-500`). |
| anything else (`offer`, `answer`, `ice-candidate`, …) | `sender_device_id` is added and the message is forwarded verbatim (`signal.py:502-509`). |

Server → sender replies: `{"type": "ack", "message": "Message delivered to …"}` on success, or
an `{"type": "error"}` frame carrying a machine-readable `reason` and an explicit `retryable`
boolean when the target is not reachable, the JSON is invalid, the message is oversized, or
`type`/`target_device_id` is missing. Branch on `reason`, never on `message`.

Schemas for the relay-coordination messages: `models/schemas.py`.

**`target_device_id` must be a device the sender's account owns** (`signal.py:480-485`).
Naming anything else returns the same `target-unavailable` error given for a device that does
not exist and for one of your own that is offline, so the endpoint cannot be used to probe who
is online. This closed [#16](https://github.com/lem-app/lem/issues/16).

---

## 13. Cloud relay (`cloud/relay/`, default `:8001`)

### `GET /health`
`app/api/health.py:25-36`.

```json
{ "status": "healthy", "service": "relay", "active_sessions": 3 }
```

200.

### `WS /relay/{session_id}`
`app/api/relay.py:32-121`.

Authentication is a first `{"type": "auth", "token": "<grant>"}` frame within 10 s. **There is
no `?token=` query parameter** — removed for the same access-log reason as `/signal`; a request
carrying one is refused with `reason: "unsupported-client"`.

The `<grant>` is **not** an account access token. It is the `relay_token` the signaling server
minted in `connect-request-sent` / `connect-request-received`, and it must carry
`scope: "relay-session"` — an account token is rejected outright
(`core/security.py:114-131`). The grant names the session id, the bearer device, its one
permitted peer, the owning account, a unique `jti`, and a mandatory short `exp` (120 s
default). A `jti` is redeemable **once**, and stays spent for the grant's whole validity window.

The relay enforces that both connections in a session carry the same `user_id` and the same
`{device_id, peer_device_id}` pair, that no device occupies both slots, and that a third
connection is refused (`core/session_manager.py:125-170`). This closed
[#15](https://github.com/lem-app/lem/issues/15): a `session_id` is now bound to one account and
one device pair, and is server-minted and unguessable rather than derived client-side.

Once both sides are present, frames are forwarded verbatim in both directions until either
closes (`session_manager.py:186-224`). Sessions idle out after `session_timeout` (300 s
default).

The payload is Lem's binary tunnel framing (`docs/tunnel-proxy-spec.md` §4) and is **not**
inspected by the relay. It is, however, **not end-to-end encrypted**: the local server sends
frames to the relay in plaintext (`server/app/tunnel/relay_client.py:223-235`), the relay
terminates TLS, forwards them in the clear and meters their size
(`session_manager.py:209-218`, `:288-297`). The protection on this path is TLS to the relay,
nothing more, and the relay operator is trusted with the traffic. End-to-end encryption here is
roadmap, not shipped — [#12](https://github.com/lem-app/lem/issues/12).

---

## 14. Configuration reference

| Variable | Component | Default | Meaning |
|---|---|---|---|
| `LEM_SIGNAL_URL` | local server | unset | Overrides the stored signaling URL; a mismatch with stored auth raises at tunnel start (`tunnel/manager.py:92-99`). |
| `LEM_HOST` | local server | `127.0.0.1` | *(PR #25)* bind address; non-loopback turns on the bearer token. |
| `LEM_PORT` | local server | `5142` | *(PR #25)* listen port; an unparseable value falls back to the default with a warning. |
| `LEM_ALLOWED_ORIGINS` | local server | unset | *(PR #25)* comma-separated extra browser origins for the CSRF/CORS allowlist. `*` is refused. |
| `LEM_REQUIRE_TOKEN` | local server | `false` | *(issue #48)* `1`/`true`/`yes`/`on` requires the bearer token on `/v1/*` even for a verified loopback bind. For proxies, published container ports and `vite --host`, which the socket check cannot see. Only ever adds the requirement. |
| `DOCKER_HOST` | local server | platform default | See [`platform.md`](./platform.md). |
| `SECRET_KEY` | signaling, relay | `dev-secret-key-change-in-production` | JWT signing key; must match between the two services. |
| `ENV` | signaling, relay | unset | `production` makes the default secret fatal. |
| `DATABASE_URL` | signaling | unset (SQLite `signaling.db`) | `postgresql://…` switches to asyncpg. Read directly from `os.environ` at `app/db/database.py:29-30`; the `database_url` field on the settings class is a separate, unused default. |
| `CORS_ORIGINS` | signaling, relay | `*` | Comma-separated, or `*`. |
| `RELAY_URL` | signaling | `ws://localhost:8001` | Advertised to peers in `connect-request-received`. |
| `ICE_SERVERS_JSON` | signaling | `[{"urls":"stun:stun.l.google.com:19302"}]` | Sent in the `connected` message. |
| `SESSION_TIMEOUT` | relay | `300` | Idle session timeout, seconds. |
| `VITE_API_TARGET` | web/local | `http://127.0.0.1:5142` | Vite proxy target (`web/local/vite.config.ts:21`). |
| `VITE_SIGNAL_URL` | web/remote | `ws://localhost:8000/signal` | `web/remote/src/App.tsx:34`. |
| `VITE_RELAY_URL` | web/remote | `ws://localhost:8001` | `web/remote/src/App.tsx:86`. |

Settings classes: `cloud/signaling/app/core/config.py`, `cloud/relay/app/core/config.py`
(pydantic-settings, `.env` supported).
