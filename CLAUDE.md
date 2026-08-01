# Claude Coding Standards for Lem

**Purpose**: Essential coding standards for AI assistants and developers. Keep this concise for context efficiency.

**Last updated**: 2025-11-15 (PT)

---

## 🛠️ Tooling (Non-negotiable)

### Python: Use `uv` (NOT pip)

```bash
# ✅ Correct
uv sync
uv add fastapi
uv run pytest
uv run uvicorn app.main:app

# ❌ Never use
pip install fastapi
python -m pytest
```

**Install**: `curl -LsSf https://astral.sh/uv/install.sh | sh`

---

### Node.js: Use `pnpm` (NOT npm)

```bash
# ✅ Correct
pnpm install
pnpm add react
pnpm run dev

# ❌ Never use
npm install
yarn add react
```

**Install**: `npm install -g pnpm` or `brew install pnpm`

---

## 📜 License Headers (Required for All New Files)

**IMPORTANT**: Every new source file MUST include an SPDX license header at the top.

### Python Files (.py)

```python
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2025 Lem
#
# This file is part of Lem.
#
# Lem is free software: you can redistribute it and/or modify it under
# the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Lem is distributed in the hope that it will be useful, but WITHOUT
# ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
# or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General
# Public License for more details.

"""
Module docstring goes here.
"""
import os
```

**Note**: If file has a shebang (`#!/usr/bin/env python3`), place it first, then the license header.

---

### TypeScript/JavaScript Files (.ts, .tsx, .js, .jsx)

```typescript
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025 Lem
//
// This file is part of Lem.
//
// Lem is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Lem is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General
// Public License for more details.

import React from "react";
```

---

### Configuration Files (YAML, JSON, TOML, etc.)

Configuration files generally do NOT need license headers (they're not code), but if you're creating a significant/complex config:

```yaml
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2025 Lem
```

---

## 🔒 Type Safety (Strict Mode Always)

### Python: mypy strict + full type hints

```python
# ✅ Correct
async def start_runner(runner_id: str, timeout: int = 300) -> dict[str, str]:
    result: subprocess.CompletedProcess[str] = await run_command(...)
    return {"status": "ok"}

# ❌ Wrong - no types
async def start_runner(runner_id, timeout=300):
    result = await run_command(...)
    return {"status": "ok"}
```

**Config**: Add to `pyproject.toml`:
```toml
[tool.mypy]
strict = true
```

**Check**: `uv run mypy server/`

---

### TypeScript: strict mode + no implicit any

```typescript
// ✅ Correct
interface RunnerStatus {
  id: string;
  state: 'stopped' | 'running';
}

async function getRunner(id: string): Promise<RunnerStatus> {
  const res = await fetch(`/v1/runners/${id}`);
  return await res.json() as RunnerStatus;
}

// ❌ Wrong - no types
async function getRunner(id) {
  const res = await fetch(`/v1/runners/${id}`);
  return await res.json();
}
```

**Config**: `tsconfig.json` → `"strict": true`

**Check**: `pnpm exec tsc -b --noEmit`

> ⚠️ Both web apps use a **solution-style** `tsconfig.json` (`"files": []` plus
> `references`). Plain `tsc --noEmit` type-checks **zero files** there and always
> exits 0. Always use `tsc -b` (or `pnpm run type-check`).

---

## 📝 Formatting & Linting

### Python: ruff (replaces Black, isort, flake8)

```bash
uv run ruff format server/        # Format
uv run ruff check server/         # Lint
uv run ruff check --fix server/   # Auto-fix
```

**Config**: `pyproject.toml` → `[tool.ruff]` (see docs)

---

### TypeScript: Prettier + ESLint

```bash
pnpm prettier --write .
pnpm eslint .
```

---

## 🧪 Testing

### Python: pytest (with coverage)

```bash
uv run pytest
uv run pytest --cov=app --cov-report=term-missing
```

**Target**: >80% coverage for v0.1

---

### TypeScript: Vitest

```bash
pnpm vitest
pnpm vitest --coverage
```

---

## 🚫 Critical Anti-Patterns

### Python

```python
# ❌ Never use Any without comment
from typing import Any
def process(data: Any) -> Any: ...

# ❌ Never ignore type errors
result = some_function()  # type: ignore

# ❌ Never use bare except
try:
    do_something()
except:  # Catches KeyboardInterrupt, SystemExit!
    pass

# ✅ Correct
from typing import TypeVar
T = TypeVar('T')
def process(data: T) -> T: ...

# ✅ Correct - handle specific errors
try:
    do_something()
except SpecificError as e:
    logger.error(f"Failed: {e}")
    raise
```

---

### TypeScript

```typescript
// ❌ Never use any
function process(data: any): any { ... }

// ❌ Never use non-null assertion without good reason
const value = maybeNull!.property;

// ✅ Correct - use generics
function process<T>(data: T): T { ... }

// ✅ Correct - check null
if (maybeNull === null) throw new Error('Null value');
const value = maybeNull.property;
```

---

## 📂 File Organization

### Python

```
server/app/
├── main.py              # FastAPI app
├── config.py            # pydantic-settings
├── api/v1/              # Endpoints
│   ├── health.py
│   ├── runners.py
│   └── clients.py
├── drivers/             # Harbor wrappers
│   └── harbor_wrapper.py
└── models/              # Pydantic models
    └── runner.py
```

**Import order** (enforced by ruff):
1. Standard library
2. Third-party
3. Local

---

### TypeScript/React

```
web/local/src/
├── components/
│   ├── RunnerCard.tsx
│   └── RunnerCard.test.tsx
├── hooks/
│   └── useRunners.ts
├── api/
│   ├── client.ts
│   └── types.ts
└── lib/
    └── utils.ts
```

---

## 🎨 UI & Styling

### React: Tailwind CSS + shadcn/ui (NOT vanilla CSS)

```typescript
// ✅ Correct - use Tailwind utilities
<div className="flex items-center gap-4 rounded-lg border p-4">
  <Button variant="outline">Click me</Button>
</div>

// ✅ Correct - use shadcn components
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

// ❌ Wrong - vanilla CSS
<div style={{ display: 'flex', gap: '16px' }}>
  <button className="my-custom-button">Click me</button>
</div>

// ❌ Wrong - custom CSS files
import './MyComponent.css'
```

**Setup**:
```bash
pnpm add -D tailwindcss postcss autoprefixer
pnpm dlx shadcn-ui@latest init
pnpm dlx shadcn-ui@latest add button card
```

---

## ✅ Pre-commit Checklist

Before submitting code:

- [ ] **License headers**: All new files have SPDX headers (see License Headers section)
- [ ] Types: All functions have type annotations
- [ ] Tests: New code has tests (>80% coverage)
- [ ] Linting: `ruff check` / `eslint` passes
- [ ] Formatting: `ruff format` / `prettier` applied
- [ ] Type check: `mypy` / `tsc --noEmit` passes
- [ ] No `Any`/`any` (unless commented why)

---

## 📚 Quick Commands Reference

```bash
# Python (server/)
uv sync                          # Install deps
uv add fastapi                   # Add dependency
uv run uvicorn app.main:app      # Run server
uv run pytest                    # Run tests
uv run mypy server/              # Type check
uv run ruff format server/       # Format
uv run ruff check server/        # Lint

# TypeScript (web/local/ or web/remote/)
pnpm install                     # Install deps
pnpm add react                   # Add dependency
pnpm run dev                     # Dev server, loopback (local: 5174, remote: 5173)
pnpm run dev:lan                 # Dev server bound to the LAN (opt-in)
pnpm test                        # Run tests once (vitest run)
pnpm run test:watch              # Run tests in watch mode
pnpm exec tsc -b --noEmit        # Type check (NOT `tsc --noEmit` - see above)
pnpm prettier --write .          # Format
pnpm eslint .                    # Lint
```

---

## 🌍 Cross-Platform Standards

Lem runs on **macOS, Linux, and Windows** (via WSL2). Always write platform-agnostic code.

### Path Handling

```python
# ✅ Correct - cross-platform
from pathlib import Path

LEM_HOME = Path.home() / ".lem"
HARBOR_SCRIPT = LEM_HOME / "harbor" / "harbor.sh"

# ❌ Wrong - hardcoded Unix paths
LEM_HOME = "/home/user/.lem"
HARBOR_SCRIPT = f"{LEM_HOME}/harbor/harbor.sh"
```

### Platform Detection

```python
# ✅ Correct - use centralized module
from app.config.platform import PLATFORM, DOCKER_SOCKET

if PLATFORM == "macos":
    # macOS-specific code
    pass
elif PLATFORM == "linux":
    # Linux-specific code
    pass

# ❌ Wrong - scattered platform checks
import platform
if platform.system() == "Darwin":
    pass
```

### Docker Socket

```python
# ✅ Correct - auto-detected
from app.config.platform import DOCKER_HOST

env = {"DOCKER_HOST": DOCKER_HOST}  # Works on all platforms

# ❌ Wrong - hardcoded
env = {"DOCKER_HOST": "unix:///var/run/docker.sock"}  # Linux only
```

**See:** [`docs/platform.md`](./docs/platform.md) for detailed cross-platform implementation guide.

---

## 🔗 Related Docs

- **Implementation guide**: [`../docs/implementation_plan.md`](./docs/implementation_plan.md)
- **API contracts**: [`../docs/api.md`](./docs/api.md)
- **Architecture**: [`../docs/architecture.md`](./docs/architecture.md)
- **Platform guide**: [`../docs/platform.md`](./docs/platform.md)
- **Testing**: [`../docs/testing_checklist.md`](./docs/testing_checklist.md)

---

and dont forget, YAGNI

**End of Coding Standards** — Keep it short, keep it scanned.
