# Testing Checklist

How to verify Lem — automated gates, per-component manual checks, and the end-to-end scenario
that defines "remote access works".

**Read this first**: `main` does not currently pass its own gates. §1 records the measured
baseline from [#20](https://github.com/lem-app/lem/issues/20) so you can tell a regression you
caused from one you inherited.

---

## 1. Baseline on `main`

Measured 2026-08-01, at `28baea7`.

| Gate | Command | Result |
|---|---|---|
| server pytest | `cd server && uv run pytest` | **5 failed**, 33 passed; coverage **19 %** (target > 80 %) |
| server test deps | `uv sync` then `uv run pytest` | **fails** — dev deps are in `[project.optional-dependencies]` (`server/pyproject.toml:18-26`), so a plain `uv sync` never installs pytest |
| server ruff | `cd server && uv run ruff check app/` | **9 errors** (7 × E501, UP035, F401) |
| server mypy | `cd server && uv run mypy app/` | clean (34 files) |
| signaling pytest | `cd cloud/signaling && uv run pytest` | **3 failed** / 6 on a clean DB; **4 failed** / 5 on re-run — non-idempotent |
| signaling mypy | `cd cloud/signaling && uv run mypy app/` | **9 errors** in 5 files |
| signaling ruff | `cd cloud/signaling && uv run ruff check app/` | **3 errors** |
| relay pytest | `cd cloud/relay && uv run pytest` | **0 tests collected** — `tests/` holds only `__init__.py` |
| web/remote vitest | `cd web/remote && pnpm test` | **2 failed** / 25 passed |
| web/local tests | — | **no test script** (`web/local/package.json:7-13`) |
| both apps `tsc --noEmit` | `pnpm tsc --noEmit` | passes, but **checks zero files** — see below |
| both apps eslint | `pnpm lint` | **fails** (2 local, 4 remote) |
| formatting | `pnpm prettier --check .` | **37 files** unformatted |
| CI | — | none; no `.github/` directory on `main` |

### `tsc --noEmit` is a no-op — do not trust it

Both `tsconfig.json` files are solution-style: `"files": []` plus `"references"`
(`web/remote/tsconfig.json`, `web/local/tsconfig.json`). In non-build mode that yields a program
with **zero root files**, so the command always passes. `web/remote`'s `"type-check"` script and
`CLAUDE.md`'s documented command are both no-ops. Real checking happens only incidentally inside
`tsc -b` during `build`.

Use one of these instead:

```bash
pnpm tsc -p tsconfig.app.json --noEmit    # type-checks src/
pnpm tsc -b --force                       # what `build` does
```

Verify with `--listFiles | wc -l`: the solution config reports 0; `tsconfig.app.json` reports
137 (remote) / 115 (local).

### The frame tests were stale in both languages

The HTTP frame format gained a leading `frame_type` byte; the serializers were updated, the
tests were not. Python failed with `Expected HTTP_REQUEST frame (0x01), got 0x00`; TypeScript
failed with `expected 33554432 to be 42` — `0x02000000`, the response frame's type byte read as
the top octet of a `getUint32(0)`. That accounts for all 5 server failures and both remote
failures. PR [#24](https://github.com/lem-app/lem/pull/24) fixes them.

### Signaling tests corrupt their own state

`cloud/signaling/tests/test_api.py:40` sets `db_module.DATABASE_FILE`, a name that does not
exist — the code hardcodes `"signaling.db"` (`app/db/database.py:90`, `:112`). Tests write to a
persistent DB in the working directory with no teardown and re-register `test@example.com`, so
results depend on what the previous run left behind. Between runs:

```bash
rm -f cloud/signaling/signaling.db
```

---

## 2. Automated gates

### Local server

```bash
cd server
uv sync --extra dev                 # NOT plain `uv sync` — see §1
uv run pytest --cov=app --cov-report=term-missing
uv run mypy app/
uv run ruff check app/
uv run ruff format --check app/
```

Existing suites: `tests/tunnel/test_http_frame.py`, `tests/tunnel/test_relay_fallback.py`,
`tests/tunnel/test_webrtc_client.py`. PR #25 adds `tests/test_security.py` and
`tests/tunnel/test_http_proxy_security.py`; `fix/platform-and-docker-correctness` adds
`tests/test_platform.py`.

Largest untested areas, in the order worth fixing (this is where the 19 % comes from):
`catalog/registry.py` (727 lines), `services/status.py`, `services/lifecycle.py`,
`jobs/queue.py`, `main.py`'s 26 route handlers, `api/v1/auth.py`.

### Cloud signaling

```bash
cd cloud/signaling
rm -f signaling.db                  # tests are not idempotent — see §1
uv sync --extra dev
uv run pytest --cov=app
uv run mypy app/
uv run ruff check app/
```

### Cloud relay

```bash
cd cloud/relay
uv sync --extra dev
uv run pytest                       # collects 0 tests today
uv run mypy app/
uv run ruff check app/
```

`cloud/relay/test_relay.py` sits at the package root, not in `tests/`, so pytest's default
discovery may or may not pick it up depending on the invocation directory. Move it into
`tests/`.

Minimum suite worth writing for the relay: two clients joining one `session_id` and exchanging
binary frames; a third client joining a full session; idle timeout; a rejected token.

### Web dashboards

```bash
cd web/remote
pnpm install
pnpm test                           # vitest
pnpm tsc -p tsconfig.app.json --noEmit
pnpm lint
pnpm prettier --check .

cd ../local
pnpm install
pnpm tsc -p tsconfig.app.json --noEmit
pnpm lint
pnpm prettier --check .
# no test script yet — add vitest, matching web/remote
```

Existing remote tests: `src/api/auth.test.ts`, `src/lib/http-frame.test.ts`,
`src/lib/webrtc.test.ts`.

### Suggested CI matrix

Six jobs, one per checkable unit, so a failure names its component:
`server`, `cloud/signaling`, `cloud/relay`, `web/local`, `web/remote`, plus a license-header
check for the SPDX requirement in `CLAUDE.md`. Python matrix 3.11 / 3.12; Node 20. Docker is not
available in CI, so Docker-dependent paths must be mocked, not skipped. PR
[#26](https://github.com/lem-app/lem/pull/26) implements this.

---

## 3. Manual verification

### 3.1 Prerequisites

- [ ] `docker version --format '{{.Server.Version}}'` prints a version
- [ ] `~/.lem/harbor/harbor.sh --version` prints a version
- [ ] `~/.lem/harbor/harbor.sh doctor` reports no `[ERROR]` lines
- [ ] `ls ~/.lem/harbor/compose.*.yml | wc -l` is non-zero — the catalog is derived from these
      files (`server/app/catalog/scanner.py:115`); with none, every list is empty
- [ ] Platform sanity: `docs/platform.md` §6

### 3.2 Local server

```bash
cd server && uv run uvicorn app.main:app --host 127.0.0.1 --port 5142
```

- [ ] Log shows `✓ Database initialized at ~/.lem/lem.db` and `✓ Job queue initialized`
      (`main.py:97`, `:102`)
- [ ] `~/.lem/lem.db` exists, and `sqlite3 ~/.lem/lem.db .tables` lists
      `auth device jobs settings`
- [ ] `curl -s localhost:5142/v1/health` returns `status: ok`
      *(on `main` this is hardcoded — it proves the process is up, nothing more; see
      [`api.md`](./api.md) §3)*
- [ ] `curl -s localhost:5142/v1/catalog | jq length` is non-zero and matches the compose-file
      count
- [ ] `curl -s localhost:5142/v1/services | jq '.[0]'` shows a plausible `status`
- [ ] `/docs` renders the OpenAPI UI

Service lifecycle, using a small service:

- [ ] `POST /v1/services/ollama/install` returns a `job_id`
- [ ] `GET /v1/jobs/<id>` walks `pending` → `running` → `completed`, with `progress` advancing
- [ ] A second install of the same service while the first runs returns **409** with `job_id` in
      the body
- [ ] `POST /v1/services/ollama/start` returns `{"status":"ok"}`
- [ ] `GET /v1/services/ollama` then shows `status: "running"` and a non-null `endpoint`
- [ ] `curl <endpoint>` reaches the service
- [ ] `POST /v1/services/ollama/stop` → status returns to `stopped`, **not** `not_installed`
- [ ] `POST /v1/services/ollama/remove` returns a `job_id` and the service returns to
      `not_installed`
- [ ] `GET /v1/services/nope` returns 404 with
      `detail.type == "https://lem.gg/errors/service-not-found"`

Off-by-default checks:

- [ ] Kill Docker, then `GET /v1/services` — it should report an error, not silently mark
      everything `not_installed`. On `main` it does the latter (`status.py:90-95`).
- [ ] Under PR #25: a request without `X-Lem-Client` to a POST route is rejected; with
      `LEM_HOST=0.0.0.0`, a request without the bearer token is rejected; `~/.lem/api_token` is
      mode 0600.

### 3.3 Local dashboard

```bash
cd web/local && pnpm dev      # http://localhost:5174
```

- [ ] Service catalog renders with categories
- [ ] Install shows a progress bar driven by `/v1/jobs` polling
- [ ] Start/Stop flip the badge, and the "Open" link points at the service's `endpoint`
- [ ] Model pull on Ollama completes and the model appears in the list
- [ ] The Remote Access panel shows tunnel status
- [ ] Stopping the server mid-session surfaces an error rather than a spinner forever
- [ ] No errors in the browser console

### 3.4 Cloud services

```bash
cd cloud/signaling && uv run uvicorn app.main:app --port 8000
cd cloud/relay     && uv run uvicorn app.main:app --port 8001
```

- [ ] `curl -s localhost:8000/health` → `{"status":"ok","timestamp":…}`
- [ ] `curl -s localhost:8001/health` → `{"status":"healthy","service":"relay","active_sessions":0}`
- [ ] `POST /auth/register` returns **201** with `access_token`; a duplicate email returns 400
- [ ] `POST /auth/login` with a wrong password returns 401
- [ ] `POST /devices/register` with a bearer token returns the device; without one, 401
- [ ] Registering a `device_id` already owned by another account returns **403**
- [ ] `GET /devices/` (trailing slash) lists only the caller's devices
- [ ] `WS /signal` closes with 1008 if no auth message arrives within 10 s
- [ ] A signaling message over 64 KiB is rejected with an `error` frame (`signal.py:266-270`)
- [ ] Two `wscat` clients on the same `/relay/<id>` exchange binary frames; a third connection
      does not break the pair

Security checks that currently **fail** — record them as known-open until the fixes land:

- [ ] A second account can join a relay session it does not own
      ([#15](https://github.com/lem-app/lem/issues/15)) — should be rejected
- [ ] An account can send a `connect-request` to a device belonging to someone else
      ([#16](https://github.com/lem-app/lem/issues/16)) — should be rejected
- [ ] Starting either service with `ENV=production` and no `SECRET_KEY` refuses to boot
      ([#18](https://github.com/lem-app/lem/issues/18))

### 3.5 Remote dashboard

```bash
cd web/remote && pnpm dev     # http://localhost:5173
```

- [ ] Login against the signaling server succeeds
- [ ] The browser registers itself as a device and `DeviceSelector` lists the local server's
      device id
- [ ] Connect reaches `connected` with `dataChannelState: "open"`
- [ ] `ConnectionStatus` reports `webrtc`
- [ ] `APITester` fetches `/v1/health` **through the tunnel**
- [ ] `ServicesCatalog` lists services fetched through the tunnel
- [ ] Start/stop a service from the remote dashboard and see the change reflected locally
- [ ] Job progress polls through the tunnel

---

## 4. End-to-end remote access — **currently fails**

This is the scenario that decides whether the README's headline claim is true. Run it from a
**genuinely different machine** — a second laptop, or a phone on cellular. Running both halves
on one machine hides defect #1 entirely, because the remote browser's own localhost happens to
have the right thing on it.

### Setup

| Role | Machine | Steps |
|---|---|---|
| Home | A | Start the local server; install and start Open WebUI + Ollama; pull a small model; log in from the local dashboard so the tunnel comes up |
| Cloud | reachable by both | Start signaling (`:8000`) and relay (`:8001`) with a shared `SECRET_KEY` |
| Away | B, different network | Open the remote dashboard; log in with the same account |

### Scenario

| # | Step | Expected | Today |
|---|---|---|---|
| 1 | Log in on B | Authenticated, device list shows A | **Passes** |
| 2 | Select A and connect | `connected`, DataChannel `open` | **Passes** |
| 3 | Open the service catalog | Services listed with real statuses | **Passes** |
| 4 | Start a stopped service from B | It starts on A | **Passes** |
| 5 | **Click Launch on Open WebUI** | Open WebUI's UI renders inside the dashboard | **FAILS** — `ClientViewer.tsx:281-286` renders `<iframe src="http://127.0.0.1:33801">`, so B loads **its own** loopback. Connection refused, or an unrelated local service. [#6](https://github.com/lem-app/lem/issues/6) |
| 6 | Open WebUI's WebSocket connects | socket.io session established | **FAILS** — never reaches OPEN: `ws-proxy.ts:99` sends WS_CONNECT, nothing calls `handleConnectionOpened` (`ws-proxy.ts:444`), no ack frame type exists, and the server says so at `ws_proxy.py:146`. `send()` throws at `ws-proxy.ts:162`. [#6](https://github.com/lem-app/lem/issues/6) |
| 7 | Send a chat message | Reply streams token by token | **FAILS** — blocked by 5 and 6; also impossible on the wire, since a response is one un-chunked frame (`http_frame.py:200-224`, `webrtc_client.py:905`) |
| 8 | Load a binary asset (font, PNG, wasm) | Byte-identical | **FAILS** — bodies are UTF-8 `str` (`http_proxy.py:154`, `http_frame.py:80`, `:211`, `:189`) |
| 9 | Block UDP on B's network and reconnect | Falls back to the relay within ~10 s | **FAILS** — auto-fallback cannot trigger: `webrtc_client.py:722` resets the attempt counter every cycle, and `relay_url` defaults to `ws://localhost:8001` (`webrtc_client.py:69`), never overridden (`manager.py:81`). [#12](https://github.com/lem-app/lem/issues/12) |
| 10 | Force a 500 from the proxy | Error appears immediately | **FAILS** — the error frame is addressed to request id `0x01000000` because `http_proxy.py:115` reads `data[:4]` instead of `data[1:5]`, so the browser hangs the full 30 s (`proxy-fetch.ts:179-182`) |

Steps 5–8 and 10 are fixed by [`tunnel-proxy-spec.md`](./tunnel-proxy-spec.md); step 9 by
[#12](https://github.com/lem-app/lem/issues/12).

### Acceptance criteria for "remote access works"

- [ ] Steps 1–8 pass from a different machine on a different network
- [ ] Step 9 passes, with the fallback observable in the UI within 15 s
- [ ] Step 10 surfaces the error in under 1 s
- [ ] Nothing listening on B's loopback is required — verify by running B with all local
      services stopped
- [ ] Streaming is visibly incremental, not a single late paint

### Per-phase criteria during implementation

Each phase of the tunnel spec has its own testable criteria — see
[`tunnel-proxy-spec.md`](./tunnel-proxy-spec.md) §9. Do not treat this end-to-end scenario as
the only gate; it is the last one.

---

## 5. Regression checks worth automating first

Highest value per line of test code, given the defects above:

1. **Cross-language frame vectors.** A fixture of hex-encoded frames that both the Python and
   TypeScript suites decode and re-encode identically. The v1→v2 drift that broke both test
   suites, and the correlation bug, both survive because nothing pins the two implementations
   together.
2. **Request-id correlation.** Drive `HTTPProxyHandler.handle_request` with a frame whose
   upstream raises and assert the response's `request_id` matches the request's. Fails on `main`.
3. **Binary round trip.** A PNG through the frame codec, compared by SHA-256.
4. **Oversized declared length.** A frame declaring 4 GiB with 10 bytes of payload must raise
   before allocating (PR #25's caps).
5. **Docker unavailable.** With `DOCKER_HOST` pointed at a dead socket, `/v1/services` must
   report an error, not an empty/`not_installed` catalog.
6. **Job idempotency.** Two concurrent installs of one service → exactly one job, second
   request 409.
7. **Signaling test isolation.** Per-test temporary database, so re-runs are deterministic.
8. **Relay pairing.** Two clients, one session, binary frames both ways.

---

## 6. Release checklist

Before tagging anything:

- [ ] Every gate in §2 green on a clean checkout, enforced by CI
- [ ] Coverage > 80 % for `server/` ([#22](https://github.com/lem-app/lem/issues/22))
- [ ] §3 manual checks pass on macOS, Linux, and WSL2
- [ ] §4 end-to-end scenario passes from a different machine
- [ ] All `critical`-labelled issues closed
- [ ] README claims match measured behaviour — no roadmap item ticked that §4 fails
- [ ] `CLAUDE.md`'s Related Docs links all resolve
- [ ] SPDX headers on every new source file
