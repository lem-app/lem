# Quickstart Vision — The Target First Five Minutes

**Status:** Target UX specification. **Nothing in this document works today.**
**Audience:** implementation agents and contributors building toward v0.1.
**Companion:** [`positioning.md`](./positioning.md) explains *why* this is the priority.

---

## 0. How to use this document

This is a **narrative acceptance test**, not a design mockup. Every phase below states:

- **The story** — what the user sees, in order, as prose.
- **The contract** — exact commands, exact output, exact URLs.
- **Acceptance criteria** — checkable assertions an implementation agent can turn into a test.
- **Budget** — wall-clock time the phase may consume on a cold machine.

If a change makes any acceptance criterion below false, the change is wrong.
If a criterion is impossible, amend this document in the same PR that proves it impossible.

**The whole narrative is one continuous session.** A user who has never heard of Harbor,
Docker Compose, or WebRTC goes from a bare machine to talking to their own GPU from their
phone. Total budget: **five minutes of human attention**, excluding download time that shows
a progress bar.

---

## 1. Where we are starting from (the honest baseline)

The current documented quickstart is not five minutes and does not reach a phone. It is:

```bash
git clone https://github.com/lem-app/lem.git
cd lem
cd lem-app/server                 # ← this directory does not exist (README.md:39)
uv sync                            # ← does not install pytest; dev deps are optional (#20)
uv run uvicorn app.main:app --host 0.0.0.0 --port 5142   # ← binds to all interfaces, no auth (#7)
# second terminal
cd lem/lem-app/web/local           # ← also does not exist (README.md:44)
pnpm install && pnpm run dev       # ← a Vite dev server is the only way to get a UI
```

Measured facts behind that annotation:

| Claim | Evidence |
|---|---|
| The `lem-app/` path segment does not exist | `README.md:39` and `README.md:44`; repo root has no `lem-app/` directory |
| The server never serves the dashboard | `server/app/main.py` contains no `StaticFiles` mount; static serving exists only on the unmerged `feat/install-script` branch (`server/app/main.py:752` there) |
| The local API has no authentication | No auth dependency anywhere in `server/app/main.py` across 26 endpoints; only CORS at `server/app/main.py:141-154` (#7) |
| The advertised one-liner cannot work | `scripts/install.sh:8` on `feat/install-script` advertises `curl -sSf https://lem.gg/install \| bash`; `https://lem.gg/install` returns **HTTP 404**; and the script resolves its own location via `${BASH_SOURCE[0]}` at `:301`, `:338`, `:543` — under a pipe that evaluates to the literal string `main`, so `dirname` yields `.` and the script silently treats the user's **current working directory** as the repo root |
| Consequently the one-liner exits 1 | With no `../server/pyproject.toml` relative to CWD, `install_lem_server()` falls through to `scripts/install.sh:326-332`, which prints "Clone the repository first" and exits |
| There is no hosted signalling or relay | `signal.lem.gg` and `relay.lem.gg` (referenced in `web/remote/.env.production.example`) do not resolve in DNS |
| Remote model access does not work | #6 — the viewer renders `<iframe src={appInfo.url}>` at `web/remote/src/components/ClientViewer.tsx:281`, loading the *remote browser's own* localhost |

So the gap between this document and reality is the whole of v0.1.

---

## 2. Design commitments

These are the non-negotiable principles the narrative encodes. They are listed first so that
an implementation agent can resolve ambiguity without re-deriving intent.

1. **One command, no prerequisites beyond Docker.** No git clone. No `uv`. No `pnpm`. No
   Node. The installer brings its own runtime or downloads a built artifact. If the user must
   read a second instruction before something happens, we have failed.
2. **Every long operation is visible and interruptible.** Model pulls and image pulls show
   bytes, percentage, and ETA. `Ctrl-C` is always safe and always resumable.
3. **Default-deny on the network.** The local server binds `127.0.0.1` and requires a token.
   Reaching it from another device is an explicit, deliberate act — that act is *the product*,
   and it must feel like unlocking a door, not like discovering one was never locked.
4. **The phone is a first-class client, not a shrunk-down desktop.** The pairing flow is
   designed for a camera and a thumb.
5. **The default model must fit the machine.** We detect RAM/VRAM and choose. A user whose
   first experience is an OOM or a 40-minute swap-thrash does not come back.
6. **Never claim a security property we do not implement.** This is a UX commitment, not
   only an engineering one — see #17 for what happens when we break it.

---

## 3. The narrative

### Phase 1 — Install (budget: 90 seconds of attention, plus visible download)

**The story.** The user is on the Lem homepage. There is one box with one line in it and a
copy button. They paste it into a terminal. The installer explains what it is about to do,
does it, and hands them a URL. They never see a Python traceback, a `pnpm` warning, or the
word "uvicorn".

**The contract.**

```bash
curl -fsSL https://lem.gg/install.sh | sh
```

That URL must serve the script itself. The script must be **location-independent**: it may
not derive anything from `$0` or `${BASH_SOURCE[0]}`, because both are meaningless under a
pipe. It downloads a versioned release artifact and installs from that.

Target transcript:

```
  Lem installer

  ✓ Platform         linux (x86_64)
  ✓ Docker           28.1.1, daemon reachable
  ✓ Hardware         32 GB RAM · NVIDIA RTX 4070 (12 GB VRAM)

  This will install to ~/.lem
    · lem server        ~40 MB
    · Harbor v0.3.20    ~15 MB   (github.com/av/harbor — service definitions)
    · lem CLI           → /usr/local/bin/lem

  Proceed? [Y/n] y

  ✓ Downloading lem 0.1.0                              [####################] 40 MB
  ✓ Installing Harbor v0.3.20
  ✓ Creating ~/.lem                                    (config, data, logs)
  ✓ Generating access token                            ~/.lem/config/token  (mode 0600)
  ✓ Installing service                                 systemd --user: lem.service
  ✓ Server healthy                                     http://127.0.0.1:5142

  Open your dashboard:

      http://127.0.0.1:5142/?t=8f3a2c1e9b7d4a60

  Next:  lem status · lem pair · lem --help
```

**Acceptance criteria.**

| # | Assertion |
|---|---|
| 1.1 | `curl -fsSL https://lem.gg/install.sh \| sh` completes with exit 0 on a machine with **only** Docker installed — no git, no Python, no Node. |
| 1.2 | The installer contains zero references to `$0`, `${BASH_SOURCE[0]}`, or `dirname` for locating its own source. Enforced by a grep in CI. |
| 1.3 | Passes on macOS (arm64, Docker Desktop), Ubuntu (x86_64, Docker Engine), and WSL2. Enforced by a CI matrix (#20). |
| 1.4 | Re-running the installer is idempotent and upgrades in place; it never leaves a half-state. |
| 1.5 | If Docker is missing, the installer prints the platform-correct install instruction and exits **non-zero without partial installation**. |
| 1.6 | The server binds `127.0.0.1` only. `curl http://<LAN-IP>:5142/v1/health` from another host fails to connect. (#7) |
| 1.7 | `~/.lem/config/token` is mode `0600`; so is any private key. (#14) |
| 1.8 | Every request to a state-changing endpoint without a valid token returns `401`. (#7) |
| 1.9 | The dashboard is served by the Lem server itself. No Node runtime is present on the machine. |
| 1.10 | Total elapsed time to "Server healthy" is under 60 s on a 100 Mbit connection, excluding the Docker image pulls of Phase 2. |

**Explicitly not in scope for Phase 1.** No account. No email. No cloud contact of any kind.
A user who never wants remote access must be able to stop reading here and have a working,
useful, entirely offline product. This is a strategic commitment, not a convenience: it is
what makes the remote layer an *upsell* rather than a *tax*.

---

### Phase 2 — First model running (budget: 60 seconds of attention)

**The story.** The dashboard opens already authenticated — the token was in the URL and is
immediately exchanged for a cookie and stripped from the address bar. There is no menu to
explore, no catalog to browse, no configuration. There is one card that says what it is going
to do and one button. The user presses it and watches a progress bar. When it finishes, a
chat box appears with the cursor already in it.

**The contract.**

First-run dashboard state:

```
┌──────────────────────────────────────────────────────────────┐
│  Let's get a model running.                                  │
│                                                              │
│  Recommended for your machine (12 GB VRAM):                  │
│                                                              │
│     Llama 3.1 8B  ·  4.7 GB  ·  fast, general purpose        │
│                                                              │
│  This installs Ollama and Open WebUI in Docker.              │
│                                                              │
│           [  Start  ]        Choose a different model ▾      │
└──────────────────────────────────────────────────────────────┘
```

After pressing Start, one progress surface — not four:

```
  Setting up            ●●●○  3 of 4

  ✓ Ollama              running on :33821
  ✓ Open WebUI          running on :33801
  ⟳ Llama 3.1 8B        2.9 GB / 4.7 GB   ·   61%   ·   ~40s left
  ○ Warming up
```

Then, in place, without a page transition:

```
┌──────────────────────────────────────────────────────────────┐
│  Llama 3.1 8B is running on your machine.                    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Ask it something…                                    ↵ │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Also available:  Open WebUI ↗   ·   85 more services ▾      │
└──────────────────────────────────────────────────────────────┘
```

**Model selection policy.** Detected VRAM (falling back to system RAM for CPU-only) picks
the default. The table is a starting point for implementation and should be revisited
against real benchmarks:

| Detected | Default | Size |
|---|---|---|
| < 6 GB | Llama 3.2 3B (Q4) | ~2.0 GB |
| 6–10 GB | Llama 3.1 8B (Q4) | ~4.7 GB |
| 10–24 GB | Llama 3.1 8B (Q8) or Qwen 2.5 14B | ~8–9 GB |
| > 24 GB | Qwen 2.5 32B (Q4) | ~20 GB |

The dropdown must show *why* each option is or is not recommended ("won't fit in 12 GB VRAM —
will run on CPU, roughly 10× slower"), never a bare list.

**Acceptance criteria.**

| # | Assertion |
|---|---|
| 2.1 | The token in `?t=` is exchanged for a session cookie on first load and removed from the URL via `history.replaceState` before any other request. |
| 2.2 | Pressing Start requires **zero** further input to reach a streaming token. |
| 2.3 | The model pull streams real progress. It must not block the server's event loop — today `pull_ollama_model` at `server/app/drivers/runners/ollama.py:320` is a synchronous call that freezes the server for the duration (#11). |
| 2.4 | The chat box streams the first token in under 10 s on the recommended model. |
| 2.5 | `Ctrl-C` / closing the tab mid-pull leaves resumable state, not a stuck `RUNNING` job (#13). |
| 2.6 | Works identically on Linux and WSL2 — requires the platform module to actually be adopted; the macOS Docker socket is currently hardcoded at `server/app/drivers/harbor_wrapper.py:51` (#10). |
| 2.7 | If the pull fails, the error names the cause and offers one concrete action. Never a raw Harbor or Docker stderr dump. |
| 2.8 | Total elapsed from Start to first streamed token is under 4 minutes on a 100 Mbit connection for the 8B default. |

---

### Phase 3 — Reach it from your phone (budget: 90 seconds of attention)

**This is the phase that differentiates Lem.** Phases 1 and 2 are table stakes that Ollama
already does well. If this phase is not delightful, Lem has no reason to exist.

**The story.** The user clicks "Use from my phone". A QR code appears with a countdown. They
open their phone camera — no app to install — and point it at the screen. The phone opens a
web page that installs to their home screen. It shows the same chat box. They type a question
and the answer streams back from the GPU in the other room. The dashboard, meanwhile, shows a
new entry: "iPhone · paired just now · P2P (direct)".

**The contract.**

```
┌──────────────────────────────────────────────────────────────┐
│  Use Lem from your phone                                     │
│                                                              │
│              ████ ▄▄▄▄ █▀▀█ ████                             │
│              ██ ▀▀▄ █▄▄▀ ▄▄ ██                               │
│              ████ ▀█▀▀ ▄█▄█ ████                             │
│                                                              │
│  Scan with your phone's camera.                              │
│  Code expires in 4:52.                                       │
│                                                              │
│  Your phone will connect directly to this machine.           │
│  Traffic does not pass through Lem's servers when a direct   │
│  connection is possible.                                     │
│                                                              │
│  On a network that blocks direct connections?                │
│  Lem can relay through lem.gg — the relay can see your        │
│  traffic. [Learn what this means]                            │
└──────────────────────────────────────────────────────────────┘
```

The last two paragraphs are load-bearing and must not be softened. #17 exists because the
README claimed end-to-end encryption that the relay path does not provide
(`cloud/relay/README.md:74` — "v0.1: TLS only, relay sees plaintext"). The UI must state the
true property of whichever path is actually in use, and must update live if the path changes.

Post-pair dashboard state:

```
  Paired devices

  📱  iPhone (Safari)      ·  connected  ·  direct P2P     [revoke]
  💻  This machine         ·  local
```

**What the QR encodes.** A short-lived, single-use pairing token plus the coordinates needed
to find this machine — nothing else. Specifically **not** the account JWT, and **not** a
client-derived session identifier. #15 is a proven cross-account compromise precisely because
session IDs are built client-side as `${browserDeviceId}-${targetDeviceId}`
(`web/remote/src/hooks/useWebRTC.ts:48`) from guessable device IDs. The pairing token must be
minted server-side, be unguessable, expire in minutes, and be redeemable once.

**Connection sequence, with what the user sees at each step:**

| Step | User sees | Underlying |
|---|---|---|
| 1 | "Connecting…" | Phone redeems the pairing token; signalling binds the two device identities |
| 2 | "Found your machine" | Offer/answer exchanged, ICE gathering |
| 3 | "Connected directly" | DTLS-secured DataChannel established |
| 3′ | "Connected via relay — lem.gg can see this traffic" | ICE failed; relay path, honestly labelled |
| 4 | Chat box, focused | Tunnel serving the same UI as the desktop |

Step 3′ must appear within **10 seconds**, not the 60 s+ that #12 documents today, and it
must actually be reachable — today the fallback counter is reset every cycle and can never
trigger (`server/app/tunnel/webrtc_client.py:722`, `:732`).

**Acceptance criteria.**

| # | Assertion |
|---|---|
| 3.1 | Scanning the QR with a stock iOS or Android camera app reaches a working chat, with no app install. |
| 3.2 | The phone page is installable to the home screen: it ships a web app manifest and a service worker. Neither exists today — there is no manifest and no service worker anywhere under `web/`. |
| 3.3 | The remote UI is designed mobile-first. Today `web/remote/` has a viewport meta tag and roughly ten responsive utility classes in total across all components, and the app viewer is a fixed `h-[calc(100vh-300px)]` iframe (`web/remote/src/components/ClientViewer.tsx:284`). |
| 3.4 | Pairing tokens are server-minted, single-use, and expire ≤ 5 minutes. (#15) |
| 3.5 | Signalling refuses to route to a device the authenticated user does not own — verified by an automated regression test reproducing #16's exploit. |
| 3.6 | The relay refuses a session join by any identity not negotiated into that session — verified by an automated regression test reproducing #15's exploit. |
| 3.7 | The UI's stated security property matches the active transport, live. On the relay path it says the relay can see the traffic. (#17) |
| 3.8 | Fallback from failed P2P to relay completes within 10 s. (#12) |
| 3.9 | A revoked device cannot reconnect, and its in-flight tunnel is torn down within 5 s. |
| 3.10 | Model responses **stream** token-by-token over the tunnel — this requires working proxied WebSockets, which today never open because no `WS_CONNECT_ACK` frame exists (`server/app/tunnel/ws_proxy.py:146`, `web/remote/src/lib/ws-proxy.ts:444`). (#6) |
| 3.11 | Works from cellular data with the phone's Wi-Fi off — the true test that this is not just LAN access. |
| 3.12 | **The pairing flow works when the phone belongs to someone else.** Per [`positioning.md`](./positioning.md) §3, the buyer is usually setting this up *for another person* — a partner, a parent, a housemate. That person must reach a working chat from a scanned code without touching a terminal, without an account of their own, and without understanding what a tunnel is. This is the product's real success metric: **second-device activations per install.** |

---

### Phase 4 — The catalog is the second visit, not the first

**The story.** Nothing above mentions the other 85 services, and that is deliberate. Once the
user has something working, "85 more services" in the corner becomes an invitation rather than
a decision. On the second visit they click it and find a browsable catalog: SearXNG, ComfyUI,
LibreChat, n8n, Whisper. Each one installs with the same single button, and — critically —
each one is reachable from the phone through the same tunnel that already works.

**The contract.** The catalog already exists and is real: `server/app/catalog/registry.py`
carries curated metadata for ~82 services across BACKEND / FRONTEND / SATELLITE categories,
and `server/app/catalog/scanner.py:91` discovers services dynamically from Harbor's compose
files. This is Lem's most underexploited asset.

The gap is on the tunnel side. `server/app/tunnel/router.py:127` resolves exactly **one**
service ID — `openwebui` — and returns `None` for everything else, and
`server/app/drivers/clients/` contains exactly one driver. So of ~89 catalog services, one is
addressable remotely, and that one is broken (#6).

**Acceptance criteria.**

| # | Assertion |
|---|---|
| 4.1 | Any installed catalog service with an HTTP UI is reachable through the tunnel with no per-service code. Routing is generic — driven by the scanned port from `scanner.py`, not by an `if client_id == …` chain. |
| 4.2 | Installing a service from the catalog is one button and shows the same progress surface as Phase 2. |
| 4.3 | The catalog states, per service, RAM/VRAM requirements and whether the current machine can run it. |
| 4.4 | Removing a service removes only that service's images — today removal uses an unanchored substring match that deletes unrelated images (#9). |

---

## 4. What "five minutes" actually means

| Phase | Human attention | Wall clock (100 Mbit, cold) |
|---|---|---|
| 1 — Install | 90 s | ~60 s |
| 2 — First model | 60 s | ~3–4 min (mostly a progress bar) |
| 3 — Phone | 90 s | ~20 s |
| **Total** | **~4 min** | **~5–6 min** |

The claim is *five minutes of attention*, and we should say exactly that rather than implying
five minutes of wall clock. Overstating this is the same failure mode as #17: a promise the
implementation does not keep.

---

## 5. Failure modes the narrative must handle

A quickstart is judged by its unhappy paths. Each of these needs a designed response, not a
stack trace.

| Situation | Required behaviour |
|---|---|
| Docker not installed | Platform-correct instruction, exit non-zero, install nothing |
| Docker installed but daemon not running | "Docker is installed but not running. Start Docker Desktop and re-run." |
| Port 5142 occupied | Pick the next free port and say so; never fail |
| Insufficient disk for the model | Say how much is needed and how much is free, *before* starting the pull |
| No GPU detected | Proceed on CPU with a smaller default and an honest speed warning |
| Model pull interrupted | Resume on retry; no stuck `RUNNING` job (#13) |
| QR code expired | Regenerate in one click; never a dead end |
| P2P fails (symmetric NAT / CGNAT) | Relay within 10 s, honestly labelled (#12, #17) |
| Relay unavailable or user declined | Offer LAN-only mode and say plainly that remote access is unavailable |
| Phone on the same LAN | Prefer the direct LAN route; still say which route is in use |

---

## 6. Non-goals for this narrative

Deliberately excluded, so implementation agents do not gold-plate:

- **No account required for local use.** Accounts belong to Phase 3 and nowhere earlier.
- **No native mobile app.** A well-built installable web app is the target. A native app is
  a v1.0+ question and should not be started before Phase 3 works.
- **No multi-user or sharing.** One person, their machines. Sharing is a v1.0 idea that
  cannot be designed responsibly until #15/#16 are closed and the ownership model is real.
- **No model fine-tuning, RAG setup, or agent building.** Lem runs services; it is not the
  application layer.
- **No Windows-native path.** WSL2 only, stated plainly up front.

---

## 7. Ordered dependency chain

Phase 3 is the differentiator, but it cannot be built first — it stands on the security and
correctness work. This is the build order:

```
#20  CI + green baseline
      └─ #7, #8, #14   local API auth, SSRF, secret permissions   → Phase 1 criteria 1.6–1.8
      └─ #10, #11, #13 platform module, async, job recovery        → Phase 2 criteria 2.3, 2.5, 2.6
            └─ install script rewritten, location-independent      → Phase 1
            └─ dashboard served by the server                      → Phase 1 criterion 1.9
                  └─ #15, #16, #17  session/device authorization   → Phase 3 criteria 3.4–3.7
                        └─ #12       relay fallback that triggers  → Phase 3 criterion 3.8
                        └─ #6        service worker tunnel proxy   → Phase 3 criterion 3.10
                              └─ generic catalog routing           → Phase 4
```

Nothing in Phase 3 should be demoed publicly before #15 and #16 are closed. Both are proven
cross-account compromises, and a pairing demo is exactly the scenario that exposes them.
