# Lem Local Server

Local server for Lem v0.1 - AI launcher with remote access.

## Quick Start

```bash
# Install dependencies
uv sync

# Run server (development)
uv run uvicorn app.main:app --host 0.0.0.0 --port 5142 --reload

# Test health endpoint
curl http://localhost:5142/v1/health
```

## Development

### Type Checking

```bash
uv run mypy app/
```

### Linting & Formatting

```bash
# Format code
uv run ruff format app/

# Lint code
uv run ruff check app/

# Auto-fix lint issues
uv run ruff check --fix app/
```

### Testing

```bash
# Run tests
uv run pytest

# Run tests with coverage
uv run pytest --cov=app --cov-report=term-missing
```

## API Documentation

Once the server is running, visit:
- **Interactive docs**: http://localhost:5142/docs
- **ReDoc**: http://localhost:5142/redoc

## Project Structure

```
server/
├── app/
│   ├── main.py           # FastAPI app entry point
│   ├── api/v1/           # API endpoints
│   ├── drivers/          # Harbor CLI wrappers
│   │   ├── runners/      # Runner drivers (Ollama, etc.)
│   │   └── clients/      # Client drivers (Open WebUI, etc.)
│   └── tunnel/           # WebRTC + relay clients
├── pyproject.toml        # Project config & dependencies
└── README.md             # This file
```

## Current Status (v0.1 Day 1)

✅ FastAPI skeleton created
✅ Health endpoint working (`GET /v1/health`)
✅ Server runs on port 5142
⏳ Harbor CLI integration (next)
⏳ Ollama driver (next)
⏳ Open WebUI driver (next)

## References

- [Implementation Plan](../docs/implementation_plan.md)
- [API Specification](../docs/api.md)
- [Harbor Integration Guide](../docs/harbor_integration.md)
- [Coding Standards](../CLAUDE.md)
