<!--
Thanks for contributing to Lem! Fill in what applies and delete what doesn't.
Everything below mirrors the pre-commit checklist in CLAUDE.md.
-->

## Summary

<!-- What does this change do, and why? One or two sentences is plenty. -->

## Related issues

<!-- e.g. "Closes #123", "Part of #456". Write "None" if this stands alone. -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (existing behaviour changes in an incompatible way)
- [ ] Refactor / internal cleanup (no user-visible change)
- [ ] Documentation
- [ ] Build, CI, or tooling

## Components touched

- [ ] `server/` — local FastAPI server
- [ ] `cloud/signaling/` — WebRTC signaling
- [ ] `cloud/relay/` — WebSocket relay
- [ ] `web/local/` — local dashboard
- [ ] `web/remote/` — remote dashboard
- [ ] `deploy/` — deployment / infrastructure
- [ ] Docs only

## How was this tested?

<!--
Describe what you actually ran, and on what. Include the platform, since Lem
supports macOS, Linux, and Windows (WSL2). Screenshots or a short clip are
very welcome for UI changes.
-->

- Platform(s):
- Steps:

---

## Pre-commit checklist

From [CLAUDE.md](../blob/main/CLAUDE.md). CI enforces all of these, so running
them locally first saves you a round trip.

- [ ] **License headers** — every new `.py` / `.ts` / `.tsx` / `.js` / `.jsx`
      file starts with the SPDX header (`./scripts/check-license-headers.sh`)
- [ ] **Types** — all functions have type annotations
- [ ] **Tests** — new code has tests (target >80% coverage)
- [ ] **Linting** — `ruff check` / `eslint` passes
- [ ] **Formatting** — `ruff format` / `prettier` applied
- [ ] **Type check** — `mypy` / `tsc --noEmit` passes
- [ ] **No `Any` / `any`** unless there is a comment explaining why

<details>
<summary>Commands (click to expand)</summary>

```bash
# Python — run in server/, cloud/signaling/, or cloud/relay/
uv sync --locked --all-extras
uv run ruff format app/
uv run ruff check app/ tests/
uv run mypy app/
uv run pytest --cov=app --cov-report=term-missing

# TypeScript — run in web/local/ or web/remote/
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec eslint .
pnpm exec prettier --write .
pnpm run build
pnpm exec vitest run   # web/remote only

# Repo-wide
./scripts/check-license-headers.sh
```

</details>

## Contribution requirements

- [ ] All commits are signed off for the [DCO](https://developercertificate.org/)
      (`git commit -s`) — see [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md)
- [ ] I agree my contribution is licensed under **AGPL-3.0-or-later**
