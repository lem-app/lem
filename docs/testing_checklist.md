# Testing Checklist

How to verify Lem — automated gates, per-component manual checks, and the end-to-end scenario
that defines "remote access works".

**Read this first**: `main` still does not pass its own gates — but for different reasons than
it did a week ago. Every test suite is green now; what is red is formatting, lint, and coverage
headroom. §1 records a **re-measured** baseline so you can tell a regression you caused from one
you inherited.

**§1 is a perishable measurement, not a specification.** It is pinned to a commit. Before
trusting any row, re-run the command in that row — the whole table is cheap to reproduce, and it
has already gone stale once (PRs [#24](https://github.com/lem-app/lem/pull/24) and
[#26](https://github.com/lem-app/lem/pull/26) landed between two revisions of this document and
flipped most of it).

---

## 1. Baseline on `main`

**Re-measured 2026-08-01 at `506af26`** (includes #24 and #26). The previous revision of this
table was measured at `28baea7`, before both landed, and every row it contained about tests,
types, or lint has since changed.

### Python services

| Gate | Command (from the service directory) | server | cloud/signaling | cloud/relay |
|---|---|---|---|---|
| deps | `uv sync` | **PASS** | **PASS** | **PASS** |
| deps (CI form) | `uv sync --locked --all-extras` | **PASS** | **PASS** | **PASS** |
| tests | `uv run pytest` | **40 passed**, 0 failed | **9 passed**, 0 failed | **0 collected** (exit 5) |
| lint | `uv run ruff check app/ tests/` | **7 errors** (5 F401, 2 E501 — all in `tests/`) | **0** | **0** |
| format | `uv run ruff format --check app/` | **6 files** | **7 files** | **4 files** |
| types | `uv run mypy app/` | **0 errors**, 34 files | **0 errors**, 14 files | **0 errors**, 10 files |
| coverage | see below | **19.32 %** | **67.05 %** | **0.00 %** |

### Web dashboards

| Gate | Command (from the app directory) | web/local | web/remote |
|---|---|---|---|
| deps | `pnpm install --frozen-lockfile` | **PASS** | **PASS** |
| types (CI form) | `pnpm exec tsc --build --noEmit` | **PASS** | **PASS** |
| lint | `pnpm exec eslint .` | **2 errors** | **4 errors** |
| format | `pnpm exec prettier --check .` | **25 files** | **20 files** |
| build | `pnpm run build` | **PASS** | **PASS** |
| tests | `pnpm exec vitest run` | **no tests** (no script, no vitest dep) | **28 passed**, 0 failed |

### What this means

**Green**: every test suite that exists, and every `mypy app/` check.
**Red**: `ruff format --check app/` in all three Python services, `ruff check app/ tests/` in
`server`, and `eslint` + `prettier` in both web apps. CI (§2) is therefore currently failing on
5 of its 7 check runs; only `license-headers` and `dco` are green.

None of the red rows are test failures. That distinction matters when triaging: a red build
today is a formatting or lint debt, not a broken behaviour.

### Rows that flipped since `28baea7` — do not trust an older copy of this table

| Row | Old claim | Now |
|---|---|---|
| server pytest | 5 failed, 33 passed | **40 passed, 0 failed** |
| server dev deps | plain `uv sync` never installs pytest | **plain `uv sync` works** — see the `--extra dev` warning below |
| server ruff (`app/`) | 9 errors | **0 errors** |
| signaling pytest | 3 failed / 6, non-idempotent | **9 passed, idempotent** across three consecutive runs |
| signaling mypy | 9 errors in 5 files | **0 errors**, 14 files |
| signaling ruff | 3 errors | **0 errors** |
| web/remote vitest | 2 failed / 25 passed | **28 passed, 0 failed** |
| CI | none; no `.github/` | **7 check runs**, incl. DCO, license headers, and a real type-check gate (§2) |
| formatting | "37 files" from one root command | **25 + 20 = 45**, and the root command does not run at all — see below |

### ⚠️ `uv sync --extra dev` is now a hard error

PR #24 moved dev dependencies to PEP 735 `[dependency-groups]` in **all three** Python services
(`server/pyproject.toml:64-74`, `cloud/signaling/pyproject.toml:47-59`,
`cloud/relay/pyproject.toml:42-52`). None of them declares `[project.optional-dependencies]` at
all. So:

```
$ uv sync --extra dev
error: Extra `dev` is not defined in the project's `optional-dependencies` table
```

Plain `uv sync` is now correct and installs the dev tooling. An earlier revision of this
document prescribed `--extra dev` in §2 for server, signaling and relay — that instruction
failed on the first command of three of the five component gates and has been removed.

### Coverage needs `pytest-cov`, which only `server` declares

```bash
cd server        && uv run pytest --cov=app --cov-report=term-missing        # 19.32 %
cd cloud/signaling && uv run --with 'pytest-cov==7.0.0' pytest --cov=app     # 67.05 %
cd cloud/relay     && uv run --with 'pytest-cov==7.0.0' pytest --cov=app     #  0.00 %
```

In signaling and relay, plain `pytest --cov=app` exits 4 with
`unrecognized arguments: --cov=app`. CI uses the `--with` form for all three.

### `prettier` does not run from the repository root

There is **no root `package.json`** and no `pnpm-workspace.yaml`. From the root,
`pnpm prettier --check .` fails with `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` and
`pnpm exec prettier --check .` with `ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE`. The old single
"formatting — 37 files" row was not a runnable gate. Run it per app, as CI does.

### `tsc --noEmit` is still a no-op — do not trust it

**Unchanged by #24 and #26, and still the sharpest trap in this repo.** Both `tsconfig.json`
files are solution-style: `"files": []` plus `"references"` (`web/remote/tsconfig.json`,
`web/local/tsconfig.json`). In non-build mode that yields a program with **zero root files**, so
the command always passes. Re-measured today with `--listFiles | wc -l`: **0** in both apps.

Consequently `web/remote`'s `"type-check"` script (`web/remote/package.json:13`) is still a
no-op — it runs the bare `tsc --noEmit` — and so is `CLAUDE.md`'s documented command.
`web/local` has no `type-check` script at all. Fixing those two scripts is a genuinely open item.

Use one of these instead:

```bash
pnpm exec tsc --build --noEmit            # what CI runs; walks every project reference
pnpm exec tsc -p tsconfig.app.json --noEmit   # type-checks src/ only
```

`tsconfig.app.json` reports **137** files (local) / **115** (remote), against 0 for the
solution config. CI deliberately uses `tsc --build --noEmit` rather than `pnpm run type-check`,
precisely because the script is wrong.

### Fixed since the last revision — kept for provenance

Two problems this document used to prescribe workarounds for are **resolved**; the workarounds
are obsolete and were removed from §2.

- **Stale frame tests in both languages.** The HTTP frame format gained a leading `frame_type`
  byte; the serializers were updated, the tests were not. Python failed with
  `Expected HTTP_REQUEST frame (0x01), got 0x00`; TypeScript with `expected 33554432 to be 42`
  — `0x02000000`, the response frame's type byte read as the top octet of a `getUint32(0)`.
  That accounted for all 5 server failures and both remote failures.
  **Fixed by [#24](https://github.com/lem-app/lem/pull/24)**; both suites are green.
- **Non-idempotent signaling tests.** Tests wrote to a persistent `signaling.db` in the working
  directory with no teardown, so results depended on what the previous run left behind.
  **Fixed by #24**: `cloud/signaling/tests/test_api.py:30-36` now monkeypatches
  `database.DATABASE_FILE` to a `tmp_path`-scoped file. Verified idempotent across three
  consecutive runs with a clean `git status` after each. **The `rm -f signaling.db` step is
  obsolete — do not re-add it.**

---

## 2. Automated gates

**CI is the authority on what these gates are.** PR [#26](https://github.com/lem-app/lem/pull/26)
landed `.github/workflows/ci.yml`, and it runs on every pull request and every push to `main`.
The commands below are the local equivalents of what CI runs — they are written to match it
exactly, so that passing locally means passing in CI. **If they ever diverge, the workflow file
wins**; a checklist that quietly prescribes a weaker gate than CI is worse than no checklist.
See §2.5 for the gate list and the coverage floors rather than duplicating them here.

### Local server

```bash
cd server
uv sync                             # NOT `--extra dev` — that is now a hard error, see §1
uv run ruff format --check app/
uv run ruff check app/ tests/
uv run mypy app/
uv run pytest --cov=app --cov-report=term-missing
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
uv sync                             # tests are idempotent now — no `rm -f signaling.db`
uv run ruff format --check app/
uv run ruff check app/ tests/
uv run mypy app/
uv run --with 'pytest-cov==7.0.0' pytest --cov=app --cov-report=term-missing
```

### Cloud relay

```bash
cd cloud/relay
uv sync
uv run ruff format --check app/
uv run ruff check app/ tests/
uv run mypy app/
uv run --with 'pytest-cov==7.0.0' pytest --cov=app   # collects 0 tests today; exit 5
```

`cloud/relay/test_relay.py` sits at the package root, not in `tests/`, so pytest's default
discovery may or may not pick it up depending on the invocation directory. Move it into
`tests/`.

Minimum suite worth writing for the relay: two clients joining one `session_id` and exchanging
binary frames; a third client joining a full session; idle timeout; a rejected token.

### Web dashboards

```bash
cd web/remote
pnpm install --frozen-lockfile
pnpm exec tsc --build --noEmit      # NOT `pnpm run type-check` — that script is a no-op, see §1
pnpm exec eslint .
pnpm exec prettier --check .
pnpm run build
pnpm exec vitest run                # `pnpm test` is watch mode; use `vitest run` for a gate

cd ../local
pnpm install --frozen-lockfile
pnpm exec tsc --build --noEmit
pnpm exec eslint .
pnpm exec prettier --check .
pnpm run build
# no test script yet — add vitest, matching web/remote
```

Existing remote tests: `src/api/auth.test.ts`, `src/lib/http-frame.test.ts`,
`src/lib/webrtc.test.ts` — 28 tests across 3 files.

### 2.5 CI gates (the source of truth)

`.github/workflows/ci.yml` — triggers on `pull_request` and on push to `main`; pinned to Python
3.11, Node 22, pnpm 10, `ubuntu-24.04`; no `continue-on-error` anywhere. **7 check runs:**

| Check run | What it runs |
|---|---|
| `server`, `cloud-signaling`, `cloud-relay` | `uv sync --locked --all-extras`, then `ruff format --check app/`, `ruff check app/ tests/`, `mypy app/`, and pytest with `--cov-fail-under` |
| `web-local`, `web-remote` | `pnpm install --frozen-lockfile`, `tsc --build --noEmit`, `eslint .`, `prettier --check .`, `pnpm run build`, and `vitest run` (skipped for `web-local`, which has no tests) |
| `license-headers` | `./scripts/check-license-headers.sh` — the SPDX requirement in `CLAUDE.md`. Currently green: 128 files checked, 10 skipped |
| `dco` | Every non-merge commit in the PR needs a `Signed-off-by:` whose name and email **match the commit author**. Commit with `git commit -s`. Skipped for dependabot |

**Per-service coverage floors** (`--cov-fail-under`), described in the workflow as a one-way
ratchet that may only go up:

| Service | Floor | Measured at `506af26` | Headroom |
|---|---|---|---|
| `server` | **17 %** | 19.32 % | +2.32 |
| `cloud-signaling` | **65 %** | 67.05 % | +2.05 |
| `cloud-relay` | **0 %** | 0.00 % | 0 |

A pytest exit code of 5 (no tests collected) is tolerated and downgraded to a warning — which is
the only reason `cloud-relay` passes. Every other non-zero exit fails the job.

**Do not restate the floors anywhere else in this document.** They are a ratchet; a second copy
is a second thing to forget to raise. The numbers above are a snapshot for orientation, and the
workflow file is what gates.

Two things CI does **not** do, so they remain manual: Docker is unavailable on the runners, so
every Docker-dependent path must be mocked rather than skipped, and nothing in CI exercises the
end-to-end remote-access scenario in §4.

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
| 6 | Open WebUI's WebSocket connects | socket.io session established | **Blocked** — the ack, the `ProxiedWebSocket` state machine and the injected shim all landed in Phase 5 and are covered in-suite, but socket.io runs *after* login, and login cannot work until cookie transport is redesigned ([`tunnel-proxy-spec.md`](./tunnel-proxy-spec.md) §5.6.2). Run §4.1 B/C to verify the shim half independently. [#6](https://github.com/lem-app/lem/issues/6) |
| 7 | Send a chat message | Reply streams token by token | **Blocked by 6** — the wire can carry it (Phases 2–3 made responses chunked and incremental) and the shim is in place, but an unauthenticated session never reaches a chat. §4.1 D is the procedure once it does |
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

### 4.1 Phase 5 — the two criteria no test in this repository can settle

Phase 5's acceptance list contains two items that name a real product, a real browser and a real
model:

- "Open WebUI's socket.io session establishes and a chat message round-trips"
- "A model response streams token by token into the UI — visually incremental, and asserted by
  timestamping the first and last DOM mutation"

There is **no browser automation in this repository and no Open WebUI in CI**, so no test here
settles either one. They stay unticked until a human runs the procedure below. A third item —
"`new WebSocket(...)` inside the iframe reaches `readyState === 1`" — is verified in-suite
against a real second realm and the shipped shim, but only a real browser exercises the Service
Worker's own delivery of that shim, so step C below re-checks it end to end.

Two behaviours in particular are **only** exercisable here, because jsdom cannot reproduce them
and the suite says so in the tests that touch them:

- a same-origin `window.parent` that really does expose `__lemWsBridge` (jsdom's `WindowProxy`
  does not forward properties, so the test re-points `parent`);
- a browser honouring `Set-Cookie` on a `Response` a Service Worker synthesised. Modern Chrome,
  Firefox and Safari do — the Fetch Standard dropped "forbidden response-header name" — but that
  is a claim about browsers, not something this suite proves.

Run the §4 setup first: machine A at home with Open WebUI and Ollama running and a small model
pulled, machine B on a different network. Everything below happens on **B**.

**A. Login — expected to FAIL, and this step is how you confirm why.**

> **Do not run this step expecting a pass.** A Service Worker cannot deliver `Set-Cookie` to the
> browser: it is a forbidden response-header name, and a worker-synthesised `Response` never
> reaches the algorithm that would parse it. See `tunnel-proxy-spec.md` §5.6.2. The steps below
> are written to *localise* the failure, so that when the cookie transport is redesigned there is
> a procedure that already distinguishes "the rewrite is wrong" from "the browser dropped it".

1. Launch Open WebUI from the remote dashboard and sign in with your Open WebUI account.
2. **Expected today:** the sign-in does **not** stick — the app returns to the login form. If it
   *does* stick, the cookie reached the jar by some route §5.6.2 says is impossible; that is worth
   investigating and reporting, not celebrating.
3. Open DevTools → Application → Cookies → the dashboard's origin.
   **Expected today: the cookie is absent** — dropped by the browser, not by this proxy. To see
   that the proxy did its part, open the Network panel entry for the login response: the
   `Set-Cookie` the worker produced is visible there even though nothing stored it.
   **Expected once the cookie transport works:** the session cookie is listed with
   **`Path` = `/app/<deviceId>/webui/`**
   (the ids from the iframe's URL), and with **no `Domain`** value of its own. `HttpOnly` and
   `SameSite` read exactly as Open WebUI set them.
4. In DevTools → Network, reload the frame and pick any request the app made.
   **Expected:** it carries the cookie. Now open a *second* service (Ollama, say) and pick one of
   its requests. **Expected:** it carries **no** Open WebUI cookie.
5. Reload the dashboard itself and look at any dashboard-originated request (`/v1/services`).
   **Expected:** no framed app's cookie on it.
6. **The decisive check, and the one no test here can make: did the cookie reach the upstream?**
   On **A**, watch the service's own access log (`docker logs -f <container>` for the Harbor
   container) while doing something authenticated on **B**.
   **Expected:** the request arrives carrying `Cookie: <the app's session cookie>`.

   This step exists because the browser attaches `Cookie` *after* the Service Worker sees the
   request, so what the worker forwards is whatever `event.request.headers` happens to contain.
   Whether that includes `Cookie` is a browser behaviour this repository cannot observe — jsdom
   has no cookie jar wired to `Request` — and the suite therefore *supplies* the header rather
   than proving the browser did. If this step fails while step 3 shows the cookie correctly
   stored, the defect is on the request path, not in the `Set-Cookie` rewrite, and the fix
   belongs with whatever mechanism the worker uses to read cookies.
7. **`__Host-` cookies specifically.** If the service sets one (Open WebUI does not; many
   hardened apps do), DevTools → Application → Cookies shows it stored as
   **`__Lem-Host-<name>`**, and the dashboard console carries a
   `[sw-bridge] Renamed __Host-… to __Lem-Host-…` warning.
   **Expected on A:** the upstream still logs the cookie under its **original** `__Host-` name.
   A `__Host-` cookie that appears in DevTools *unrenamed* and with a per-service `Path` is a
   bug — the browser will refuse to store it and login will fail with no other symptom.

**B. The shim is in the document, and it is first.**

1. With the service framed, DevTools → Elements, expand the iframe's document.
2. **Expected:** the very first `<script>` in the document carries `data-lem-ws-shim="1"`, and it
   sits inside `<head>` ahead of every one of Open WebUI's own scripts.
3. In the console, switch the context selector to the iframe and evaluate `WebSocket.name`.
   **Expected:** `"LemWebSocket"`. Evaluate it again in the top frame.
   **Expected:** `"WebSocket"` — the dashboard's own realm is untouched.

**C. socket.io establishes and a chat message round-trips.**

1. Still in the iframe's console, evaluate `window.__lemWsShimInstalled`. **Expected:** `true`.
2. DevTools → Network → WS. **Expected: the list is empty.** A real WebSocket here would be the
   browser connecting from *B's* network, which is the defect this design removes; the traffic
   must be riding the DataChannel instead.
3. Send a chat message.
   **Expected:** it is accepted and a reply begins. On A, the local server log shows
   `WebSocket CONNECT <id>` followed by `WebSocket <id> connected successfully`.
4. If nothing happens, the diagnostic is in the dashboard's own console: a `close` with code
   **4002** means the shim could not reach `window.__lemWsBridge`; **4003** means the ack never
   arrived within 10 s; a `[sw-bridge] WebSocket shim not injected into …` warning means the
   splice was skipped for that document.

**D. The reply streams token by token.**

1. Ask for something long enough to take several seconds: "write 300 words about the sea".
2. **Expected, by eye:** text appears progressively, a few tokens at a time. A single late paint
   of the whole reply is a failure even if the content is correct.
3. To measure it rather than trust it, paste this into the **iframe's** console before sending,
   then send:

   ```js
   const target = document.querySelector('main') ?? document.body
   const stamps = []
   new MutationObserver(() => stamps.push(performance.now())).observe(target, {
     subtree: true,
     childList: true,
     characterData: true,
   })
   window.__lemStamps = stamps
   ```

   After the reply completes, evaluate:

   ```js
   const s = window.__lemStamps
   ;({ mutations: s.length, spanMs: s.at(-1) - s[0] })
   ```

   **Pass:** `mutations >= 20` **and** `spanMs >= 1000`. **Fail:** anything else — including the
   middle ground (say 8 mutations over 300 ms), which is a coarsely-buffered stream, not a
   token-by-token one, and is a regression against G4 even though it is not a single paint.
   There is deliberately no "inconclusive" band: if the reply took several seconds to generate,
   a working stream produces mutations across those seconds, and anything that does not is a
   failure to investigate rather than a judgement call. If the reply genuinely finished in under
   a second, the prompt was too short — ask for more and re-run rather than scoring it.

**E. A refused upstream fails fast, not after ten seconds.**

1. On A, stop Open WebUI while its frame is still open on B.
2. In the iframe's console: `const t = performance.now(); const w = new WebSocket('/ws/socket.io/?EIO=4&transport=websocket'); w.onclose = e => console.log(e.code, performance.now() - t)`.
3. **Expected:** a close logged in **well under 1000 ms**, with a code from §7.2 (`1011` for a
   refused upstream). A close at ~10000 ms with code `4003` means the `WS_CONNECT_ERROR` path is
   not working and the connect timeout is doing the job instead.

**F. A large message survives fragmentation.** Send a chat message with a pasted block of at
least 100 KB. **Expected:** Open WebUI receives it whole — the reply refers to the content, and
A's log shows no `message exceeded MAX_WS_MESSAGE_BYTES`.

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
