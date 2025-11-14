# WebRTC Tunnel Agent

This module implements the local server's WebRTC client for establishing peer-to-peer DataChannels for remote access.

## Features

- **WebSocket Signaling**: Connects to signaling server for SDP/ICE exchange
- **WebRTC P2P**: Establishes RTCPeerConnection with STUN/TURN support
- **DataChannel**: Creates DataChannel for HTTP request proxying
- **Connection State Management**: Tracks connection lifecycle with callbacks
- **Reconnection Logic**: Automatic reconnection with exponential backoff
- **Full Type Safety**: Comprehensive type hints with mypy strict mode

## Usage

```python
from app.tunnel.webrtc_client import TunnelAgent

# Create agent
agent = TunnelAgent()

# Set up callbacks
def on_state_change(state):
    print(f"State: {state}")

agent.on_state_change = on_state_change

# Connect to signaling server
await agent.connect(
    signal_url="ws://localhost:8000/signal",
    device_id="local-device-1",
    token="<JWT_from_signaling_server>"
)

# Create DataChannel
channel = await agent.create_data_channel("http-proxy")

# Create offer (for offering peer)
offer = await agent.create_offer()

# Wait for connection
while not agent.is_connected():
    await asyncio.sleep(1)

# Send data
await agent.send_data("Hello!")

# Cleanup
await agent.disconnect()
```

## Acceptance Criteria

✅ **Phase 2.3 Complete**

```python
from app.tunnel.webrtc_client import TunnelAgent

agent = TunnelAgent()
await agent.connect(
    signal_url="ws://localhost:8000/signal",
    device_id="local-device-1",
    token="<JWT_from_signaling_server>"
)
# → WebRTC connection established
# → DataChannel state: "open"
```

## Architecture

The TunnelAgent implements the following WebRTC flow:

1. **Connect to Signaling Server** - WebSocket connection for SDP/ICE exchange
2. **Create RTCPeerConnection** - With STUN/TURN ICE servers
3. **Create DataChannel** - For HTTP proxying (offering peer)
4. **Exchange SDP** - Offer/answer for session negotiation
5. **Gather ICE Candidates** - For NAT traversal
6. **Establish Connection** - P2P DataChannel connection
7. **Monitor State** - Connection state callbacks and reconnection

## Testing

Run tests with:

```bash
uv run pytest tests/tunnel/test_webrtc_client.py -v
```

All 18 tests passing:
- Initialization
- Connection lifecycle
- DataChannel setup
- SDP offer/answer exchange
- ICE candidate handling
- State management
- Error handling

## Type Safety

Fully type-checked with mypy strict mode:

```bash
uv run mypy app/tunnel/webrtc_client.py
# Success: no issues found in 1 source file
```

## References

- **Signaling Server**: `cloud/signaling/` (Phase 2.1)
- **Architecture**: `docs/architecture.md` §3.3 (sequence flows)
- **Implementation Plan**: `docs/implementation_plan.md` §2.3
