# Lem Remote Access Web Client

Browser-based WebRTC client for remote access to local Lem servers.

## Features

- Email/password authentication
- WebRTC peer-to-peer connection via signaling server
- Real-time connection status monitoring
- DataChannel for HTTP request proxying

## Development

```bash
# Install dependencies
pnpm install

# Run dev server (http://localhost:5173)
pnpm dev

# Build for production
pnpm build

# Run tests
pnpm test

# Type check
pnpm type-check

# Lint
pnpm lint

# Format
pnpm format
```

## Architecture

This client connects to:

- **Signaling Server**: `ws://localhost:8000/signal` (WebRTC signaling)
- **Auth API**: `http://localhost:8000/auth` (JWT authentication)

The WebRTC connection is established peer-to-peer with a local Lem server running the TunnelAgent.
