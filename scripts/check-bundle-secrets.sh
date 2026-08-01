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
# NOTHING IS EXCLUDED BY SHAPE. This took three rounds of review to get right,
# so the history is worth keeping:
#
#   Vite inlines assets below build.assetsInlineLimit as base64 `data:` URIs.
#   Those are long, opaque, digit-bearing runs, so they would be reported on
#   every run, and two successive attempts were made to skip them cheaply.
#
#   Attempt 1 skipped anything matching the *textual shape* of a data: URI.
#   `'data:text/plain;base64,<secret>'` - one static literal - was skipped
#   whole, before either rule ran.
#
#   Attempt 2 demanded a known image/font MIME type AND that the payload
#   decode to that format's magic bytes. That closed the exact string above
#   and nothing more: the check read the first 12 decoded bytes and then
#   elided the WHOLE payload, so `base64(PNG_signature || secret)` sailed
#   through. Proven live for PNG, JPEG and WOFF2.
#
# Both failures are the same shape as the original bug this script exists to
# catch: something vouches for a label or a prefix, and the real content rides
# in behind it. There is no version of "validate the first N bytes" that does
# not have this problem, so the exclusion is gone. Every byte of every data:
# URI payload is now scanned like any other content.
#
# A genuine inlined asset will therefore be reported, and is silenced by adding
# the SHA-256 of its payload to ASSET_SHA256_ALLOWLIST below. That is a hash of
# the ENTIRE payload: append one byte to a vouched-for asset and it no longer
# matches. A prefix can no longer speak for a suffix because nothing is
# examining prefixes any more. Neither app inlines an asset today, so this
# costs nothing right now and fails closed the first time one appears.
#
# SPLIT LITERALS. Every rule is applied twice: once to the file as it is, and
# once to a copy with whitespace removed. A base64 literal split by whitespace
# inside a template literal is line-oriented grep's blind spot, and it needs no
# deliberate obfuscation - a formatter wrapping a long string does it by
# accident.
#
# Three versions of this were written by hand and all three lost to a character
# nobody had enumerated: first only "\n" (broken by a TAB through ordinary
# bundling, and by "\r\n" through public/, where `tr -d '\n'` deletes the
# newline and LEAVES THE \r behind as a residual separator); then a list of
# every whitespace character anyone had demonstrated, which still omitted
# U+0085 NEL - plainly White_Space=Yes, and a live bypass.
#
# So the class is no longer written down here. It is DERIVED from Unicode's own
# property data by scripts/gen-invisible-class.py, committed as
# scripts/invisible-class.sh, and re-derived and compared on every run. The next
# character Unicode adds turns a check red instead of quietly reopening the gap.
# See the generator's docstring for the definition and for why SPACE stays in.
#
# public/ IS THE AWKWARD PATH. Vite copies it into dist/ verbatim, bypassing
# esbuild entirely, so nothing may assume the bundler has normalised anything:
# not line endings, not encoding, not escaping. Every assumption in this script
# is therefore about bytes on disk under dist/, never about what esbuild would
# have produced. `find dist -type f` picks those copies up like any other file
# (confirmed: the file count rises when public/ gains a file), the value rules
# are pure content matching, and the whitespace class above is applied to raw
# bytes under LC_ALL=C. The only bundler-shaped assumption left is the positive
# control, which looks for the hashed entry chunk that Vite always emits - and
# that is a check on the build having happened at all, not on any file's
# content.
#
# WHAT THIS CANNOT DO. It is a heuristic scan over build output, not a proof.
# It will not see a secret that is split across concatenated literals, encoded
# (rot13, char codes, escape sequences), shaped like ordinary prose, or shorter
# than the thresholds without a nearby keyword. A secret hidden inside the
# pixel data of an asset that has been allowlisted by hash would also pass, but
# only for as long as nobody changes that asset. Do not read a pass as "there
# is no secret in the bundle"; read it as "nothing credential-shaped was found
# by the rules below". The final report says exactly that, on purpose.
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
# exactly AT the 32- and 16-char thresholds; the data: URI shapes above; ONE
# SPLIT CANARY PER MEMBER of the invisible-character class, taken from the
# generated file rather than from a list of the separators anyone has tried; a
# canary in a non-.js file at the dist root, which is what a public/ static copy
# looks like; and NEGATIVE canaries one character BELOW each threshold plus a
# genuine inlined PNG, which must NOT be reported. Both directions fail the
# script, so a rule cannot silently narrow or silently widen.
#
# The two halves of the class defence are deliberately different in kind: the
# per-member canaries prove every character in the class is really stripped, and
# verify_invisible_class_is_current() proves the class is the right set. Neither
# alone would have caught U+0085.
#
# WHAT THE SELF-TEST CANNOT CATCH. Its canaries are random, so it detects a
# rule that stops matching a whole SHAPE. It cannot detect a weakening that
# only shows up on collisions - review demonstrated this by truncating the
# hash comparison to 32 bits, which random canaries missed in three runs
# because they never collide by chance. The shipped code compares full
# SHA-256 digests; the point is that this particular self-test is not the
# thing keeping it that way, so read it as a shape check, not a proof.
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

# Genuine inlined assets, silenced by the SHA-256 of their base64 payload.
#
# This is how you clear a real asset that trips `opaque-literal` - a hash, not
# a 5 KB literal in VALUE_ALLOWLIST, and not a rule that trusts a MIME label or
# a magic number. The hash covers the WHOLE payload: append a single byte to a
# vouched-for asset and it stops matching, which is precisely the bypass that
# header-only verification could not close.
#
#   abbd4841ba31f4d7195c0bae44b30cbebbb9c7cc91f3dad94f68614c6ce4bee8
#     A 1x1 transparent PNG. Published constant, not a secret. It is here as
#     the worked example of the mechanism, AND as the self-test's must-ignore
#     canary: the self-test plants it on every run and fails if it is reported,
#     so this entry proves hash-allowlisting still works. The same self-test
#     plants that PNG's signature followed by a secret, which must still be
#     reported.
readonly -a ASSET_SHA256_ALLOWLIST=(
  'abbd4841ba31f4d7195c0bae44b30cbebbb9c7cc91f3dad94f68614c6ce4bee8'
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

HASH_FILE="${TMP_DIR}/asset-hashes"
printf '%s\n' "${ASSET_SHA256_ALLOWLIST[@]}" > "$HASH_FILE"

# ---------------------------------------------------------------------------
# Value scan
# ---------------------------------------------------------------------------

# SHA-256 of a string, on GNU (sha256sum) or BSD/macOS (shasum -a 256).
sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else
    printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
  fi
}

# Drop candidates whose SHA-256 is a vouched-for asset. Reads candidates on
# stdin, one per line; writes the survivors.
#
# Hashing happens last, after the cheap filters, so in practice this runs zero
# or one times per file rather than once per long identifier in the bundle.
filter_asset_hashes() {
  local line
  while IFS= read -r line; do
    if ! grep -qxF -- "$(sha256_of "$line")" "$HASH_FILE"; then
      printf '%s\n' "$line"
    fi
  done
}

# The invisible-character class removed for the join pass. NOT maintained here:
# scripts/invisible-class.sh is generated by scripts/gen-invisible-class.py from
# Unicode's own property data, and verify_invisible_class_is_current() below
# regenerates and compares on every run.
#
# It is derived rather than listed because three successive hand-written
# versions each missed a character nobody had enumerated - first everything but
# "\n", then "\n" plus tab and CR, then a list that still omitted U+0085 NEL,
# which is plainly White_Space=Yes. Enumeration kept losing to the case outside
# the enumeration, exactly as it did with the MIME table before it. See the
# generator's docstring for what the class contains and why SPACE is the one
# member left in.
# shellcheck source=invisible-class.sh
. "${REPO_ROOT}/scripts/invisible-class.sh"

# Emit $1 with every invisible character except SPACE removed. Byte-exact under
# LC_ALL=C, which matters because content copied from public/ never goes through
# esbuild and can carry any bytes at all.
join_whitespace() {
  LC_ALL=C tr -d "$INVISIBLE_ASCII" < "$1" | LC_ALL=C sed -E "s/${INVISIBLE_UTF8_RE}//g"
}

# Fail if the committed class no longer matches what Unicode says.
#
# This is the half of the design that enumeration cannot provide: the canaries
# below prove every member of the class is actually stripped, and this proves
# the class is the right set in the first place. A Unicode release that adds a
# whitespace or format character turns this red instead of silently reopening
# the gap that U+0085 sat in.
#
# python3 is required in CI, where it is always present. Locally it degrades to
# a loud skip rather than a hard stop, so the scanner still runs on a machine
# without it - but it says so, rather than passing quietly.
verify_invisible_class_is_current() {
  local generator="${REPO_ROOT}/scripts/gen-invisible-class.py"

  if ! command -v python3 > /dev/null 2>&1; then
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
      fail 'python3 is unavailable, so the invisible-character class could not be checked against Unicode. Refusing to report a pass on an unverified class.'
    fi
    printf '  NOTE: python3 unavailable - the invisible-character class was NOT checked\n'
    printf '        against Unicode. CI checks it; this local run did not.\n'
    return 0
  fi

  if ! python3 "$generator" --check; then
    fail "the committed invisible-character class disagrees with Unicode $(python3 -c 'import unicodedata; print(unicodedata.unidata_version)' 2>/dev/null). Regenerate scripts/invisible-class.sh (see the diff above)."
  fi
  printf '  invisible-character class: %s code points, matches Unicode %s.\n' \
    "$INVISIBLE_CLASS_SIZE" "$INVISIBLE_UNICODE_VERSION"
}

# Scan one built file for credential-shaped material.
#
# $1: path to the file
# stdout: one finding per line, "<rule> <match>"; empty when clean.
scan_file() {
  local file="$1"
  local scannable="${TMP_DIR}/scannable"

  # The file as it is, plus the same file with whitespace removed. The second
  # copy is what catches a literal split by whitespace, which line-oriented
  # grep cannot see. Nothing is elided from either copy: see the header for why
  # data: URI payloads are no longer special-cased.
  cat "$file" > "$scannable"
  printf '\n' >> "$scannable"
  join_whitespace "$file" >> "$scannable"

  grep -oaE "$OPAQUE_RE" "$scannable" 2>/dev/null \
    | grep -E '[0-9]' \
    | grep -E '[A-Za-z]' \
    | grep -vxF -f "$ALLOWLIST_FILE" \
    | sort -u \
    | filter_asset_hashes \
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
# about it - not because of its shape, but because its SHA-256 is in
# ASSET_SHA256_ALLOWLIST. If hash-allowlisting breaks, this 96-char opaque run
# starts being reported and the self-test says so.
readonly PNG_1X1_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

# Base64 of the file signatures that round 3's bypass rode in behind. A secret
# appended to any of these must still be reported; that the bytes are a real
# PNG/JPEG/WOFF2 header buys nothing, because nothing inspects headers now.
#
#   AAAA-aligned on purpose: each is a whole number of base64 quanta, so
#   `<signature_b64><secret_b64>` really does decode to signature-then-secret,
#   which is what makes these faithful reproductions of the reported attack
#   rather than merely similar-looking strings.
readonly PNG_SIG_B64='iVBORw0KGgo='    # 89 50 4e 47 0d 0a 1a 0a
readonly JPEG_SIG_B64='/9j/4AAQSkZJRg==' # ff d8 ff e0 00 10 4a 46 49 46
readonly WOFF2_SIG_B64='d09GMgABAAA='   # 77 4f 46 32 00 01 00 00

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

  # --- real file signature + secret, positive -----------------------------
  # Round 3's bypass, one canary per asset type it was proven against. Each is
  # a genuine PNG/JPEG/WOFF2 signature with a secret appended, under the
  # matching MIME type - the exact shape that header-only verification elided
  # wholesale. Any future attempt to skip payloads by inspecting their opening
  # bytes fails here.
  local png_tail jpeg_tail woff2_tail
  png_tail="$(rand_letters 1)$(rand_b64std 41)$(rand_digits 1)"
  jpeg_tail="$(rand_letters 1)$(rand_b64std 41)$(rand_digits 1)"
  woff2_tail="$(rand_letters 1)$(rand_b64std 41)$(rand_digits 1)"
  must_detect+=("$png_tail" "$jpeg_tail" "$woff2_tail")
  lines+=(
    "$(printf 'const lemCanaryA="data:image/png;base64,%s%s";' "$PNG_SIG_B64" "$png_tail")"
    "$(printf 'const lemCanaryB="data:image/jpeg;base64,%s%s";' "$JPEG_SIG_B64" "$jpeg_tail")"
    "$(printf 'const lemCanaryC="data:font/woff2;base64,%s%s";' "$WOFF2_SIG_B64" "$woff2_tail")"
  )

  # --- split by an invisible character, positive --------------------------
  # ONE CANARY PER MEMBER of the class, taken from the generated file rather
  # than from a hand-written list of the separators reviewers have tried. Each
  # half is deliberately under the 32-char threshold, so only the join pass can
  # see the whole; if a character stops being stripped, its canary stops being
  # found. Every byte width is therefore covered by construction, and so is
  # every character added by a future Unicode release once the class is
  # regenerated.
  #
  # The halves are a random base plus an index rather than fresh randomness per
  # canary: with ~200 members, spawning two /dev/urandom reads each would
  # dominate the runtime, and the index already guarantees uniqueness.
  local split_base_a split_base_b sep sep_index=0
  split_base_a="$(rand_letters 1)$(rand_b64std 15)"
  split_base_b="$(rand_b64std 15)$(rand_digits 1)"

  local -a separators=()
  # Single-byte members, character by character.
  local ascii_index=0
  while [[ $ascii_index -lt ${#INVISIBLE_ASCII} ]]; do
    separators+=("${INVISIBLE_ASCII:$ascii_index:1}")
    ascii_index=$((ascii_index + 1))
  done
  # Multi-byte members: the generated ERE is a '|'-separated list of raw
  # sequences, so splitting on '|' recovers exactly the class.
  local -a utf8_members=()
  IFS='|' read -ra utf8_members <<< "$INVISIBLE_UTF8_RE"
  separators+=("${utf8_members[@]}")

  for sep in "${separators[@]}"; do
    [[ -n "$sep" ]] || continue
    local head="${split_base_a}$(printf '%04d' "$sep_index")"
    local tail="${split_base_b}$(printf '%04d' "$sep_index")"
    must_detect+=("${head}${tail}")
    lines+=("$(printf 'const lemCanarySplit%d = `%s%s%s`;' \
      "$sep_index" "$head" "$sep" "$tail")")
    sep_index=$((sep_index + 1))
  done

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
  # One character below each threshold, plus a genuine asset cleared by hash.
  # Reporting any of these means a rule has widened, or that hash-allowlisting
  # has stopped working and every real asset is about to become a false alarm.
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

  # --- a static file, positive --------------------------------------------
  # Written at the dist root as a non-.js file, which is what a public/ copy
  # looks like after Vite's verbatim static copy. Guards against scan_tree ever
  # narrowing to the bundle chunks and missing the path that bypasses esbuild.
  local static_secret
  static_secret="$(rand_letters 1)$(rand_b64std 41)$(rand_digits 1)"
  must_detect+=("$static_secret")
  printf 'lem-canary-static %s\n' "$static_secret" > "${canary_dir}/lem-canary-static.txt"

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
    fail "SELF-TEST FAILED: the value scan reported ${spurious} of ${#must_not_detect[@]} canaries that it must ignore in ${dir}. Either a length threshold has drifted below its documented value, or hash-allowlisting of genuine assets has stopped working."
  fi
  canary_positive="${#must_detect[@]}"
  canary_negative="${#must_not_detect[@]}"
  printf '  self-test: %d/%d boundary canaries detected, %d/%d correctly ignored.\n' \
    "$canary_positive" "$canary_positive" "$canary_negative" "$canary_negative"
}

# ---------------------------------------------------------------------------
# 1. Source tree: forbidden build-variable names
# ---------------------------------------------------------------------------
# Scoped to web/, which is what gets bundled. Documentation elsewhere in the
# repo names VITE_LEM_API_TOKEN on purpose, to explain why it does not exist,
# and this script has to name it to forbid it.

printf 'Checking the invisible-character class against Unicode...\n'
verify_invisible_class_is_current

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
canary_positive=0
canary_negative=0

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
  - every byte of every base64 data: URI payload, with nothing excluded by MIME
    type or file signature; genuine assets are cleared by SHA-256 of the whole
    payload instead
  - the same rules again over a copy with the invisible-character class removed
    (Unicode White_Space plus category Cf, minus SPACE - ${INVISIBLE_CLASS_SIZE} code points,
    derived from Unicode ${INVISIBLE_UNICODE_VERSION}, re-checked this run), so a literal split by
    any of them is not invisible
  - the value scan itself, per app, against ${canary_positive} boundary canaries that must be
    reported and ${canary_negative} that must not

Nothing credential-shaped was found by those rules. That is not the same as
"the bundles contain no secret": this is a heuristic scan. A value split across
concatenated literals, encoded, shaped like ordinary text, or buried inside an
asset that has been allowlisted by hash would pass it.
EOF
