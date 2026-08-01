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
# THE ONE EXCLUSION, AND WHY IT IS VERIFIED RATHER THAN ASSUMED. Vite inlines
# assets below build.assetsInlineLimit as base64 `data:` URIs, and those bytes
# are long, opaque and digit-bearing, so they would be reported on every run.
# An earlier version of this script therefore skipped anything matching the
# *textual shape* of a data: URI. That was a hole you could drive a bus
# through: `'data:text/plain;base64,<secret>'` is one static literal, and it
# was skipped whole, before either value rule ran. The secret shipped in
# dist/assets/*.js and this script said PASS.
#
# A payload is now skipped only if BOTH hold:
#   1. its MIME type is in ASSET_MAGIC below - an explicit image/font list, so
#      text/plain and anything unrecognised is scanned like ordinary content;
#   2. the payload actually decodes to that format's magic bytes - so
#      `data:image/png;base64,<secret>` is scanned too, because a secret does
#      not start with the PNG signature.
# Anything that fails either test is scanned. The exclusion is now a statement
# about bytes, not about punctuation.
#
# WHAT THIS CANNOT DO. It is a heuristic scan over build output, not a proof.
# It will not see a secret that is split across concatenated literals, encoded
# (rot13, char codes, escape sequences), shaped like ordinary prose, or shorter
# than the thresholds without a nearby keyword. A secret hidden inside a real
# PNG's pixel data would also pass. Do not read a pass as "there is no secret
# in the bundle"; read it as "nothing credential-shaped was found by the rules
# below". The final report says exactly that, on purpose.
#
# SELF-TEST. After the real scan, the value rules are re-run against a COPY of
# the built output with freshly generated canaries appended. If the scanner
# fails to flag them, this script fails - a gate that has never been shown to
# fail is not a gate, and this project has now found four CI gates that were
# silently passing. The demonstration runs on every invocation rather than
# once, by hand, at review time.
#
# The canaries deliberately sit at the BOUNDARY of each rule, not in a
# comfortable middle, because a self-test whose inputs are easier than reality
# passes while blind. An earlier version used three middle-of-the-distribution
# canaries, and review showed two one-line mutations - narrowing KEYWORD_RE to
# just `password`, and anchoring OPAQUE_RE to a leading letter - that broke
# detection of real secrets while the self-test still reported success. So the
# set now includes: one canary per keyword alternative; shapes that start with
# a digit and end with a digit; letter-heavy and digit-heavy shapes; strings
# exactly AT the 32- and 16-char thresholds; the data: URI shapes above; and
# NEGATIVE canaries one character BELOW each threshold plus a genuine inlined
# PNG, which must NOT be reported. Both directions fail the script, so a rule
# cannot silently narrow or silently widen.
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

# Every keyword alternative in KEYWORD_RE above. The self-test plants one canary
# per entry, so deleting an alternative from the regex without deleting it here
# turns the self-test red. Keep the two in step.
readonly -a KEYWORDS=(
  token secret password passwd bearer credential apikey api_key api-key
)

# A base64 `data:` URI, in two halves so extraction and elision are composed
# from the SAME parts. They have to describe exactly the same set: a payload
# that could be elided without also being extracted would be a hole.
readonly DATA_URI_PREFIX_RE='data:[A-Za-z0-9._+-]*/?[A-Za-z0-9._+-]*;base64,'
readonly DATA_URI_PAYLOAD_RE='[A-Za-z0-9+/=]+'
readonly DATA_URI_RE="${DATA_URI_PREFIX_RE}${DATA_URI_PAYLOAD_RE}"

# MIME types whose payload may be skipped, and the hex magic bytes the payload
# must ACTUALLY begin with for the skip to apply. Both halves are required: the
# MIME type is a claim made by whoever wrote the string, and the magic bytes are
# what is really there.
#
# image/svg+xml is deliberately absent. SVG is text, so a "verified" SVG payload
# could carry anything; it gets scanned like any other content.
asset_magic_for() {
  case "$1" in
    image/png) printf '89504e470d0a1a0a' ;;
    image/jpeg) printf 'ffd8ff' ;;
    image/gif) printf '474946383' ;;
    image/webp) printf '52494646' ;;
    image/x-icon | image/vnd.microsoft.icon) printf '00000100' ;;
    font/woff | application/font-woff) printf '774f4646' ;;
    font/woff2 | application/font-woff2) printf '774f4632' ;;
    font/otf | application/x-font-opentype) printf '4f54544f' ;;
    font/ttf | application/x-font-ttf) printf '00010000' ;;
    *) return 1 ;;
  esac
}

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

# Decode base64, tolerating both GNU (-d) and BSD/macOS (-D) spellings.
decode_b64() {
  printf '%s' "$1" | base64 -d 2>/dev/null \
    || printf '%s' "$1" | base64 -D 2>/dev/null \
    || true
}

# True when a data: URI payload is really an inlined image or font.
#
# $1: MIME type as claimed by the URI
# $2: base64 payload
is_inlined_asset() {
  local mime="$1" payload="$2" expected magic

  expected="$(asset_magic_for "$mime")" || return 1

  # 16 base64 chars is a whole number of quanta and decodes to 12 bytes, which
  # covers every signature in the table. A payload too short to hold a header
  # is not an asset.
  [[ ${#payload} -ge 16 ]] || return 1
  magic="$(decode_b64 "${payload:0:16}" | od -An -tx1 -v | tr -d ' \n')"
  [[ -n "$magic" && "$magic" == "$expected"* ]]
}

scan_file() {
  local file="$1"
  local scannable="${TMP_DIR}/scannable"
  local extras="${TMP_DIR}/extras"
  local uri mime payload

  : > "$extras"

  # Decide, per URI, whether it is a genuine inlined asset. Anything that is
  # not - wrong MIME, or a MIME whose bytes do not back it up - has its payload
  # appended to the scan input, so eliding it below cannot hide it.
  while IFS= read -r uri; do
    [[ -n "$uri" ]] || continue
    mime="${uri#data:}"
    mime="${mime%%;*}"
    payload="${uri#*;base64,}"
    if is_inlined_asset "$mime" "$payload"; then
      continue
    fi
    printf '%s\n' "$payload" >> "$extras"
  done < <(grep -oaE "$DATA_URI_RE" "$file" 2>/dev/null || true)

  # Elide every payload, then add back the ones that were not vouched for. The
  # elision keeps a verified asset from drowning the report; the add-back is
  # what makes the exclusion safe.
  sed -E "s#(${DATA_URI_PREFIX_RE})${DATA_URI_PAYLOAD_RE}#\1PAYLOAD-ELIDED#g" \
    "$file" > "$scannable" 2>/dev/null || cp "$file" "$scannable"
  cat "$extras" >> "$scannable"

  grep -oaE "$OPAQUE_RE" "$scannable" 2>/dev/null \
    | grep -E '[0-9]' \
    | grep -E '[A-Za-z]' \
    | grep -vxF -f "$ALLOWLIST_FILE" \
    | sort -u \
    | sed 's/^/opaque-literal /' || true

  grep -oaiE "$KEYWORD_RE" "$scannable" 2>/dev/null \
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

# A 1x1 transparent PNG. Not a secret - a published constant, used as a
# negative canary: it is a genuine inlined asset, so the scan must stay quiet
# about it. If the MIME-plus-magic verification ever breaks open, this 96-char
# opaque run starts being reported and the self-test says so.
readonly PNG_1X1_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

# Draw $2 random characters from the character class $1.
#
# Built from a bounded pool rather than `tr < /dev/urandom | head -c`: that
# pipeline makes `head` close the pipe under tr, and with `set -o pipefail` the
# resulting SIGPIPE takes the whole script down.
rand_chars() {
  local class="$1" want="$2" pool=''
  while [[ ${#pool} -lt $want ]]; do
    pool+="$(head -c 4096 /dev/urandom | LC_ALL=C tr -dc "$class" || true)"
  done
  printf '%s' "${pool:0:want}"
}

rand_letters() { rand_chars 'A-Za-z' "$1"; }
rand_digits() { rand_chars '0-9' "$1"; }
rand_urlsafe() { rand_chars 'A-Za-z0-9_-' "$1"; }
rand_b64std() { rand_chars 'A-Za-z0-9' "$1"; }
rand_hex() { rand_chars '0-9a-f' "$1"; }

# Prove the value rules still fire, at the edges where they are drawn.
#
# Copies the real build output, appends freshly generated canaries, and re-runs
# the scan. Positive canaries must be reported; negative ones must not. Both
# directions matter: missing a positive means a rule has narrowed, and reporting
# a negative means a threshold has drifted or the asset exclusion has broken.
#
# Every canary carries randomness, so none of this can pass by matching a string
# the scanner happens to know.
verify_scanner_detects_canaries() {
  local dir="$1"
  local canary_dir="${TMP_DIR}/canary"
  local found target canary missing spurious keyword literal index
  local -a must_detect=() must_not_detect=() lines=()

  rm -rf "$canary_dir"
  cp -r "$dir" "$canary_dir"
  target="$(find "$canary_dir" -type f -name '*.js' | head -1)"
  [[ -n "$target" ]] || fail "self-test could not run: no .js file under ${dir}."

  # --- opaque-literal, positive -------------------------------------------
  # Fixed first and last characters pin the property under test; the middle is
  # random. Anchoring the rule to a leading letter, or requiring more than one
  # digit or letter, breaks one of these.
  local starts_digit ends_digit hex_at_32 letter_heavy digit_heavy
  starts_digit="$(rand_digits 1)$(rand_urlsafe 41)$(rand_letters 1)"   # 43, leads with a digit
  ends_digit="$(rand_letters 1)$(rand_urlsafe 41)$(rand_digits 1)"     # 43, trails with a digit
  hex_at_32="$(rand_chars 'a-f' 1)$(rand_hex 30)$(rand_digits 1)"      # 32, exactly at threshold
  letter_heavy="$(rand_letters 16)$(rand_digits 1)$(rand_letters 15)"  # 32, a single digit
  digit_heavy="$(rand_digits 16)$(rand_letters 1)$(rand_digits 15)"    # 32, a single letter
  must_detect+=("$starts_digit" "$ends_digit" "$hex_at_32" "$letter_heavy" "$digit_heavy")
  lines+=(
    "$(printf 'console.debug("lem-boot","%s");' "$starts_digit")"
    "$(printf 'console.debug("lem-boot","%s");' "$ends_digit")"
    "$(printf 'console.debug("lem-boot","%s");' "$hex_at_32")"
    "$(printf 'console.debug("lem-boot","%s");' "$letter_heavy")"
    "$(printf 'console.debug("lem-boot","%s");' "$digit_heavy")"
  )

  # --- data: URI, positive ------------------------------------------------
  # Standard-base64 alphabet, because that is what the URI grammar allows and
  # what a real payload uses. The first is an unrecognised MIME type; the second
  # claims to be a PNG and is not. Both must be scanned rather than elided.
  local data_text_secret data_png_secret
  data_text_secret="$(rand_letters 1)$(rand_b64std 41)$(rand_digits 1)"
  data_png_secret="$(rand_letters 1)$(rand_b64std 41)$(rand_digits 1)"
  must_detect+=("$data_text_secret" "$data_png_secret")
  lines+=(
    "$(printf 'console.debug("lem-boot","data:text/plain;base64,%s");' "$data_text_secret")"
    "$(printf 'console.debug("lem-boot","data:image/png;base64,%s");' "$data_png_secret")"
  )

  # --- keyword-adjacent, positive -----------------------------------------
  # One per alternative in KEYWORD_RE, each with a literal exactly at the
  # 16-char threshold. Deleting any alternative from the regex fails here.
  index=0
  for keyword in "${KEYWORDS[@]}"; do
    literal="$(rand_letters 1)$(rand_urlsafe 14)$(rand_digits 1)"
    must_detect+=("$literal")
    lines+=("$(printf 'const lemCanaryCfg%d={"%s":"%s"};' "$index" "$keyword" "$literal")")
    index=$((index + 1))
  done

  # --- negative canaries ---------------------------------------------------
  # One character below each threshold, plus a genuine inlined asset. Reporting
  # any of these means a rule has widened or the exclusion has broken.
  local below_opaque below_keyword
  below_opaque="$(rand_letters 1)$(rand_urlsafe 29)$(rand_digits 1)"  # 31
  below_keyword="$(rand_letters 1)$(rand_urlsafe 13)$(rand_digits 1)" # 15
  must_not_detect+=("$below_opaque" "$below_keyword" "$PNG_1X1_B64")
  lines+=(
    "$(printf 'console.debug("lem-canary-neg","%s");' "$below_opaque")"
    "$(printf 'const lemCanaryNeg={"password":"%s"};' "$below_keyword")"
    "$(printf 'const lemCanaryPng="data:image/png;base64,%s";' "$PNG_1X1_B64")"
  )

  printf '%s\n' "${lines[@]}" >> "$target"
  found="$(scan_tree "$canary_dir")"
  rm -rf "$canary_dir"

  missing=0
  for canary in "${must_detect[@]}"; do
    printf '%s' "$found" | grep -qF -- "$canary" || missing=$((missing + 1))
  done

  spurious=0
  for canary in "${must_not_detect[@]}"; do
    if printf '%s' "$found" | grep -qF -- "$canary"; then
      spurious=$((spurious + 1))
    fi
  done

  if [[ "$missing" -ne 0 ]]; then
    fail "SELF-TEST FAILED: the value scan missed ${missing} of ${#must_detect[@]} planted canaries in ${dir}. A rule has narrowed, so a clean result from it means nothing. Do not treat this run as evidence of anything."
  fi
  if [[ "$spurious" -ne 0 ]]; then
    fail "SELF-TEST FAILED: the value scan reported ${spurious} of ${#must_not_detect[@]} canaries that it must ignore in ${dir}. Either a length threshold has drifted below its documented value, or the verified-asset exclusion has stopped working."
  fi
  printf '  self-test: %d/%d boundary canaries detected, %d/%d correctly ignored.\n' \
    "${#must_detect[@]}" "${#must_detect[@]}" "${#must_not_detect[@]}" "${#must_not_detect[@]}"
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
  - base64 data: URIs, whose payloads are skipped ONLY when the MIME type is a
    known image/font AND the bytes decode to that format's magic number
  - the value scan itself, per app, against 16 boundary canaries that must be
    reported and 3 that must not

Nothing credential-shaped was found by those rules. That is not the same as
"the bundles contain no secret": this is a heuristic scan. A value split across
literals, encoded, shaped like ordinary text, or buried in the pixels of a real
image would pass it.
EOF
