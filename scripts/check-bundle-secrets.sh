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
# Look for credentials in the built web bundles.
#
# Background (issue #48): an earlier attempt at LAN dashboard auth shipped a
# build-time `VITE_LEM_API_TOKEN`. Vite inlines `import.meta.env.VITE_*` as
# PLAINTEXT STRING LITERALS, so the token appeared verbatim in
# dist/assets/*.js - handed to exactly the LAN population it existed to keep
# out of Docker. It was caught by a reviewer building the bundle by hand. This
# script is that review, automated.
#
# TWO INDEPENDENT LAYERS, because either one alone is a false sense of safety:
#
#   NAMES  - a denylist of build-variable identifiers (VITE_LEM_API_TOKEN and
#            friends), checked in web/ source and in the built output. Cheap,
#            precise, and it fails at the source stage before a build even runs.
#            It catches a recurrence of the exact historical bug and NOTHING
#            ELSE: rename the variable, hardcode a fallback, or leave a debug
#            `console.log` behind and this layer sees nothing.
#   VALUES - a shape scan of the built output for material that LOOKS like a
#            credential regardless of what it is called. This is the layer that
#            catches the general case. It exists because the names layer was
#            shipped on its own once and a planted secret using none of the
#            listed names sailed straight through it.
#
# The value rules, and why they are drawn where they are:
#
#   opaque-literal    A run of >=32 chars from [A-Za-z0-9_+/=-] containing BOTH
#                     a digit and a letter. `secrets.token_urlsafe(32)` (43
#                     chars) and `token_hex(16)` (32 chars) both match. The
#                     digit-and-letter requirement is what separates a random
#                     token from the long identifiers minified JS is full of:
#                     measured against real builds of both apps, every >=32-char
#                     run is word-structured (`layersWithOutsidePointerEvents
#                     Disabled`, `--default-transition-timing-function`,
#                     `UNSAFE_componentWillReceiveProps`) and contains no digit.
#
#                     Shannon entropy was tried first and REJECTED, deliberately.
#                     Measured on real data: the noisiest bundle identifier
#                     scores 4.36 bits/char while `token_urlsafe(32)` bottoms out
#                     at 4.44 over 200 samples - a 0.08 margin, far too thin to
#                     gate on. Worse, hex tokens score ~3.2, BELOW the loudest
#                     false positive, so any entropy threshold that silenced the
#                     identifiers would have been blind to every hex secret.
#
#   keyword-adjacent  A shorter literal (>=16 chars) sitting next to a
#                     credential word. Catches labelled secrets that are too
#                     short for the rule above - `password:"hunter2hunter2hu"`.
#
# WHAT THIS CANNOT DO. It is a heuristic scan over build output, not a proof.
# It will not see a secret that is split across concatenated literals, encoded
# (rot13, char codes, escape sequences), shaped like ordinary prose, or shorter
# than the thresholds without a nearby keyword. Do not read a pass as "there is
# no secret in the bundle"; read it as "nothing credential-shaped was found by
# the rules below". The final report says exactly that, on purpose.
#
# SELF-TEST. After the real scan, the value rules are re-run against a COPY of
# the built output with freshly generated credential-shaped canaries appended.
# If the scanner fails to flag them, this script fails - a gate that has never
# been shown to fail is not a gate, and this project has now found four CI
# gates that were silently passing. The demonstration runs on every invocation
# rather than once, by hand, at review time.
#
# Usage:
#   ./scripts/check-bundle-secrets.sh
#
# Exits 0 when nothing credential-shaped is found, 1 otherwise.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Both bundled apps. web/remote is scanned too: it is a browser bundle that
# handles cloud JWTs, so "the gate only looked at the app the PR touched" is
# not a distinction worth defending.
readonly -a APPS=('web/local' 'web/remote')

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

# --- Value rules -----------------------------------------------------------

readonly OPAQUE_RE='[A-Za-z0-9_+/=-]{32,}'
readonly KEYWORD_RE='(token|secret|password|passwd|bearer|credential|api[_-]?key|apikey)[A-Za-z_]{0,12}["'"'"']?[[:space:]]*[:=,(][[:space:]]*["'"'"'][A-Za-z0-9_+/=-]{16,}'

# Strings that legitimately trip `opaque-literal`. Matched whole-line against an
# extracted candidate, never as a substring, so an entry cannot quietly widen
# into a hole. EVERY entry needs a reason - a silently narrowed pattern is not
# an acceptable substitute for one of these.
#
#   xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
#     web/remote/src/App.tsx:44 - the UUID v4 template fed to .replace(/[xy]/g).
#     36 chars, contains the literal '4' from the version nibble, so it satisfies
#     the digit-and-letter rule. It is a format string, not a value.
readonly -a VALUE_ALLOWLIST=(
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
)

# --- Reporting -------------------------------------------------------------

fail() {
  printf '\nFAIL: %s\n' "$1" >&2
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::error title=Credential in bundle::%s\n' "$1"
  fi
  exit 1
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Allowlist as a file, for `grep -vxF -f`. Whole-line matching.
ALLOWLIST_FILE="${TMP_DIR}/allowlist"
printf '%s\n' "${VALUE_ALLOWLIST[@]}" > "$ALLOWLIST_FILE"

# ---------------------------------------------------------------------------
# Value scan
# ---------------------------------------------------------------------------

# Scan one built file for credential-shaped material.
#
# $1: path to the file
# stdout: one finding per line, "<rule> <match>"; empty when clean.
scan_file() {
  local file="$1"
  local stripped="${TMP_DIR}/stripped"

  # Vite inlines assets below build.assetsInlineLimit as base64 `data:` URIs.
  # Those payloads are image and font bytes - long, opaque, digit-and-letter
  # bearing, and reported on every single run if left in. The payload is
  # replaced and the prefix kept, so the exclusion is visible here in the diff
  # rather than hidden inside a narrowed pattern. Neither app inlines anything
  # today; this is for the first icon that crosses the threshold.
  sed -E 's#(data:[A-Za-z0-9.;+/-]*base64,)[A-Za-z0-9+/=]+#\1DATA-URI-PAYLOAD-STRIPPED#g' \
    "$file" > "$stripped" 2>/dev/null || cp "$file" "$stripped"

  grep -oaE "$OPAQUE_RE" "$stripped" 2>/dev/null \
    | grep -E '[0-9]' \
    | grep -E '[A-Za-z]' \
    | grep -vxF -f "$ALLOWLIST_FILE" \
    | sort -u \
    | sed 's/^/opaque-literal /' || true

  grep -oaiE "$KEYWORD_RE" "$stripped" 2>/dev/null \
    | sort -u \
    | sed 's/^/keyword-adjacent /' || true
}

# Scan every file under a directory. Prints "<file>: <rule> <match>" lines.
scan_tree() {
  local dir="$1" file findings
  while IFS= read -r file; do
    findings="$(scan_file "$file")"
    if [[ -n "$findings" ]]; then
      printf '%s: %s\n' "$file" "$findings"
    fi
  done < <(find "$dir" -type f | sort)
}

# Prove the value rules actually fire.
#
# Copies the real build output and appends canaries built from fresh randomness:
# an unlabelled url-safe token (the shape that defeated the names-only gate), an
# unlabelled hex token (the shape that defeats an entropy threshold), and a short
# labelled one (too short for the opaque rule, so only the keyword rule can see
# it). All three must be flagged.
verify_scanner_detects_canaries() {
  local dir="$1"
  local canary_dir="${TMP_DIR}/canary"
  local random_hex canary_a canary_b canary_c found target canary missing

  rm -rf "$canary_dir"
  cp -r "$dir" "$canary_dir"

  random_hex="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  # The 'lemCanary9' prefix guarantees a letter and a digit whatever the
  # randomness produced, so the self-test cannot flake on an all-numeric draw.
  canary_a="lemCanary9$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_')"
  canary_b="lemCanary9${random_hex}"
  canary_c="lemCanary9${random_hex:0:8}"

  target="$(find "$canary_dir" -type f -name '*.js' | head -1)"
  [[ -n "$target" ]] || fail "self-test could not run: no .js file under ${dir}."

  {
    # Deliberately shaped like a debug leftover: no credential keyword anywhere
    # near it, and no name from FORBIDDEN_NAMES. This is the exact shape that
    # passed the names-only version of this gate.
    printf 'console.debug("lem-boot","%s");\n' "$canary_a"
    printf 'console.debug("lem-boot","%s");\n' "$canary_b"
    # Short enough that only the keyword rule can see it.
    printf 'const lemCanaryCfg={password:"%s"};\n' "$canary_c"
  } >> "$target"

  found="$(scan_tree "$canary_dir")"

  missing=0
  for canary in "$canary_a" "$canary_b" "$canary_c"; do
    if ! printf '%s' "$found" | grep -qF -- "$canary"; then
      missing=$((missing + 1))
    fi
  done

  rm -rf "$canary_dir"

  if [[ "$missing" -ne 0 ]]; then
    fail "SELF-TEST FAILED: the value scan missed ${missing} of 3 planted canaries in ${dir}. The scanner is broken, so a clean result from it means nothing. Do not treat this run as evidence of anything."
  fi
  printf '  self-test: 3/3 planted canaries detected (unlabelled url-safe, unlabelled hex, short labelled).\n'
}

# ---------------------------------------------------------------------------
# 1. Source tree: forbidden build-variable names
# ---------------------------------------------------------------------------
# Scoped to web/, which is what gets bundled. Documentation elsewhere in the
# repo names VITE_LEM_API_TOKEN on purpose, to explain why it does not exist,
# and this script has to name it to forbid it.

printf 'Scanning web/ source for secret-shaped build variables...\n'
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

# ---------------------------------------------------------------------------
# 2. Committed .env files
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# 3. Per app: build, positive control, names, values, self-test
# ---------------------------------------------------------------------------

scanned_files=0
sourcemaps=0

for app in "${APPS[@]}"; do
  dist="${app}/dist"

  printf '\n=== %s ===\n' "$app"
  printf 'Building...\n'
  rm -rf "$dist"
  (cd "$app" && pnpm run build >/dev/null)
  [[ -d "$dist" ]] || fail "the build produced no ${dist} directory."

  # Positive control. Before asserting anything is absent, prove the scan reads
  # real content: every Vite build references its hashed entry chunk from
  # index.html. If this is missing, every "not found" below is vacuous.
  if ! grep -rlF -- '/assets/index-' "$dist" >/dev/null; then
    fail "positive control failed for ${app}: the build output does not reference /assets/index-, so it is not a Vite build and the 'nothing found' results below would prove nothing."
  fi
  printf '  positive control: build output references its hashed entry chunk.\n'

  file_count="$(find "$dist" -type f | wc -l)"
  map_count="$(find "$dist" -type f -name '*.map' | wc -l)"
  scanned_files=$((scanned_files + file_count))
  sourcemaps=$((sourcemaps + map_count))

  # Sourcemaps are in scope: `find -type f` takes every file under dist/,
  # including .map. Vite's build.sourcemap defaults to false so neither app
  # emits any today - reported rather than assumed, because a secret stripped
  # from a bundle can survive in the map that accompanies it, and CI archives
  # whatever dist/ contains.
  printf '  scanning %s file(s), %s sourcemap(s).\n' "$file_count" "$map_count"

  name_hits=0
  for name in "${FORBIDDEN_NAMES[@]}"; do
    if matches="$(grep -rnaF -- "$name" "$dist" 2>/dev/null)"; then
      printf '  %s found in the build output:\n' "$name"
      printf '%s\n' "$matches" | sed 's/^/    /'
      name_hits=$((name_hits + 1))
    fi
  done
  [[ "$name_hits" -eq 0 ]] || fail "${dist} contains a credential build variable."

  value_findings="$(scan_tree "$dist")"
  if [[ -n "$value_findings" ]]; then
    printf '%s\n' "$value_findings" | sed 's/^/    /'
    fail "${dist} contains credential-shaped material (see above). If a finding is a false positive, add the exact string to VALUE_ALLOWLIST in $0 with a comment explaining what it is."
  fi
  printf '  no credential-shaped literals.\n'

  verify_scanner_detects_canaries "$dist"
done

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

cat <<EOF

PASS. Checked, across ${#APPS[@]} app(s):
  - ${#FORBIDDEN_NAMES[@]} forbidden build-variable names, in web/ source and in
    the built output
  - committed .env files under web/
  - ${scanned_files} built file(s) (${sourcemaps} sourcemap(s)) for credential-shaped
    literals: opaque runs of >=32 chars carrying both a digit and a letter, and
    literals of >=16 chars adjacent to a credential keyword
  - the value scan itself, against 3 freshly planted canaries per app

Nothing credential-shaped was found by those rules. That is not the same as
"the bundles contain no secret": this is a heuristic scan, and a value that is
split across literals, encoded, or shaped like ordinary text would pass it.
EOF
