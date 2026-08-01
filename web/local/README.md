# Lem Local Dashboard

The dashboard served on the machine running Lem. It talks to the local Lem API
(`http://127.0.0.1:5142` by default) to install, start and stop Harbor services,
pull models, and manage remote access.

## Development

```bash
# Install dependencies
pnpm install

# Run dev server (http://127.0.0.1:5174)
pnpm dev

# Same, but reachable from the LAN - see the warning below
pnpm dev:lan

# Build for production
pnpm build

# Run tests (single pass) / watch mode / with coverage
pnpm test
pnpm test:watch
pnpm test:coverage

# Type check (tsc -b: the solution-style tsconfig means plain `tsc --noEmit`
# checks nothing at all)
pnpm type-check

# Lint / format
pnpm lint
pnpm format
```

### A note on `dev:lan`

The dev server proxies `/v1/*` straight to the local Lem API, which can start
and stop Docker containers. `pnpm dev` therefore binds to loopback only.
`pnpm dev:lan` binds every interface - use it when you deliberately want to
reach the dashboard from another device on a network you trust, and not
otherwise.

**`dev:lan` in front of a loopback-bound server bypasses the server's own
protection unless you tell the server about it.** The proxy hop is made by Vite
from `127.0.0.1`, so the API sees a loopback client, correctly reports "loopback
only", and requires no bearer token - while the dashboard is reachable from the
whole LAN. The API cannot see a hop it is not part of.

Start the server with `LEM_REQUIRE_TOKEN=true` whenever you use `dev:lan`:

```bash
LEM_REQUIRE_TOKEN=true uv run lem-serve
LEM_ALLOWED_ORIGINS=http://192.168.1.10:5174 uv run lem-serve   # and this, for the origin
```

The dashboard then prompts for a credential (see below) instead of silently
operating an unauthenticated Docker control plane.

## Authentication

The dashboard holds **no compiled-in credential**. A `VITE_*` variable cannot
carry one: Vite inlines those as plaintext string literals into
`dist/assets/*.js`, so the token would ship to every browser that loads the
page. `scripts/check-bundle-secrets.sh` builds this app in CI and fails if any
credential-shaped build variable reaches `dist/`.

Instead the flow is 401-driven. It is not a login page and not a route - Lem's
local API has exactly one principal, the machine's operator:

1. Any `/v1/*` request comes back 401.
2. A dialog asks for the contents of `~/.lem/api_token` on the machine running
   Lem. The server logs that path on startup; the file is mode 0600.
3. What you paste is traded at `POST /v1/auth/session` for a session token that
   expires after 12 hours, and is then dropped. Only the session token is kept.
4. The request that failed is retried, so you land where you were. Concurrent
   401s raise one prompt and one exchange between them.

Storage is `sessionStorage` by default - tab-scoped, gone when the tab closes.
"Remember on this device" (off by default, and re-cleared on every prompt)
promotes it to `localStorage`, which survives restarts and is correspondingly
readable by any later XSS on this origin. Sessions also die with the server
process, which keeps them in memory only; you will be re-prompted after a server
restart.

**Sign out** appears in the header whenever a credential is held. It is the off
switch for "remember on this device": it calls `DELETE /v1/auth/session` and
clears **both** storages, so a token cannot be stranded in `localStorage` by
someone who ticked the box once on a borrowed machine. The local copy is dropped
before the server is contacted and regardless of whether that call succeeds - a
sign-out that leaves the credential behind because the network was down would be
the worst outcome.

Nothing about this affects the common case: on a loopback bind the API requires
no credential and the prompt never appears.

## Configuration

| Variable          | Default                 | Purpose                                |
| ----------------- | ----------------------- | -------------------------------------- |
| `VITE_API_URL`    | `""` (relative URLs)    | Backend base URL for production builds |
| `VITE_API_TARGET` | `http://127.0.0.1:5142` | Dev-server proxy target for `/v1/*`    |

No `VITE_*` variable holds a credential, and none ever should.

## Layout

```
src/
├── api/          # Typed client for the local Lem API
├── components/   # Dashboard UI (shadcn/ui + Tailwind)
├── hooks/        # React Query hooks
└── lib/          # Shared helpers
```
