# Cross-Platform Guide

`CLAUDE.md` mandates a single source of platform truth:

```python
from app.config.platform import PLATFORM, DOCKER_SOCKET, DOCKER_HOST
```

This document is the reference for that module: what it exports, what it decides, and what each
supported platform actually looks like underneath.

> **Status.** `server/app/config/platform.py` is **not on `main` yet**. It lands with branch
> `fix/platform-and-docker-correctness` ([#9](https://github.com/lem-app/lem/issues/9),
> [#10](https://github.com/lem-app/lem/issues/10),
> [#11](https://github.com/lem-app/lem/issues/11),
> [#13](https://github.com/lem-app/lem/issues/13)). Everything documented in §2–§5 describes
> that module as written on that branch. §7 lists the code on `main` that still bypasses it and
> is therefore broken away from macOS.
>
> Read the module directly with:
> `git show fix/platform-and-docker-correctness:server/app/config/platform.py`

---

## 1. Supported platforms

| Platform | `platform.system()` | `PLATFORM` | `IS_WSL` | Support |
|---|---|---|---|---|
| macOS (Intel and Apple silicon) | `Darwin` | `"macos"` | `False` | Supported |
| Linux | `Linux` | `"linux"` | `False` | Supported |
| Windows via WSL2 | `Linux` | `"linux"` | `True` | Supported |
| Native Windows (Python outside WSL) | `Windows` | — | — | **Rejected at import** |

Native Windows raises at import time rather than being half-supported:

```
RuntimeError: Native Windows is not supported. Run Lem inside WSL2, where Docker
and Harbor see Linux-style paths.
```

Harbor is a Bash entrypoint (`~/.lem/harbor/harbor.sh`) driving Docker Compose with POSIX
paths; there is no coherent native-Windows story, so the module fails loudly instead of
producing subtly wrong paths. Anything other than `Darwin`/`Linux`/`Windows` raises
`RuntimeError: Unsupported platform: <name>`.

**WSL2 is Linux.** `IS_WSL` exists for reporting (it appears in the `/v1/health` `platform`
block on that branch) and for writing precise bug reports. No code should branch on it —
Docker, Harbor, and paths behave exactly as on Linux.

---

## 2. Module API

`server/app/config/platform.py`, re-exported from `app.config`
(`server/app/config/__init__.py`).

### Constants

| Name | Type | Value |
|---|---|---|
| `PLATFORM` | `Literal["macos", "linux"]` | Normalised OS, computed once at import |
| `IS_WSL` | `bool` | `True` only under WSL2 |
| `OS_TYPE` | `str` | Raw `platform.system()` — `"Darwin"`, `"Linux"`, `"Windows"` |
| `ARCH` | `str` | Raw `platform.machine()` — `"x86_64"`, `"arm64"`, `"aarch64"` |
| `LEM_HOME` | `Path` | `Path.home() / ".lem"` |
| `HARBOR_DIR` | `Path` | `LEM_HOME / "harbor"` |
| `HARBOR_SCRIPT` | `Path` | `HARBOR_DIR / "harbor.sh"` |
| `DOCKER_SOCKET` | `Path \| None` | Local socket path, or `None` for a remote endpoint |
| `DOCKER_HOST` | `str` | Value to export to Docker/Harbor subprocesses |

### Functions

| Signature | Behaviour |
|---|---|
| `get_platform() -> PlatformType` | `Darwin`→`"macos"`, `Linux`→`"linux"`, `Windows`→`RuntimeError`, else `RuntimeError`. |
| `is_wsl() -> bool` | `False` unless `platform.system() == "Linux"` **and** `/proc/version` contains `microsoft` (case-insensitive). An unreadable `/proc/version` returns `False`. |
| `get_docker_socket_path() -> Path \| None` | Resolves the local socket. See §3. |
| `get_docker_host_uri() -> str` | Resolves the `DOCKER_HOST` value. See §3. |

`PlatformType` is exported for annotations.

`PLATFORM`, `IS_WSL`, `DOCKER_SOCKET`, and `DOCKER_HOST` are **module-level constants computed
at import**. Tests that need a different platform must monkeypatch `platform.system` (or
`os.environ["DOCKER_HOST"]`) and call the *functions*, not read the constants — which is what
`server/tests/test_platform.py` on that branch does.

---

## 3. Docker endpoint resolution

Two questions, two functions. They agree, but they answer different things:
`get_docker_socket_path()` answers *"is there a socket file, and where?"*;
`get_docker_host_uri()` answers *"what do I put in the child process's environment?"*.

### `get_docker_host_uri()`

```
if os.environ["DOCKER_HOST"] is set and non-empty:
    return it unchanged
return f"unix://{get_docker_socket_path()}"
```

An existing `DOCKER_HOST` is **passed through untouched**. That is the fix for a specific bug:
the earlier code did `f"unix://{DSP_SOCKET}"` unconditionally, so a user with
`DOCKER_HOST=tcp://10.0.0.5:2375` got the nonsense value `unix://tcp:/10.0.0.5:2375`.

### `get_docker_socket_path()`

```
override = os.environ.get("DOCKER_HOST")
if override:
    scheme, sep, remainder = override.partition("://")
    if not sep:            return Path(override)     # bare path
    if scheme in {unix, npipe}:  return Path(remainder)
    return None                                       # remote endpoint
if PLATFORM == "macos":    return ~/.docker/run/docker.sock
return /var/run/docker.sock
```

| `DOCKER_HOST` | `DOCKER_SOCKET` | `DOCKER_HOST` (resolved) |
|---|---|---|
| unset, macOS | `~/.docker/run/docker.sock` | `unix:///Users/you/.docker/run/docker.sock` |
| unset, Linux / WSL2 | `/var/run/docker.sock` | `unix:///var/run/docker.sock` |
| `unix:///var/run/docker.sock` | `/var/run/docker.sock` | `unix:///var/run/docker.sock` |
| `npipe:////./pipe/docker_engine` | `//./pipe/docker_engine` | `npipe:////./pipe/docker_engine` |
| `/var/run/docker.sock` (bare) | `/var/run/docker.sock` | `/var/run/docker.sock` |
| `tcp://10.0.0.5:2375` | `None` | `tcp://10.0.0.5:2375` |
| `ssh://user@host` | `None` | `ssh://user@host` |
| `""` (empty) | platform default | platform default |

### The TCP / remote case

`DOCKER_SOCKET is None` means **there is no socket file**. Any code that stats, `chmod`s, bind-mounts,
or otherwise touches the socket path must handle `None`:

```python
from app.config.platform import DOCKER_HOST, DOCKER_SOCKET

if DOCKER_SOCKET is None:
    # Remote daemon (tcp://, ssh://). Nothing local to inspect.
    logger.info(f"Using remote Docker endpoint: {DOCKER_HOST}")
elif not DOCKER_SOCKET.exists():
    raise RuntimeError(f"Docker socket not found at {DOCKER_SOCKET}. Is Docker running?")
```

Two caveats for remote endpoints, neither solved by the module:

- A service reported as running is reachable at `http://127.0.0.1:<port>` **on the Docker
  host**, not on the machine running Lem. `services/status.py` builds
  `http://127.0.0.1:<host_port>` unconditionally, so `endpoint` is wrong under a remote
  `DOCKER_HOST`. Untested territory.
- Harbor's own compose files bind-mount host paths. A remote daemon will not see them.

Remote `DOCKER_HOST` is *tolerated*, not *supported*.

### Per-platform notes

**macOS.** Docker Desktop's user-scoped socket is `~/.docker/run/docker.sock`.
`/var/run/docker.sock` usually exists too as a root-owned symlink, but the user-scoped path is
what Docker Desktop guarantees, so it is the default.

**Linux.** `/var/run/docker.sock`, root-owned, group `docker`, mode 0660. If Docker calls fail
with permission denied, the user is not in the `docker` group:

```bash
sudo usermod -aG docker "$USER"   # then log out and back in
```

Rootless Docker uses `$XDG_RUNTIME_DIR/docker.sock` instead — set `DOCKER_HOST` explicitly:

```bash
export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"
```

**WSL2.** Two very different setups, and the difference is the single most common WSL support
question:

| Setup | Socket | Notes |
|---|---|---|
| Docker Desktop with WSL integration enabled | `/var/run/docker.sock` inside the distro | Docker Desktop injects it. Enable it in *Settings → Resources → WSL Integration* for your distro. |
| Docker Engine installed inside the distro | `/var/run/docker.sock` | Needs `sudo service docker start` (or systemd on WSL ≥ 0.67.6). |

Either way the path is the Linux default, which is why `IS_WSL` never changes the answer.
Run Lem **inside** the WSL distro, not from a Windows Python — see §1.

---

## 4. Path handling

Always `pathlib.Path`, always anchored at `Path.home()`.

```python
# ✅
from app.config.platform import HARBOR_SCRIPT, LEM_HOME
db_path = LEM_HOME / "lem.db"
subprocess.run([str(HARBOR_SCRIPT), "up", service_id], ...)

# ❌
LEM_HOME = "/home/user/.lem"
HARBOR = f"{LEM_HOME}/harbor/harbor.sh"
```

`subprocess` needs `str(path)` — pass `str(HARBOR_SCRIPT)`, never the `Path` inside an f-string
built by hand.

The standard layout:

```
~/.lem/
├── lem.db            # SQLite (+ lem.db-wal, lem.db-shm in WAL mode)
├── api_token         # PR #25 only; mode 0600
└── harbor/           # Harbor checkout
    ├── harbor.sh
    ├── .env
    ├── compose.yml
    ├── compose.<service>.yml       # one per service; the catalog scanner reads these
    └── compose.x.<svc>.<dep>.yml   # cross-service extensions; dependencies come from these
```

`db.py` on `main` computes `LEM_HOME` itself (`server/app/db.py:38-39`); it should import from
`app.config.platform` once the module lands, so there is one definition.

---

## 5. Writing platform-aware code

```python
# ✅ one import, one source of truth
from app.config.platform import DOCKER_HOST, PLATFORM

env = {**os.environ, "DOCKER_HOST": DOCKER_HOST}

# ❌ scattered detection
import platform
if platform.system() == "Darwin":
    sock = Path.home() / ".docker/run/docker.sock"
```

Rules:

1. **Never call `platform.system()` outside `app/config/platform.py`.**
2. **Never hardcode a socket path.** `DOCKER_HOST` covers every case, including remote.
3. **Never branch on `IS_WSL`.** It is for reporting only.
4. **Shell out to Docker in exactly one module.** On the platform branch that is
   `app/services/status.py`, whose `_run_docker()` is the only place `["docker", …]` is
   spawned, with a 10 s timeout and `DockerUnavailableError` on `FileNotFoundError`,
   `TimeoutExpired`, and `CalledProcessError`. Harbor lifecycle commands run through
   `app/services/lifecycle.py`.
5. **Never block the event loop.** `subprocess.run` inside an `async def` freezes every other
   request. Use `await asyncio.to_thread(subprocess.run, …)`, as `lifecycle.py:88-95` already
   does. This is [#11](https://github.com/lem-app/lem/issues/11).
6. **Report the platform in errors.** The branch's 503 for an unreachable daemon carries
   `docker_host` in the RFC 7807 body, which turns "docker isn't working" into an actionable
   report.

---

## 6. Diagnosing a platform problem

```bash
# What does the module decide here?
cd server && uv run python -c "
from app.config.platform import ARCH, DOCKER_HOST, DOCKER_SOCKET, IS_WSL, OS_TYPE, PLATFORM
print(f'{OS_TYPE=} {ARCH=} {PLATFORM=} {IS_WSL=}')
print(f'{DOCKER_SOCKET=}')
print(f'{DOCKER_HOST=}')
"

# Does Docker agree?
docker version --format '{{.Server.Version}}'

# Is Harbor there?
~/.lem/harbor/harbor.sh --version
~/.lem/harbor/harbor.sh doctor
```

Once the branch lands, `GET /v1/health` reports the same facts over HTTP:

```json
{
  "status": "ok",
  "components": { "docker": "ok (v27.3.1)", "harbor": "ok (v0.3.20)", "…": "…" },
  "platform": { "os": "Linux", "arch": "x86_64", "platform": "linux",
                "wsl": true, "docker_host": "unix:///var/run/docker.sock" }
}
```

| Symptom | Likely cause |
|---|---|
| Every service shows `not_installed` on Linux | Hardcoded macOS socket on `main` — §7 |
| `permission denied` on `/var/run/docker.sock` | User not in the `docker` group |
| `RuntimeError: Native Windows is not supported` | Python is running on Windows, not inside WSL |
| `docker version` times out | Daemon wedged, or `DOCKER_HOST` points somewhere unreachable |
| `Harbor CLI not usable at …/harbor.sh` | Harbor not installed, or `harbor.sh` not executable |
| Service `endpoint` unreachable with a `tcp://` `DOCKER_HOST` | Expected — §3 |

---

## 7. What `main` gets wrong today

These are the sites the platform module replaces. All of them hardcode the **macOS** Docker
Desktop socket, so on Linux and WSL2 every Docker call fails and every service reports
`not_installed`. This is [#10](https://github.com/lem-app/lem/issues/10).

| File:line | Problem |
|---|---|
| `server/app/services/status.py:36` | `DSP_SOCKET = Path.home() / ".docker" / "run" / "docker.sock"` |
| `server/app/services/status.py:39-44` | `_get_docker_env()` sets `DOCKER_HOST` to `unix://{DSP_SOCKET}`, ignoring any existing `DOCKER_HOST` |
| `server/app/services/lifecycle.py:57-62` | A second copy of the same helper |
| `server/app/drivers/harbor_wrapper.py` | A third Docker-env copy, plus blocking `subprocess.run` on the event loop ([#11](https://github.com/lem-app/lem/issues/11)) |
| `server/app/db.py:38-39` | Defines `LEM_HOME` independently |
| `server/app/catalog/scanner.py:37` | Defines `HARBOR_DIR` independently |
| `server/app/main.py:160-174` | `/v1/health` returns `"docker": "ok"` unconditionally, so a totally broken Docker setup still looks healthy |

`server/app/drivers/harbor_wrapper.py:31` also cites `docs/harbor_review_2025-10-24.md`, which
does not exist in this repository ([#21](https://github.com/lem-app/lem/issues/21)). The
factual content of that reference — Harbor lives at `~/.lem/harbor/harbor.sh`, routing is via
`DOCKER_HOST`, there is no `harbor-config.yaml`, the pinned version is 0.3.20 — is preserved in
this document and in that module's docstring.

---

## 8. Tests

`server/tests/test_platform.py` on the platform branch covers, by monkeypatching
`platform.system` and `os.environ`:

- `Darwin`→`macos`, `Linux`→`linux`, `Windows`→`RuntimeError` with WSL guidance, unknown→`RuntimeError`
- WSL detection: `microsoft` in `/proc/version` → `True`; plain Linux → `False`; missing
  `/proc/version` → `False`; macOS → `False`; and WSL still reports `PLATFORM == "linux"`
- Socket defaults per platform
- `DOCKER_HOST` overrides: `tcp://` and `ssh://` pass through untouched with
  `DOCKER_SOCKET is None`; `unix://` and `npipe://` resolve to a path; a bare path is treated as
  a socket; an empty value falls back to the platform default
- Constant/function consistency

Run them with `cd server && uv run pytest tests/test_platform.py`. They need no Docker daemon
and no particular host OS — which is the point.

See also: [`architecture.md`](./architecture.md) · [`api.md`](./api.md) ·
[`testing_checklist.md`](./testing_checklist.md)
