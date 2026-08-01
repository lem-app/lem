#!/usr/bin/env bash
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
#
# ---------------------------------------------------------------------------
# Verify every tracked source file carries the SPDX license header that
# CLAUDE.md mandates ("License Headers (Required for All New Files)").
#
# Usage:
#   ./scripts/check-license-headers.sh
#
# Exits 0 when every checked file has the header, 1 otherwise. In GitHub
# Actions it also emits ::error annotations so offending files are flagged
# inline on the pull request diff.
# ---------------------------------------------------------------------------

set -euo pipefail

# Run from the repository root regardless of where the script was invoked.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

readonly SPDX_TAG='SPDX-License-Identifier: AGPL-3.0-or-later'

# How many leading lines to scan. Generous enough to allow a shebang, a
# coding declaration, or a short banner comment above the SPDX line.
readonly HEADER_SCAN_LINES=20

# Source extensions that require a header, per CLAUDE.md.
readonly -a SOURCE_GLOBS=('*.py' '*.ts' '*.tsx' '*.js' '*.jsx')

# --- Exclusions: generated / vendored trees --------------------------------
# `git ls-files` already skips anything gitignored (node_modules/, dist/,
# .venv/ are all gitignored here), so these are belt-and-braces: they keep the
# script honest if it is ever pointed at a dirty tree or those paths get
# accidentally tracked.
readonly -a EXCLUDE_DIRS=(
  'node_modules'
  'dist'
  'build'
  '.venv'
  '__pycache__'
)

# --- Exclusions: build/tooling configuration -------------------------------
# CLAUDE.md, "Configuration Files": config files generally do NOT need license
# headers. These are tool configuration, not product source, and none of them
# carry a header on main today:
#   web/{local,remote}/eslint.config.js
#   web/{local,remote}/postcss.config.js
#   web/{local,remote}/tailwind.config.js
#   web/{local,remote}/vite.config.ts
#   web/remote/vitest.config.ts
# This is a category exemption, not an allowlist of mistakes.
readonly -a EXCLUDE_FILE_GLOBS=(
  '*.config.js'
  '*.config.cjs'
  '*.config.mjs'
  '*.config.ts'
  '*.config.mts'
)

# --- Allowlist: pre-existing violations ------------------------------------
# Real source files that are missing the header on main. This PR only adds CI
# and is not allowed to touch the source trees, so these are grandfathered in
# to keep the gate green on main. NEW files without a header still fail.
#
# Every entry here is a bug to be fixed, not a permanent exemption. Remove the
# line as soon as the header is added.
#
#   web/local/src/components/ui/progress.tsx
#     shadcn/ui-generated component committed without the SPDX header. The
#     identical file at web/remote/src/components/ui/progress.tsx DOES have
#     one, so this is an oversight rather than an intentional exemption.
#     Fix: prepend the standard 14-line TypeScript header, then delete this
#     entry. See https://github.com/lem-app/lem/blob/main/CLAUDE.md
#
#     OWNED ELSEWHERE: the `fix/frontend-correctness` branch is adding this
#     header as part of its own change. When that lands, this entry becomes
#     stale and MUST be deleted -- the script will print a
#     "notice: ... remove it from ALLOWLIST" line on stderr (exit 0, never
#     blocking) on every run until someone does.
readonly -a ALLOWLIST=(
  'web/local/src/components/ui/progress.tsx'
)

# Emit a GitHub Actions annotation when running in CI, otherwise stay quiet.
annotate_error() {
  local file="$1"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::error file=%s,line=1,title=Missing license header::%s\n' \
      "$file" "$file is missing '$SPDX_TAG'"
  fi
}

# True when $1 lives under any excluded directory, at any depth.
is_excluded_dir() {
  local path="$1" dir
  for dir in "${EXCLUDE_DIRS[@]}"; do
    case "$path" in
      "$dir"/* | */"$dir"/*) return 0 ;;
    esac
  done
  return 1
}

# True when $1 matches an excluded (config-file) glob.
is_excluded_file() {
  local path="$1" glob
  for glob in "${EXCLUDE_FILE_GLOBS[@]}"; do
    # shellcheck disable=SC2254  # $glob is intentionally a pattern here.
    case "$path" in
      $glob) return 0 ;;
    esac
  done
  return 1
}

# True when $1 is grandfathered in.
is_allowlisted() {
  local path="$1" entry
  for entry in "${ALLOWLIST[@]}"; do
    [[ "$path" == "$entry" ]] && return 0
  done
  return 1
}

# True when $1 carries the SPDX tag in its first $HEADER_SCAN_LINES lines.
has_header() {
  head -n "$HEADER_SCAN_LINES" -- "$1" 2>/dev/null | grep -qF -- "$SPDX_TAG"
}

main() {
  local checked=0 skipped=0 file
  local -a missing=()

  while IFS= read -r -d '' file; do
    if is_excluded_dir "$file" || is_excluded_file "$file"; then
      skipped=$((skipped + 1))
      continue
    fi

    if is_allowlisted "$file"; then
      skipped=$((skipped + 1))
      # Keep the allowlist from rotting: tell maintainers when an entry is no
      # longer needed. A warning, not a failure, so a fix PR is never blocked.
      if has_header "$file"; then
        printf 'notice: %s now has a license header - remove it from ALLOWLIST in %s\n' \
          "$file" "${BASH_SOURCE[0]}" >&2
      fi
      continue
    fi

    checked=$((checked + 1))
    if ! has_header "$file"; then
      missing+=("$file")
    fi
  done < <(git ls-files -z -- "${SOURCE_GLOBS[@]}")

  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '\n%s\n' "Missing '$SPDX_TAG' in ${#missing[@]} file(s):"
    for file in "${missing[@]}"; do
      printf '  %s\n' "$file"
      annotate_error "$file"
    done
    cat <<EOF

Every source file needs the SPDX header from CLAUDE.md. Copy the block for
your language ("License Headers" section) to the top of each file above; for
scripts with a shebang, the shebang stays on line 1 and the header follows.

If a file genuinely does not need one, add it to EXCLUDE_FILE_GLOBS or
ALLOWLIST in scripts/check-license-headers.sh with a comment explaining why.
EOF
    return 1
  fi

  printf 'License headers OK: %d file(s) checked, %d skipped (config/allowlisted).\n' \
    "$checked" "$skipped"
  return 0
}

main "$@"
