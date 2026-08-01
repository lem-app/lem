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
# Prove the web bundles carry no credential.
#
# Background (issue #48): an earlier attempt at LAN dashboard auth shipped a
# build-time `VITE_LEM_API_TOKEN`. Vite inlines `import.meta.env.VITE_*` as
# PLAINTEXT STRING LITERALS, so the token appeared verbatim in
# dist/assets/*.js - handed to exactly the LAN population it existed to keep
# out of Docker. It was caught by a reviewer building the bundle by hand. This
# script is that review, automated.
#
# What it checks:
#   1. No secret-shaped VITE_* variable is referenced anywhere in web/ source.
#   2. No .env file is committed under web/.
#   3. A real production build of web/local contains none of those names.
#   4. Positive control: a string that MUST be in the bundle actually is, so a
#      passing run cannot mean "the grep read nothing".
#
# Usage:
#   ./scripts/check-bundle-secrets.sh
#
# Exits 0 when the bundle is clean, 1 otherwise.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

readonly APP_DIR='web/local'
readonly DIST_DIR="${APP_DIR}/dist"

# Environment variable names that must never appear in a web app's source. Vite
# only inlines names beginning with VITE_, so those are the ones that can end up
# in a bundle; the bare names are listed too because a `define:` in a Vite config
# can inline anything.
readonly -a FORBIDDEN_NAMES=(
  'VITE_LEM_API_TOKEN'
  'VITE_API_TOKEN'
  'VITE_LEM_TOKEN'
  'VITE_AUTH_TOKEN'
  'VITE_API_SECRET'
  'VITE_LEM_SECRET'
  'LEM_API_TOKEN'
)

# A string the built bundle is guaranteed to contain: the credential prompt
# tells the operator where their token file is. If this is missing, the build
# is not what we think it is and every "not found" above is meaningless.
readonly POSITIVE_CONTROL='~/.lem/api_token'

fail() {
  printf '\nFAIL: %s\n' "$1" >&2
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::error title=Credential in bundle::%s\n' "$1"
  fi
  exit 1
}

# --- 1. Source tree --------------------------------------------------------
# Scoped to web/, which is what gets bundled. Documentation elsewhere in the
# repo names VITE_LEM_API_TOKEN on purpose, to explain why it does not exist.

printf 'Scanning %s source for secret-shaped build variables...\n' 'web/'
source_hits=0
for name in "${FORBIDDEN_NAMES[@]}"; do
  if matches="$(git grep -n -F -- "$name" -- 'web/*.ts' 'web/*.tsx' 'web/*.js' 'web/*.jsx' 'web/*.html' 'web/*.json' 2>/dev/null)"; then
    printf '  %s referenced in web/ source:\n' "$name"
    printf '%s\n' "$matches" | sed 's/^/    /'
    source_hits=$((source_hits + 1))
  fi
done
[[ "$source_hits" -eq 0 ]] || fail "web/ source references a build-time credential variable (see above). The credential must be supplied at runtime - see web/local/src/api/session.ts."
printf '  none of the %d forbidden names appear in web/ source.\n' "${#FORBIDDEN_NAMES[@]}"

# --- 2. Committed .env files ----------------------------------------------
# `*.example` files are templates: Vite never loads them, and web/remote ships
# two on purpose. Anything else matching .env* IS loaded at build time and its
# VITE_* values ARE inlined, so committing one is how a secret gets into a
# bundle without anybody writing it into source.

printf 'Checking for committed .env files under web/...\n'
env_files="$(git ls-files -- 'web/**/.env*' 'web/.env*' || true)"
loaded_envs="$(printf '%s\n' "$env_files" | grep -v '\.example$' || true)"
if [[ -n "$loaded_envs" ]]; then
  printf '%s\n' "$loaded_envs" | sed 's/^/    /'
  fail 'a build-time .env file is committed under web/. Vite loads these and inlines every VITE_* value into the bundle.'
fi

# The templates still must not teach anyone to set a credential variable.
if [[ -n "$env_files" ]]; then
  for name in "${FORBIDDEN_NAMES[@]}"; do
    # shellcheck disable=SC2086  # word splitting is how the file list is passed.
    if matches="$(grep -nF -- "$name" $env_files 2>/dev/null)"; then
      printf '%s\n' "$matches" | sed 's/^/    /'
      fail "an env template under web/ documents ${name}."
    fi
  done
fi
printf '  %d template(s), no build-time .env, no credential names.\n' \
  "$(printf '%s' "$env_files" | grep -c . || true)"

# --- 3. Build --------------------------------------------------------------

printf 'Building %s...\n' "$APP_DIR"
rm -rf "$DIST_DIR"
(cd "$APP_DIR" && pnpm run build >/dev/null)
[[ -d "$DIST_DIR" ]] || fail "the build produced no ${DIST_DIR} directory."

# --- 4. Positive control ---------------------------------------------------
# Before asserting anything is absent, prove the search reads real content.

printf 'Positive control: expecting %s in the build output...\n' "$POSITIVE_CONTROL"
if ! control="$(grep -rlF -- "$POSITIVE_CONTROL" "$DIST_DIR")"; then
  fail "the build output does not contain ${POSITIVE_CONTROL}. The 'no credential found' result below would be vacuous, so this run proves nothing. Check that the credential prompt is still part of the app."
fi
printf '%s\n' "$control" | sed 's/^/    found in /'

# --- 5. Build output -------------------------------------------------------

printf 'Scanning %s for credential material...\n' "$DIST_DIR"
dist_hits=0
for name in "${FORBIDDEN_NAMES[@]}"; do
  if matches="$(grep -rnF -- "$name" "$DIST_DIR" 2>/dev/null)"; then
    printf '  %s found in the build output:\n' "$name"
    printf '%s\n' "$matches" | sed 's/^/    /'
    dist_hits=$((dist_hits + 1))
  fi
done
[[ "$dist_hits" -eq 0 ]] || fail 'the build output contains a credential build variable.'

printf '\nBundle is credential-free: %d forbidden names checked against %s source and %s, positive control matched.\n' \
  "${#FORBIDDEN_NAMES[@]}" 'web/' "$DIST_DIR"
