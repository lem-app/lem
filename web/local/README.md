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

Two things to understand before you do:

- **`dev:lan` in front of a loopback-bound server bypasses the server's own
  protection.** The proxy hop is made by Vite from `127.0.0.1`, so the API sees
  a loopback client, correctly reports "loopback only", and requires no bearer
  token - while the dashboard is reachable from the whole LAN. The API cannot
  see a hop it is not part of. This is the same limitation as putting any
  reverse proxy in front of it.
- **Against a non-loopback server bind, the dashboard just 401s.** It sends no
  bearer token. See "Using the dashboard over the LAN" in
  [`server/README.md`](../../server/README.md), and
  [#48](https://github.com/lem-app/lem/issues/48) for the credential-delivery
  design that would make LAN dashboards actually work.

## Configuration

| Variable          | Default                 | Purpose                                |
| ----------------- | ----------------------- | -------------------------------------- |
| `VITE_API_URL`    | `""` (relative URLs)    | Backend base URL for production builds |
| `VITE_API_TARGET` | `http://127.0.0.1:5142` | Dev-server proxy target for `/v1/*`    |

## Layout

```
src/
├── api/          # Typed client for the local Lem API
├── components/   # Dashboard UI (shadcn/ui + Tailwind)
├── hooks/        # React Query hooks
└── lib/          # Shared helpers
```
