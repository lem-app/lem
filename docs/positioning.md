# Lem — Positioning, Competitive Analysis, and Strategy

**Date:** 2026-08-01
**Status:** Strategy document. Opinionated. Written to be argued with.
**Companion:** [`quickstart-vision.md`](./quickstart-vision.md) — the target first-run UX.

---

## Executive summary

Lem's stated thesis is "local AI management + secure remote access, and nobody is on both
sides." **That gap closed while the code was being written.**

On **4 June 2026**, LM Studio shipped [LM Link and the Locally
app](https://lmstudio.ai/blog/locally-lm-link) — a local model runtime, a first-party iPhone
app, and zero-config encrypted transport ["in partnership with
Tailscale"](https://lmstudio.ai/docs/lmlink). That is Lem's pitch, shipped, by a company with
a mature product and a real distribution channel.

Meanwhile **Harbor — Lem's own foundation — already ships a desktop GUI, a service catalog, a
QR code to open a service on your phone, and `harbor tunnel` for internet exposure via
Cloudflare.** Lem currently re-exposes Harbor's catalog through a worse UI and a broken
tunnel.

So the honest position is: **the two-sided gap Lem was built to fill is now occupied on both
flanks, and Lem has 3 GitHub stars, 36 commits, one contributor, no CI, no working remote
access, three proven cross-account compromises, and no hosted service** (`signal.lem.gg` and
`relay.lem.gg` do not resolve in DNS).

That is the bad news, and it is most of the news.

The good news is narrow but real. Across every product surveyed — Tailscale, ngrok,
Cloudflare, LM Studio, and a dozen mobile Ollama clients — **not one manages the lifecycle of
a multi-service AI stack behind an authenticated remote connection.** Tailscale explicitly
does networking and tells you to bring your own stack. Every mobile client is "type in a URL
and hope you can reach it." LM Studio owns lifecycle only for its own single runtime. Harbor
owns lifecycle but its remote story is *"here is a public URL, now go configure authentication
yourself."*

**The defensible position is: authenticated, identity-bound remote access to a whole managed
AI stack — not to one model, and not via a public URL.** That is much narrower than the
original thesis, it is squarely in the part of the codebase that is most broken (#15, #16,
#17), and it is worth pursuing only if the security model becomes genuinely excellent.

One more thing that should shape expectations before anything else is read. **This product has
already been built and abandoned once.** Faraday/Backyard AI shipped "Mobile Tethering" —
*"utilize your computer's local resources remotely from a web browser"*, *"100% free"* — in
**February 2024**. Their desktop app is now *"deprecated and no longer supported"* and they
sell hosted inference at $12–35/month instead (§2.6). The economics of free tethering to
hardware the user already owns point one way, and every company that has held both ends has
drifted toward renting GPUs. **That is the strongest argument for Lem being open source, and
the strongest argument against expecting it to fund itself.**

**The one move I would make first:** stop building features and close #15, #16, #7. Not
because security is virtuous, but because *authenticated remote access is now the entire
product*, and Lem currently has an unauthenticated one.

---

## 1. What Lem is today

### 1.1 The README versus the code

The README's roadmap marks four of five v0.1 items complete. Measured against `main`:

| README claim | Reality | Evidence |
|---|---|---|
| "One-Click Setup" (`README.md:9`) | No install script on `main` at all — `scripts/` contains only `launch_aws_test.sh` and `launch_servers.sh`. The installer lives on the unmerged `feat/install-script` branch and its advertised one-liner cannot work (§1.2) | `scripts/`; #23 |
| "Secure Remote Access… WebRTC P2P or encrypted relay" (`README.md:10`) | **Control plane only.** JSON API calls work over the DataChannel. Viewing an actual service does not | #6 |
| Relay fallback (`README.md:177`) | **Can never trigger.** The attempt counter resets every cycle at `server/app/tunnel/webrtc_client.py:722`; and the default `relay_url` is `ws://localhost:8001`, never overridden | #12 |
| "End-to-end encryption: All remote traffic is encrypted" (`README.md:65`) | False on the relay path. `cloud/relay/README.md:74` states plainly: "v0.1: TLS only, relay sees plaintext" | #17 |
| "Device registration: ed25519 public key authentication" (`README.md:67`) | The keypair is generated and never used. `load_keypair_from_b64()` and `public_key_from_b64()` in `server/app/crypto.py` have **zero call sites**. Every browser registers the literal string `'browser-key'` (`web/remote/src/api/auth.ts:70`) | #17 |
| "Privacy-First… remote access requires your explicit authentication" (`README.md:11`) | The local API that controls Docker has **no authentication on any route**: 26 handlers in `server/app/main.py` plus 4 in `server/app/api/v1/auth.py`, with no auth dependency or middleware anywhere — only a CORS allowlist at `server/app/main.py:141-154`, which is not authentication | #7 |
| "Cross-Platform: macOS, Linux, Windows (WSL2)" (`README.md:13`) | The macOS Docker socket is hardcoded at `server/app/drivers/harbor_wrapper.py:51`; `server/app/config/platform.py` does not exist on `main` | #10 |
| Quick Start commands (`README.md:39,44`) | Reference a `lem-app/` directory that does not exist in the repository | #21 |

Three findings are **proven cross-account compromises requiring nothing but a free account**:

- **#15** — a JWT for `mallory@evil.com` joined a session established by `alice@example.com`,
  read Alice's forwarded bytes, and injected a response Alice accepted.
- **#16** — `mallory@evil.com` sent a `connect-request` targeting a device owned by
  `victim@example.com` and the victim's machine bridged its local services to an
  attacker-chosen relay session.
- **#7** — the local API controlling Docker has no authentication and is documented to bind
  `0.0.0.0` on every launch path.

Chained, #16 into #15 is a full tunnel into a stranger's local AI services.

### 1.2 The install one-liner cannot work — three separate reasons

This deserves its own subsection because it is the single most-cited item in the thesis being
tested here, and the mechanism matters.

`scripts/install.sh:8` on `feat/install-script` advertises:

```bash
curl -sSf https://lem.gg/install | bash
```

1. **The URL 404s.** `https://lem.gg/install` returns HTTP 404. `https://lem.gg` returns 200
   and serves a single headline, "Lem — Your AI library, anywhere." There is nothing to pipe.

2. **The script cannot locate itself.** Lines `:301`, `:338`, and `:543` do
   `script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`. Under a pipe, bash sets
   `${BASH_SOURCE[0]}` to the literal string `main` — verified empirically:

   ```
   $ printf 'f(){ echo "[${BASH_SOURCE[0]}]"; }\nf\n' | bash
   [main]
   ```

   So `dirname` yields `.`, the `cd` **succeeds**, and `script_dir` silently becomes the
   user's current working directory. This is worse than failing: behaviour depends on where
   the user happened to be standing.

3. **It never downloads anything.** With no `../server/pyproject.toml` relative to CWD,
   `install_lem_server()` falls through to `scripts/install.sh:326-332` and exits 1 with
   "Clone the repository first." **The one-liner's best case is an error message telling you
   to `git clone`.**

For contrast, [Harbor's own installer](https://raw.githubusercontent.com/av/harbor/main/install.sh)
is documented as `curl -fsSL https://raw.githubusercontent.com/av/harbor/main/install.sh | bash`
and explicitly handles being piped — it detects running under `/bin/sh` and re-executes itself
under bash. **Lem's dependency has a working one-liner; Lem does not.**

### 1.3 What genuinely works

Not everything is broken, and the working parts are the ones worth building on:

- **The catalog is real and is the best thing in the codebase.**
  `server/app/catalog/scanner.py:91` discovers services by parsing Harbor's compose files;
  `server/app/catalog/registry.py` carries 81 curated `ServiceMetadata` entries and falls back
  to `_generate_default_metadata()` for anything unrecognised (`registry.py:661`), so **the
  catalog grows automatically when Harbor adds services**. Verified locally: 89 service
  compose files present.
- **Service lifecycle works** — install/start/stop/remove, with async jobs (on macOS; #10
  breaks Linux/WSL2).
- **The control plane genuinely tunnels** — JSON API calls over the WebRTC DataChannel work.
  That is a real achievement, just not the advertised feature.
- **Byte metering scaffolding exists** in the relay (`cloud/relay/app/core/session_manager.py:141-151, 182-193`),
  which is the plumbing a metered business model would need.

### 1.4 Project maturity — the number nobody wants to look at

| Metric | Value |
|---|---|
| GitHub stars | **3** |
| Forks / watchers | **0 / 0** |
| Total commits | **36** |
| Distinct human contributors | **1** (all commits by Blake Martz) |
| Repo created | 2025-10-26 |
| CI | **None.** No `.github/` directory (#20) |
| Server test coverage | **19%** against a stated >80% bar; 5 tests failing on `main` (#20, #22) |
| Relay test coverage | **0%** — `tests/` holds only `__init__.py` (#20) |
| Hosted signalling / relay | **Do not exist.** `signal.lem.gg` and `relay.lem.gg` (referenced in `web/remote/.env.production.example`) do not resolve in DNS |

**Strategic reading:** Lem is pre-launch, not early-stage. There are no users to lose and no
moat to defend. Every framing in this document should therefore be about *earning the first
hundred users*, not about defending a position. That also means the security debt, while
severe, is currently a liability only to the maintainer — which is exactly the window in which
to fix it.

---

## 2. Competitive landscape

### 2.1 The market has three layers, at three different temperatures

| Layer | Status | Implication |
|---|---|---|
| **Mobile chat client** | ~10 credible free/OSS apps, 55k+ aggregate stars | Commoditized. Building one is undifferentiated on arrival. |
| **Secure transport** | Tailscale won, is free for 6 users, and now OEMs into LM Studio | Owned. Building a competitor is a multi-year infrastructure project. |
| **Multi-service lifecycle behind an authenticated remote connection** | **Zero products found** | The only open ground. |

### 2.2 Comparison table

| Product | What it is | Manages service lifecycle? | Remote from anywhere? | Auth on the remote path? | Multi-service catalog? | License | Traction |
|---|---|---|---|---|---|---|---|
| **[Ollama](https://ollama.com/blog/all-aboard-open-models)** | Model runtime | Models only, single runtime | **No** — its answer is Ollama Cloud (run on *their* GPUs) | n/a | No | MIT | **177,478 stars**; $88M raised; 8.9M devs |
| **[Open WebUI](https://docs.openwebui.com/getting-started/open-webui-as-app/)** | Chat frontend | No | No — "it's a PWA, you sort out HTTPS" | App-level login only | No | BSD-3 **+ branding restriction**, exempt under 50 users | **147,500 stars** |
| **[LM Studio + LM Link](https://lmstudio.ai/blog/locally-lm-link)** | Runtime + desktop + **iPhone app** | Yes — for its own runtime | **Yes**, since 4 Jun 2026 | Yes, via Tailscale identity | No — single runtime | **Proprietary** ("exclusive property of Element Labs"; no SaaS/redistribution) | Category leader |
| **[Harbor](https://github.com/av/harbor)** | CLI + desktop app for a whole local AI stack | **Yes — the best in class** | **Yes** — `harbor tunnel` (cloudflared) | **No** — "⚠️ Ensure to configure authentication for the service" | **Yes — 89 services, 252 integrations** | Apache-2.0 | **3,150 stars**, 215 forks, v0.5.4 (20 Jul 2026) |
| **[Tailscale](https://tailscale.com/pricing)** | Mesh VPN | **No** — explicitly | Yes, excellent | Yes, excellent | No | Clients BSD-3, control plane proprietary | Category leader; free ≤6 users |
| **[Pangolin](https://github.com/fosrl/pangolin)** | Self-hosted tunnel + reverse proxy | No | Yes | Yes | No | AGPL-3 (CE) | **22,000+ stars** |
| **[Pinokio](https://desktop.pinokio.co/)** | "AI browser" / one-click app launcher | Yes — JSON install scripts | **LAN only** — v8 (8 Jul 2026) added a "Home Server" with QR phone access | No | Yes | MIT (shell) | 7.8k stars but **41,670 Discord members**; 41k Windows downloads in 2 weeks |
| **[Jan](https://jan.ai/docs/desktop/api-server)** | Desktop app + local API server | Models only | LAN only | **Yes — API keys, trusted-host allowlist, CORS; binds `127.0.0.1` by default** | No | Apache-2.0 + attribution request | 43.8k stars; claims 6.1M downloads |
| **[LocalAI](https://localai.io/docs/features/authentication/)** | OpenAI-compatible inference engine | Models only | No first-party remote product | **Yes — OIDC, GitHub OAuth, per-user API keys and quotas** | No | MIT | 48.1k stars; 5.84M Docker pulls |
| **[Backyard AI](https://backyard.ai/blog/mobile-tethering)** (ex-Faraday) | Desktop app + **"Mobile Tethering"**, Feb 2024 | Yes | **Yes — and they killed it** (§2.6) | Yes | No | Proprietary | Desktop **"deprecated and no longer supported"**; now sells hosted inference at $12–35/mo |
| **Mobile Ollama clients** ([Chatbox](https://github.com/Bin-Huang/chatbox) 41.2k, [Enchanted](https://github.com/gluonfield/enchanted) 6.0k, [Conduit](https://github.com/cogwheel0/conduit) 1.9k, [Reins](https://github.com/ibrahimcetin/reins) 524) | Chat UIs | **No** | **No** — BYO tunnel; Enchanted's README tells you to install ngrok | Whatever you configured | No | GPL/MIT/Apache | 55k+ aggregate |
| **[OpenLLM Bridge](https://openllmbridge.com/)** | Hosted web UI + desktop bridge | **No** — requires Ollama already running | Yes, via their relay | Yes | No | Proprietary ("planning to open-source… soon") | Early/unknown |
| **[nekoni](https://github.com/nekonihq/nekoni)** | Local agent + phone via **P2P WebRTC** | Partial | Yes | Ed25519 mutual auth | No | MIT | **13 stars** |
| **Lem (today)** | Catalog + lifecycle + tunnel | **Yes** | **No** (#6) | **No** (#7, #15, #16, #17) | **Yes — inherited from Harbor** | AGPL-3.0-or-later | 3 stars |

### 2.3 The Harbor question — the sharpest one in this analysis

**Lem is a GUI and a tunnel wrapped around Harbor. Harbor now has a GUI and a tunnel.**

What Harbor already ships:

| Capability | Harbor | Source |
|---|---|---|
| Service catalog | 18 UIs, 23 backends, 80+ satellites; **89 service compose files and 252 cross-service integration files** verified in a local install | [README](https://raw.githubusercontent.com/av/harbor/main/README.md) |
| Pre-wired integrations | `harbor up searxng speaches` wires them into Open WebUI automatically | README |
| Desktop GUI | **Harbor App** — Linux/macOS/Windows(WSL2), "manage Harbor stack and individual services," themes | [wiki](https://github.com/av/harbor/wiki/1.1-Harbor-App) |
| **QR code to your phone** | `harbor qr` — "Generates a QR code for the service URL and prints it in the terminal" | [CLI reference](https://github.com/av/harbor/wiki/3.-Harbor-CLI-Reference) |
| LAN access | `harbor url --lan` / `-a` | CLI reference |
| **Internet tunnel** | `harbor tunnel [service]` via cloudflared — "will print the URL of the tunnel as well as the QR code for it" | CLI reference |
| Working `curl \| bash` install | Yes, with explicit pipe handling | [install.sh](https://raw.githubusercontent.com/av/harbor/main/install.sh) |
| Integration testing | v0.5.4 added a suite exercising **40 services end-to-end** | [release](https://api.github.com/repos/av/harbor/releases/latest) |

**This is uncomfortable and should be stated plainly: for a user who wants "manage lots of
local AI services and open one on my phone," Harbor is today a strictly better product than
Lem, is more mature, has 1,000× the users, and is Apache-2.0.**

Three things remain genuinely different, and they are the whole case for Lem's existence:

1. **Harbor's tunnel has no identity model.** `harbor tunnel` produces a public
   `trycloudflare.com` URL and warns *"⚠️ Ensure to configure authentication for the service"*
   and *"Exposing your services to the internet is dangerous. Be safe!"* There is no pairing,
   no device identity, no revocation, no per-user access. It hands you a loaded footgun with a
   label on it. Lem's architecture — accounts, device registration, session negotiation — is
   the right shape for solving this. It just does not work yet.

   The stakes are not hypothetical. Tailscale's own research
   ([Sept 2025](https://tailscale.com/blog/AI-endpoints-on-public-web)) cites Cisco Talos
   finding **1,100+ exposed Ollama endpoints** on the public internet via Shodan, ~1,000
   discovered in ten minutes. "Expose it and remember to add auth" is empirically a failure
   mode, not a feature.

2. **Harbor's remote path is per-service and manual.** You tunnel a service. Lem's model is a
   single authenticated connection to the *machine*, through which any catalog service is
   reachable. That is a better architecture — and `server/app/tunnel/router.py:127` currently
   implements it for exactly one service ID (`openwebui`), returning `None` for everything
   else. `server/app/drivers/clients/` contains exactly one driver.

3. **Harbor is CLI-first with a Tauri desktop companion that is local-only.** The Harbor App's
   documentation describes no way to manage a Harbor instance on another machine — all setup
   is local, or local-via-WSL2. A browser-based dashboard is inherently reachable from a phone
   in a way a Tauri desktop app is not. This is a real structural advantage that Lem is not
   currently using — `web/remote/` has a viewport meta tag, roughly **ten** responsive utility
   classes across all components, no web app manifest, and no service worker.

**Dependency risk is separate and material.** Lem pins Harbor **v0.3.20**
(`scripts/install.sh:31`). Harbor is at **v0.5.4** (20 Jul 2026). Lem is many minor versions
behind on a dependency it shells out to via `~/.lem/harbor/harbor.sh`
(`server/app/drivers/harbor_wrapper.py:45`) and whose compose-file layout it *parses*
(`server/app/catalog/scanner.py`). Harbor is Apache-2.0, so there is no licensing risk and
Lem may fork it — but every Harbor refactor of its compose-file conventions is a potential
silent break in Lem's catalog. Two mitigations are cheap and worth taking now: Harbor's
`harbor eject` renders a standalone Compose config, which caps lock-in, and pinning to a
recent tag rather than v0.3.20 would recover the ~40 services the pin is currently costing
(§7 Risk 1).

### 2.4 The LM Studio development changes the pitch

LM Studio's [LM Link](https://lmstudio.ai/blog/locally-lm-link) is the single most important
competitive fact in this document:

- Shipped **4 June 2026**; the *Locally* app team was acquired **8 April 2026**.
- Transport is **Tailscale**, in an announced partnership: *"All communication and data
  transfer between devices is always end-to-end encrypted, thanks to Tailscale."*
- Setup is: install app, follow in-app instructions. No tunnel configuration.
- LM Link pricing is not documented on their site; LM Studio's desktop product is free for
  personal and internal business use, so **assume free**.

**What this means:** "your phone talking to the GPU in your house, no cloud, no subscription"
is no longer an unclaimed pitch. A well-funded incumbent ships it, for free, with better
networking than Lem will build.

**Where LM Studio is beatable, and it is not on the demo:**

- **It is proprietary.** Its terms make the software "the exclusive property of Element Labs"
  and forbid using it "as an application service provider, or a software-as-a-service."
  Lem is AGPL-3.0-or-later and self-hostable end to end, including the transport.
- **It is single-runtime.** LM Link reaches *LM Studio's models*. It does not reach ComfyUI,
  n8n, SearXNG, Dify, LibreChat, Langflow, vLLM, or the other 80-odd services in Harbor's
  catalog.
- **It is iOS-only** so far (iPhone/iPad).
- **Its transport depends on a commercial third party.** A Tailscale pricing or policy change
  is LM Studio's problem, not Lem's.

That is the real competitive frame: **not "we do remote AI" but "we do remote *everything in
your AI stack*, and you can own the whole path."**

### 2.5 Demand signals

Evidence that the pain is real, with sources. Note the shape of it: the demand is for *safe
exposure*, and it is currently answered with tutorials rather than products.

| Signal | Evidence | Reading |
|---|---|---|
| **Exposing local AI safely is an unsolved, actively harmful problem** | Tailscale, [Sept 2025](https://tailscale.com/blog/AI-endpoints-on-public-web), cites Cisco Talos finding **1,100+ exposed Ollama endpoints** via Shodan — ~1,000 found in ten minutes; ~20% actively serving models, the rest empty but writable | People *are* exposing local AI to the internet, and doing it badly. This is the single strongest argument for Lem's authenticated-by-default position. |
| **Harbor itself binds to the world by default, and it is a known open complaint** | [Harbor #231](https://github.com/av/harbor/issues/231), "Harbor up should be private by default (bind to 127.0.0.1)", opened **14 Apr 2026**, showing `0.0.0.0:33801->8080/tcp`. Asks to "Listen to 127.0.0.1 by default", "Document the security concerns". **Open, no maintainer response, no label** | Harbor's security posture is a real gap its maintainer has not prioritized in ~4 months. This is the clearest evidence that Lem's differentiation has room — and a warning, since Lem's local server has the same defect (#7). |
| **Reverse-proxy / HTTPS setup is chronic pain** | **34 issues** with "reverse proxy" in the title in the Open WebUI tracker, spanning Nov 2023 → May 2026 — e.g. [#1233 "Help Needed for Production Reverse Proxy Setup"](https://github.com/open-webui/open-webui/issues/1233), [#87 "Doesn't work behind Cloudflare + reverse proxy"](https://github.com/open-webui/open-webui/issues/87), [#3054 "CORS problems with reverse proxy using HTTPS, tools, and websockets"](https://github.com/open-webui/open-webui/issues/3054) | Three years of unresolved "how do I reach this from outside" friction on the leading local AI UI. |
| **The answer is currently a blog post, not a product** | Tailscale publishes [*Self-host a local AI stack and access it from anywhere*](https://tailscale.com/blog/self-host-a-local-ai-stack) (May 2025), plus a cottage industry of third-party Tailscale+Ollama guides ([KDnuggets](https://www.kdnuggets.com/accessing-local-llms-remotely-using-tailscale-a-step-by-step-guide), [logarithmicspirals](https://logarithmicspirals.com/blog/using-tailscale-to-access-private-llms/), [glukhov.org](https://www.glukhov.org/llm-hosting/ollama/ollama-remote-access/)) — all requiring the user to hand-edit `OLLAMA_HOST=0.0.0.0:11434` into a systemd unit | The volume of tutorials *is* the demand signal. Tutorials exist where products do not. |
| **Mobile clients want it and punt on it** | [Enchanted](https://github.com/gluonfield/enchanted) (6.0k stars) tells users to "install ngrok and forward your Ollama server"; [Conduit](https://github.com/cogwheel0/conduit) (1.9k) points at Tailscale, Cloudflare Tunnel, oauth2-proxy, Authelia, Authentik; [Reins](https://github.com/ibrahimcetin/reins) markets "Remote Server Access… from anywhere" and ships zero networking | Every mobile client treats connectivity as the user's problem. That is the seam. |
| **Even Harbor's install has friction** | [Harbor #234](https://github.com/av/harbor/issues/234), "Install script fails due to HARBOR_* environment variable causing empty path" (4 comments) | Install is hard for everyone; it is table stakes, not a differentiator (see §8, thesis 1). |

**Counter-signal, stated honestly:** Harbor has **3,150 stars but only 56 open issues**, most
with zero comments, and 19 watchers. Open WebUI has 147k stars and its remote-access issues
mostly attract single-digit comment counts. **The pain is broad but shallow** — many people
hit it, few are angry enough to organize around it. That argues against expecting the fix to
go viral on its own, and against a "security-first" pitch as the acquisition message. It is a
retention argument, not a headline.

### 2.6 The precedent nobody talks about — Backyard AI already built this and retreated

This is the most important thing in the competitive research, and it is not about a
competitor's strength. It is about a gradient.

On **28 February 2024**, Faraday.dev (later Backyard AI) shipped **Mobile Tethering**:

> *"Tethering extends all the capabilities of Backyard AI's desktop experience to mobile, by
> allowing you to utilize your computer's local resources remotely from a web browser."*
> …*"100% free to use"*, *"Unlimited generations at zero cost."*
> — [backyard.ai/blog/mobile-tethering](https://backyard.ai/blog/mobile-tethering)

That is Lem's product. Shipped, free, in early 2024.

As of today, [desktop.backyard.ai](https://desktop.backyard.ai/) states: **"The desktop app is
deprecated and no longer supported"** — "Last Updated: about 1 year ago". Backyard now sells
**hosted inference on their hardware** at [$12/mo Standard and $35/mo Pro](https://backyard.ai/plans),
with the free tier capped at 300 messages/week.

**They went from "use your own GPU from your phone, free and unlimited" to "rent our GPU."**

Why this matters more than any feature comparison:

1. **The economic gradient runs against local-first.** Free tethering to hardware the user
   already owns generates no revenue, costs real support effort, and produces the worst
   support burden in the product (every NAT, every router, every carrier). Hosted inference
   monetizes immediately. Every company that has held both has drifted toward the latter —
   Backyard did it, and Ollama is doing it now ([Ollama Cloud](https://ollama.com/cloud):
   Free / $20 Pro / $100 Max / $25-per-seat Team, on the back of $88M raised).
2. **This is the strongest argument for Lem being open source, and possibly its only durable
   one.** Backyard's users could not continue the product when the company's incentives moved.
   AGPL means Lem's users can. That is a real, differentiated promise — but it is a promise
   about *survivability*, not about features, and it should be marketed as such.
3. **It is also a warning about sustainability.** A well-funded startup found this product
   unsustainable enough to abandon. Lem is one unpaid person. The plan must not depend on
   revenue that Backyard, LM Studio, and Ollama have all concluded is elsewhere (§6).

---

## 3. Who the user actually is

The README lists four use cases including "share your local models with trusted collaborators"
and "centralize AI infrastructure without cloud vendor lock-in" (`README.md:16-21`). Those
describe a team-infrastructure product. The code describes a single-user homelab tool. The
code is right; the README should change.

### The real user

**A technically confident individual who already owns a GPU and already runs local AI.**
They have Docker. They have used Ollama. They may already run Harbor or Open WebUI. They are
on r/LocalLLaMA. They are not a Kubernetes operator and they are not a beginner — beginners
do not have a 12 GB GPU sitting at home.

Critically: **they already solved "local AI" and are annoyed by the tenth thing, not the
first.** Lem's competition for their attention is not "no solution"; it is "a solution that
already works well enough."

Two secondary users, both worth naming and both worth *deferring*:

- **The privacy-motivated non-expert** who wants ChatGPT without OpenAI. Real, growing, and
  the reason install experience matters — but they will not get past Docker as a prerequisite,
  so they are a v1.0+ audience at best.
- **The small team** wanting shared local inference. This is where money is, and it is
  irresponsible to pursue before #15/#16 are closed and an ownership model exists.

### Top 3 jobs to be done

**JTBD 1 — "I want to use my own hardware from my phone without exposing it to the internet."**
This is the primary job and the reason to exist. Evidence in §2.5: 1,100+ Ollama endpoints
already sitting exposed on the public internet, 34 reverse-proxy issues on Open WebUI, a
cottage industry of Tailscale+Ollama tutorials, and LM Studio spending an acquisition on it.
The pain is real. The catch: it is now partly served, and the emphasis belongs on **"without
exposing it"** — the unserved half — rather than on "from my phone", which LM Studio ships.

**JTBD 2 — "I want to try a new AI service without spending an evening on Docker Compose."**
This is Harbor's job, and Harbor does it well. Lem inherits it. It is table stakes, not
differentiation, and Lem should say so rather than claiming the catalog as its own innovation.

**JTBD 3 — "I want one door into my whole AI stack, that I control, and can close."**
This is the synthesis and the only defensible one: not one model, not one tunnel per service,
but a single authenticated connection to the machine — with device pairing, visible sessions,
and one-click revocation. Nobody surveyed does this. It is also, precisely, what #15/#16/#17
prove Lem does not do.

---

## 4. The differentiation thesis, and its risks

### The thesis, restated honestly

> Lem is the open-source front door to your own AI stack. One authenticated connection to
> your machine reaches every service you run — not one model, not one public URL per service.
> You can self-host every part of it, including the transport.

Three claims, each of which must be *earned*:

1. **Whole stack, not one model** — differentiates from LM Studio and every mobile client.
   Requires generic tunnel routing over the catalog (#6, then §5 Phase 4). *Currently: one
   service ID is routable.*
2. **Authenticated by default, not a public URL** — differentiates from Harbor's cloudflared
   tunnel. Requires #15, #16, #17, #7. *Currently: the opposite is true.*
3. **You can own the whole path** — differentiates from LM Studio (proprietary) and Tailscale
   (proprietary control plane). Requires the self-hosted signalling and relay to actually
   work and be documented. *Currently: `deploy/self-hosting/` exists; #19 says it is broken.*

### Risks to the thesis itself

**Risk A — Harbor closes the gap.** Harbor already has the catalog, the GUI, the QR code, and
a tunnel. Adding an identity layer to `harbor tunnel` is a feature, not a rewrite. Harbor
shipped v0.5.4 on 20 July 2026 with an integration suite covering 40 services; that is a
maintainer who ships. **If Harbor adds authenticated tunnels, Lem's entire remaining
differentiation evaporates.** This is the highest-probability strategic risk in this document
and there is no defence except being faster or being genuinely better at the security model.

**Risk B — the wedge is too narrow to pull users.** "Authenticated instead of a public URL" is
a *correctness* argument, not a *desire* argument. Users who already ran `harbor tunnel` and
did not get hacked will not feel the pain. Security-as-differentiation historically sells to
enterprises, not to homelabbers — and Lem cannot sell to enterprises with a bus factor of 1.

**Risk C — WebRTC is the wrong bet.** See §7 Risk 2. LM Studio, with money and engineers,
*partnered for transport rather than building it*. The one project doing P2P WebRTC for local
LLMs ([nekoni](https://github.com/nekonihq/nekoni)) has 13 stars. Lem is spending its scarcest
resource — a single maintainer's time — on the hardest infrastructure problem in the stack,
to save a dependency it may be better off taking.

**Risk D — the AGPL advantage is real but does not drive adoption.** Being open where LM Studio
is closed matters to a vocal minority and to nobody else at install time. It is a retention
and trust argument, not an acquisition argument. Do not lead with it.

---

## 5. Sequenced roadmap

Framed against the README's v0.1 / v1.0 structure. Every item names the issues it depends on.
**Nothing in Wave 2 or later should start before Wave 0 and Wave 1 are done.**

### Wave 0 — Stop the bleeding (blocks everything)

| Item | Issues | Why first |
|---|---|---|
| CI that runs the gates CLAUDE.md already mandates | **#20** | Five PRs merged with failing tests, 19% coverage, and a `tsc --noEmit` that checks zero files. Without this, every fix below silently regresses. |
| Green baseline: failing tests, packaging, lint, types, README paths | **#20, #21, #22** | `main` does not pass its own quality bar. |
| Correct the README's false security claims | **#17** | A false security claim is worse than a missing feature. This is a documentation change and can ship today. |

### Wave 1 — Earn the right to say "secure" (v0.1)

| Item | Issues | Why |
|---|---|---|
| Local API authentication + CSRF; bind `127.0.0.1` | **#7** | 30 unauthenticated routes that control Docker, on a server every documented launch path binds to `0.0.0.0`. |
| Session authorization on the relay | **#15** | Proven cross-account traffic read/inject. |
| Device-ownership enforcement in signalling | **#16** | Proven forced cross-account bridging. |
| Ed25519 proof-of-possession, or delete the claim | **#17** | The advertised auth mechanism has zero call sites. |
| SSRF fix in the tunnel HTTP proxy | **#8** | Turns the user's machine into an internal-network pivot. |
| Fail-closed secrets; no default JWT key; drop the credentialed CORS wildcard | **#18** | The default HS256 secret is in the public repo; anyone can forge a JWT for any `user_id`. |
| Secret file permissions | **#14** | Private key and JWT world-readable. |
| Platform module adoption; stop destructive image removal; unblock the event loop | **#10, #9, #11, #13** | Linux and WSL2 are entirely broken today. |

**Wave 1 gate: do not publish, demo, or announce anything until #15, #16, and #7 are closed.**
A public demo of remote pairing is precisely the scenario that exposes them.

### Wave 2 — Make the README true (v0.1 completion)

| Item | Issues | Notes |
|---|---|---|
| Install script that works when piped | — (`feat/install-script`) | Must not use `${BASH_SOURCE[0]}`; must download a release artifact; `https://lem.gg/install.sh` must exist. See [`quickstart-vision.md`](./quickstart-vision.md) §Phase 1. |
| Server serves the dashboard | — | No `StaticFiles` mount on `main`; a Vite dev server is currently the only way to get a UI. |
| Relay fallback that can actually trigger, within 10 s | **#12** | |
| Service Worker tunnel proxy — real remote app viewing | **#6** | The headline feature. Requires tunnel protocol v3. |
| Mobile-first remote dashboard: manifest, service worker, responsive layout | **#6** | Currently ~10 responsive classes and no PWA assets. |
| QR-code device pairing | **#15, #16** | The demo moment. Blocked on the security model. |

### Wave 3 — The differentiator (v1.0)

| Item | Issues | Notes |
|---|---|---|
| **Generic catalog routing through the tunnel** | **#6** | Any installed service with an HTTP UI reachable remotely with no per-service code. This is the actual moat — replaces `router.py:127`'s single `if client_id == "openwebui"`. |
| Visible sessions and one-click device revocation | **#15, #16** | The user-facing expression of the security model. |
| Self-hosting that works, documented | **#19** | The AGPL promise made real. |
| Harbor version currency + compatibility testing | — | Pinned at v0.3.20; upstream is v0.5.4. |

### Cut from the roadmap

The README's v1.0 list (`README.md:180-186`) should lose three items:

- **"Advanced metering and usage tracking"** — metering serves billing, and there is no
  business to bill for (§6). The byte counters in the relay are enough.
- **"Browser extension"** — solves no identified job.
- **"Mobile app (iOS/Android)"** — **downgrade to "installable PWA."** A native app is months
  of work, two app-store review processes, and a second codebase, to deliver what a service
  worker and a manifest deliver in a week. Open WebUI's own position is that
  ["Every Open WebUI instance is a Progressive Web App"](https://docs.openwebui.com/getting-started/open-webui-as-app/).
  Revisit only if the PWA ships, gets used, and hits a concrete iOS limitation.

"Device sharing (invite collaborators)" should stay, but only *after* Wave 1 — it is the
feature most directly built on the authorization model that #15/#16 prove is absent.

---

## 6. Business model

### The uncomfortable arithmetic

The thesis is that hosted signalling/relay is the natural revenue line. The economics are
worse than they look:

- **Relay bandwidth for LLM text is nearly free.** Cloudflare's Realtime TURN is
  [1,000 GB free then $0.05/GB](https://developers.cloudflare.com/realtime/turn/). Chat token
  streams are tiny. There is very little cost to mark up.
- **Signalling is a WebSocket that exchanges a few KB.** Effectively free.
- **The comparison price is zero.** Tailscale's Personal tier is
  [free forever, unlimited devices, up to 6 users](https://tailscale.com/pricing). Cloudflare
  Tunnel has been [free since 2021](https://blog.cloudflare.com/tunnel-for-everyone/).
  LM Link appears to be free. **You cannot charge for a commodity whose best-in-class
  substitutes are free.**
- **The one company that tried monetizing around this abandoned it** (§2.6). Backyard AI gave
  tethering away free, then deprecated the desktop app entirely and moved to selling hosted
  inference. Treat that as the base rate, not as someone else's execution failure.
- **Only the users with the worst networks need the relay** (§7 Risk 2) — so a
  relay-metered model charges exactly the users having the worst experience.

### Options, ranked

| Option | Revenue potential | Effort | AGPL/DCO fit | Verdict |
|---|---|---|---|---|
| **Hosted signalling + relay, free tier + paid** | Low | High (ops, abuse, geo-distribution, 24/7) | Good | **Run it free as infrastructure; do not expect revenue.** It removes the biggest onboarding blocker — nobody self-hosts a signalling server to try a product. Treat as a customer-acquisition cost, not a product. |
| **Commercial/OEM licensing** (`README.md:108`) | Medium, lumpy | Low until a deal appears | **Fragile — see below** | Keep the offer. Do not plan around it. |
| **Sponsorship / GitHub Sponsors** | **Near zero** | Very low | Perfect | Set it up (there is currently no funding link on the repo), but expect nothing. Plausible measured **$30 in donations over six months** against **$8,500+ MRR** from their hosted product over the same period ([Plausible](https://plausible.io/blog/open-source-saas)). Donations are not a funding model. |
| **Paid "team" tier** (shared devices, SSO, audit) | Medium-high | Very high | Good | The only real business here — and unreachable until #15/#16 are closed and bus factor > 1. **Not now.** |
| **Paid native mobile app** | Low | High | Poor — AGPL source-provision obligations complicate app stores | **No.** |
| **Support contracts** | Low at this scale | Medium | Good | Requires users first. |
| **Hardware bundles** | — | Extreme | — | **No.** YAGNI. |

### Why the obvious comparable does not apply

The natural model to copy is **Plausible Analytics**: AGPL, self-host free, hosted paid,
bootstrapped to **$1M ARR with 7,000+ paying subscribers** and no venture capital
([Plausible](https://plausible.io/blog/open-source-saas)). They relicensed MIT → AGPL for the
same reason Lem chose AGPL: *"we became aware of the risks associated with a permissive open
source license and of the corporations happy to take advantage of this."*

**The analogy breaks at the point that matters.** Plausible's hosted product is genuinely
valuable and genuinely expensive to run — ingestion, storage, retention, dashboards for a
billion page views a month. Customers pay to *not* operate it. Lem's hosted product would be
a byte pipe and a WebSocket, competing against a free Tailscale tier and a free Cloudflare
Tunnel. **You can sell managed complexity; you cannot sell a commodity that three larger
companies give away.**

The cautionary case runs the other way: **Sentry abandoned open source licensing entirely**,
moving BSD-3 → BSL because *"if we continue to use a fully permissive license, we face real
competitive elements that threaten the future of Sentry"*
([Sentry](https://blog.sentry.io/relicensing-sentry/)). AGPL protects Lem better than BSD
protected Sentry, but the lesson stands: licensing does not create a business, and a project
that cannot fund itself eventually changes its licence or stops.

### The licensing trap nobody has noticed

`AGPL-FAQ.md:250-262` commits Lem to **DCO, not CLA**, and says this "protects the community
from future rug pulls or license changes." `AGPL-FAQ.md:313-317` simultaneously offers
**"proprietary/dual-licensing."**

These are in tension, and the tension has a deadline. Today all 36 commits are by one author,
so he holds the entire copyright and can dual-license freely. **The moment an external
contributor's code merges under DCO, that code cannot be relicensed without their
permission** — DCO certifies origin, it does not assign or grant relicensing rights.

Every external contribution therefore erodes the commercial-licensing option. This is not an
argument for switching to a CLA — a CLA would be an honest signal that contributors' work may
be relicensed, and many contributors reasonably refuse. It is an argument for **deciding
deliberately, now, before the first outside PR lands**, and writing the decision down.
Note that ZeroTier ([GPLv3 → BSL](https://www.zerotier.com/news/on-the-gpl-to-bsl-transition/))
and Open WebUI (BSD-3 + branding restriction) both moved to restricted licences to protect a
commercial position; whether Lem wants that door open is a choice with an expiry date.

### Recommendation

1. **Accept that there is no business model yet, and stop designing one.** There are 3 stars.
   The correct revenue plan for the next six months is "none".
2. **Add GitHub Sponsors anyway** — it costs an afternoon — but budget $0 from it.
3. **Run hosted signalling and relay free, with rate limits, as onboarding infrastructure.**
   Nobody self-hosts a signalling server to try a product; this is the single biggest
   removable barrier to a first user. Budget it as marketing spend. Requires #18 and #19.
4. **Decide the CLA/DCO question and write it down before accepting external contributions.**
   This is the only decision here with a hard deadline.
5. **Do not build billing, metering, quotas, or tiers.** YAGNI.
6. **Revisit in 12 months, at 1,000+ users, with a team tier** — the only option in the table
   with real revenue potential, and it is gated on #15/#16 and on bus factor > 1.

---

## 7. Top 5 risks

### Risk 1 — Harbor makes Lem redundant *(likelihood: high · impact: existential)*

Harbor has the catalog, a desktop GUI, `harbor qr`, `harbor tunnel`, a working `curl | bash`
installer, 3,150 stars, and an active maintainer shipping hardening releases. Adding
authentication to `harbor tunnel` is one feature. If that lands, Lem's remaining
differentiation is "web-based instead of desktop" — not a product.

*The one piece of good news:* [Harbor #231](https://github.com/av/harbor/issues/231) — asking
Harbor to bind `127.0.0.1` by default — has sat **open since April 2026 with no maintainer
response, no label, and no linked PR**. Harbor's maintainer ships prolifically on breadth
(v0.5.4 added a 40-service integration suite) and has not prioritized the security posture.
A third-party security disclosure ([#232](https://github.com/av/harbor/issues/232), 78
findings) was closed within hours with no visible remediation plan. That is the window, and
it is the only one.

*But the same data raises a different alarm.* Harbor is **not** a well-resourced competitor —
it is one person, exactly like Lem:

| Harbor signal | Value | Source |
|---|---|---|
| Commits in the last 52 weeks by the owner | **980 of 998 — 98.2%** | `gh api repos/av/harbor/stats/participation` |
| Open PRs, all from outside contributors | **5**, oldest opened **2025-05-21** and still unmerged | `gh api repos/av/harbor/pulls` |
| Discord members | **~100** | Discord invite API |
| Desktop app downloads, v0.5.4, first ~10 days | **321 across all platforms** | GitHub releases API |

So the honest reading is two-sided. **Harbor is less likely to out-execute Lem than the star
count implies** — it has the same bus factor of 1 and a community that is small and whose
contributions stall for over a year. But that *raises* dependency risk correspondingly: Lem is
building on a foundation with no revenue, no co-maintainers, unreliable packaging
([#234](https://github.com/av/harbor/issues/234) install-script bug open since April;
[#253](https://github.com/av/harbor/issues/253) Windows Defender flagging v0.5.4 — its
single most-downloaded artifact), and a stale PyPI package.

**Also correct the framing elsewhere in this document:** Harbor's *catalog* is ~130–140
services by its own wiki (21 frontends / 24 backends / 92 satellites), not 89. The 89 figure
is what Lem's scanner finds in a local `~/.lem/harbor` checkout of the pinned v0.3.20 —
another sign the pin is costing real breadth.

*Mitigations:* (a) Be genuinely excellent at the identity/pairing model — the one thing Harbor
shows no sign of building. (b) Consider whether the right move is **contributing an
authenticated tunnel to Harbor** rather than maintaining a competing wrapper. (c) Keep the
Harbor pin current so Lem is a good citizen, not a stale fork. Note that (b) is a serious
option and should not be dismissed for ego reasons — it may be the highest-impact use of a
single maintainer's time.

### Risk 2 — WebRTC behind symmetric NAT and CGNAT *(likelihood: certain · impact: high)*

Published figures converge on roughly **20% of WebRTC connections requiring a TURN relay** —
[callstats measured 22%](https://webrtchacks.com/usage-stats/) across billions of minutes, and
[BlogGeek.me (Nov 2025)](https://bloggeek.me/webrtc-turn/) estimates "around 80% of all
connections can be resolved by either using the local IP address or by use of STUN."

Tailscale reports ["well north of 90%"](https://tailscale.com/blog/nat-traversal-improvements-pt-1)
direct — but that is **not comparable**, because they stack birthday-paradox port prediction,
UPnP/NAT-PMP/PCP, and IPv6 preference on top of plain ICE. **Build on WebRTC and you get the
~20% number, not the ~10% number.**

Worse for Lem specifically: **one endpoint is always a phone.** Mobile carriers are
near-universally CGNAT with symmetric mapping. Tailscale's own arithmetic for two hard NATs
gives *"a 0.01% chance of success"* after 20 seconds of probing, requiring **~28 minutes** to
reach reliability. Phone-on-cellular plus home-behind-CGNAT is the unsolvable case.
Plan for **20% relay generally and 35–50% on cellular** — the latter an estimate, since no
public dataset segments relay rate by carrier.

*Consequence:* "P2P so there's no server in the middle" is not a defensible claim. One in five
sessions has a server in the middle. The relay is not a fallback; it is core infrastructure —
and it currently cannot trigger (#12) and has no authorization (#15).

*Mitigation:* fix #12 and #15; state the relay's true security property in the UI (#17);
and seriously evaluate whether adopting an existing transport beats building one.

### Risk 3 — The security debt is the product *(likelihood: certain · impact: existential)*

#15 and #16 are not bugs adjacent to the value proposition; they are failures *of* the value
proposition. Lem's only remaining differentiation from Harbor is "authenticated remote access."
Shipping that story on top of a relay where any account can join any session, and signalling
that routes across user boundaries, is not a rough edge — it is a false claim.

The reputational asymmetry is severe: a security-differentiated project that has a public
incident does not recover. And #7 means anyone on the same café Wi-Fi can make the user's
machine pull and run arbitrary container images.

*Mitigation:* Wave 1 before anything else. No public demo until #15, #16, #7 are closed.
Correct `README.md:65-67` today — that costs nothing.

### Risk 4 — Bus factor of 1 *(likelihood: certain · impact: existential)*

36 commits, one human author, no CI, 19% server coverage, 0% relay coverage, no `.github/`.
The project cannot survive its maintainer taking three months off. It also cannot credibly
sell a team tier, a support contract, or a security-differentiated product in that state.

Compounding: Lem is a single maintainer building *five* components (local server, two web
apps, signalling, relay) plus wrapping a sixth (Harbor). That is not a scope a solo maintainer
sustains against a competitor with $88M and one against a maintainer who ships a 40-service
integration suite.

*Mitigation:* CI first (#20) so contributions are safe to accept. Then aggressively narrow
scope — every component not on the critical path to §4's thesis is a liability. Consider
whether the two web apps should be one.

### Risk 5 — Building the wrong layer *(likelihood: medium · impact: high)*

Three of Lem's five components — remote dashboard, signalling, relay — reimplement a solved
problem. Tailscale solved it, gives it away for 6 users, and LM Studio chose to *partner*
rather than rebuild. Meanwhile the layer nobody occupies — multi-service lifecycle behind an
authenticated connection — is served by the parts of Lem that already work (catalog,
lifecycle) plus a small amount of routing work (#6).

**The uncomfortable question this raises:** would Lem be further ahead as *Harbor + Tailscale +
a great web dashboard with generic service routing*, spending zero maintainer-time on NAT
traversal? That would trade the "own the whole path" claim for a working product in a fraction
of the time. It should be evaluated honestly rather than dismissed.

*Mitigation:* Before more tunnel work, timebox a spike that runs the Lem dashboard over
Tailscale and compare effort-to-working against finishing #6 + #12 + #15 + #16.

### Also worth naming

- **Harbor version drift** — pinned v0.3.20 vs upstream v0.5.4; Lem parses Harbor's compose
  files, so upstream layout changes break the catalog silently.
- **Open WebUI's licence** — changed at **v0.6.6 (5 May 2025)** to BSD-3 plus a branding
  clause, with a CLA now required for contributions. Removing or altering Open WebUI branding
  is prohibited except
  [below 50 end users in a rolling 30 days](https://raw.githubusercontent.com/open-webui/open-webui/main/LICENSE),
  by written permission, or under an enterprise licence. Code up to v0.6.5 remains plain
  BSD-3. Irrelevant while Lem embeds Open WebUI unmodified for individuals; **directly
  constraining the moment a hosted or team tier appears**, which is precisely the scenario §6
  identifies as the only real business.
- **Ollama could close this at will** — $88M raised (disclosed 9 Jul 2026), 8.9M developers,
  and no remote-to-your-own-machine story yet. Their answer is
  [Ollama Cloud](https://ollama.com/cloud) — Free / $20 Pro / $100 Max / $25-per-seat Team,
  running on *their* GPUs, which is strategically opposite. That is the opening; §2.6 explains
  why the gradient makes it likely to stay open, and why that is not entirely good news.
- **Stars are a bad proxy for users in this category.** LocalAI has 48.1k stars and a 3.2k
  Discord; Pinokio has 7.8k stars and a **41.7k** Discord; Harbor has 3.1k stars and ~100.
  Do not calibrate ambition — or threat — from star counts.

---

## 8. Verdict on the five thesis points

| # | Thesis | Verdict | Strongest evidence |
|---|---|---|---|
| 1 | Install experience is the top adoption blocker | **Refined** | Real, and Lem is worse than its own dependency: `https://lem.gg/install` returns **404**, and under a pipe `${BASH_SOURCE[0]}` evaluates to `main`, so the script silently treats the user's CWD as the repo root and exits 1 telling them to `git clone`. But Harbor already ships a working piped installer — so fixing this achieves **parity, not advantage**. It is the entry fee, not the moat, and it is not the *top* priority: the security debt is, because that is a liability rather than a missed opportunity. |
| 2 | The moat is the intersection of management and remote access | **Refuted as stated; refined** | [LM Studio shipped LM Link on 4 Jun 2026](https://lmstudio.ai/blog/locally-lm-link) — runtime + iPhone app + Tailscale transport — and **Harbor already has `harbor tunnel`, `harbor qr`, and a desktop GUI**. Pinokio v8 added a phone-accessible "Home Server" on 8 Jul 2026. Both flanks of the intersection are occupied, and a third entrant arrived last month. The genuinely unoccupied position is narrower: **authenticated, identity-bound access to a multi-service catalog**. Harbor's tunnel warns *"⚠️ Ensure to configure authentication for the service"*, Pinokio's server is LAN-only, and LM Link reaches only LM Studio's own models. That three-way gap is the whole opportunity. |
| 3 | The killer demo is mobile; go mobile-first PWA | **Confirmed as direction; refuted as differentiator** | LM Studio already ships the demo, free. Open WebUI is already a PWA. So do it — `web/remote/` has ~10 responsive utility classes, no manifest, and no service worker, which is indefensible for a product whose headline is phone access — but do not market it as the wedge, because it is table stakes as of June 2026. |
| 4 | The 89-service catalog is an underexploited "app store" | **Confirmed as underexploited; refuted as Lem's asset** | It is **Harbor's** catalog, and it is bigger than 89 — Harbor's wiki lists ~137 services; 89 is merely what Lem's scanner finds in the pinned v0.3.20 checkout, alongside **252 cross-service integration files** (verified locally). Harbor's own desktop App already presents it. Lem's exploitable edge is not the catalog but **generic routing over it**: `server/app/tunnel/router.py:127` resolves exactly one service ID and returns `None` for every other. Fix that — and update the pin — and Lem has something Harbor does not. |
| 5 | Hosted signalling/relay is the natural revenue line | **Refuted on economics; keep as infrastructure** | Cloudflare TURN is [$0.05/GB after 1 TB free](https://developers.cloudflare.com/realtime/turn/) and LLM text is tiny, so there is almost no cost to mark up; meanwhile [Tailscale is free forever for 6 users](https://tailscale.com/pricing) and Cloudflare Tunnel has been free since 2021. Worse, relay users are precisely those with the worst networks. Decisively: **Backyard AI gave exactly this away free in Feb 2024, then deprecated the whole desktop product and moved to selling hosted inference at $12–35/mo** (§2.6). Run the relay free as onboarding infrastructure. The plausible business is a **team tier**, blocked on #15/#16 and on bus factor. |

---

## 9. What NOT to pursue

YAGNI, applied to strategy. Each of these should be actively declined:

1. **A native mobile app.** Two app stores, two codebases, AGPL source-provision friction, to
   deliver what a manifest and a service worker deliver in a week. Cut from v1.0.
2. **A browser extension** (`README.md:185`). Solves no job on the list.
3. **Metering, billing, quotas, or tiers.** There are 3 stars. The byte counters already in
   `session_manager.py` are more than enough. Cut "advanced metering" from v1.0.
4. **Multi-runner support** (`README.md:182`). Nobody surveyed asks for two Ollama instances
   on one machine.
5. **Beating Tailscale at NAT traversal.** They have years of engineering and production
   telemetry; LM Studio partnered rather than compete. Get WebRTC working adequately, make the
   relay honest, and stop.
6. **Device sharing / collaborators before Wave 1.** Building a sharing feature on an
   authorization layer that #15 and #16 prove is absent would multiply the blast radius.
7. **Enterprise or team sales.** Not with a bus factor of 1, 19% coverage, and no CI.
8. **A second frontend framework, a desktop app, or a rewrite.** The scope is already too
   wide for one maintainer.

---

## 10. The one move to make first

**Close #15, #16, and #7. Before the installer, before the PWA, before #6.**

Not because security is virtuous, but because the competitive analysis leaves exactly one
defensible claim — *authenticated, identity-bound access to a whole AI stack* — and Lem
currently ships the unauthenticated version of it. Every other item on the roadmap is either
parity with Harbor (installer, catalog, QR) or parity with LM Studio (phone access). This is
the only work that produces something no surveyed competitor has.

It is also the cheapest possible moment to do it: 3 stars, 0 forks, no users, no deployment,
no disclosure obligation. That window closes the first time someone actually installs this.

Second move, same week and nearly free: **correct `README.md:65-67`.** The claims of
end-to-end encryption and ed25519 device authentication are false today (#17), and a project
whose differentiation is trustworthiness cannot afford a README that is not.

Third, when there is eventually something to say publicly, **lead with survivability, not
features.** The Backyard AI precedent (§2.6) is the sharpest message this project has: the
last product that let you reach your own GPU from your phone was proprietary, was free, and
was switched off — and its users had no recourse. Lem's answer to "what happens when you lose
interest?" is a licence and a self-hostable stack. That is a claim no competitor in §2.2 can
make, it costs nothing to be true, and unlike "we are more secure" it is a reason to *choose*
rather than merely a reason not to worry.
