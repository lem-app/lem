# Lem Remote Access Web Client

Browser-based WebRTC client for remote access to local Lem servers.

## Features

- Email/password authentication
- WebRTC peer-to-peer connection via signaling server
- Automatic WebSocket-relay fallback when P2P cannot be established
- Real-time connection status monitoring
- DataChannel for HTTP and WebSocket proxying

## Development

```bash
# Install dependencies
pnpm install

# Run dev server (http://127.0.0.1:5173)
pnpm dev

# Same, but reachable from the LAN
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

## Configuration

All endpoints are validated at startup by `src/lib/env.ts`. A production build
with a missing or mixed-content endpoint renders a configuration error instead of
silently dialling `localhost`.

| Variable             | Required in prod | Purpose                                                |
| -------------------- | ---------------- | ------------------------------------------------------ |
| `VITE_SIGNAL_URL`    | yes              | Signaling WebSocket, e.g. `wss://signal.lem.gg/signal` |
| `VITE_API_BASE_URL`  | yes              | Signaling HTTP API, e.g. `https://signal.lem.gg`       |
| `VITE_RELAY_URL`     | yes              | Relay WebSocket base, e.g. `wss://relay.lem.gg`        |
| `VITE_LOCAL_API_URL` | no               | Local Lem API as seen from the tunnel's far side       |
| `VITE_ICE_SERVERS`   | no               | Comma-separated STUN/TURN URLs (see below)             |

Copy `.env.example` for development or `.env.production.example` for a
deployment.

### ICE servers are opt-in

There is no built-in STUN server. Lem is privacy-first and will not hand a
user's IP address to a third party without being asked. The signaling server
supplies ICE servers in its `connected` message; `VITE_ICE_SERVERS` is there for
self-hosted deployments that want to point at their own. With none configured,
WebRTC still works over host candidates on the same LAN and otherwise falls back
to the relay.

## Architecture

This client connects to:

- **Signaling Server** (`VITE_SIGNAL_URL`) for WebRTC signaling
- **Auth API** (`VITE_API_BASE_URL`) for JWT authentication
- **Relay** (`VITE_RELAY_URL`) when the peer-to-peer leg fails

The WebRTC connection is established peer-to-peer with a local Lem server
running the TunnelAgent.
