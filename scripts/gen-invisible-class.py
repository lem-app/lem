#!/usr/bin/env python3
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
Derive the invisible-character class used by scripts/check-bundle-secrets.sh.

Writes a shell fragment to stdout; scripts/invisible-class.sh is that output,
committed. The scanner sources it and, on every run, regenerates and compares -
so a Unicode update that adds a character fails a check instead of silently
opening a gap.

WHY THIS EXISTS. The scanner's join pass reassembles a literal that has been
split by something invisible, so it needs "every character that can sit between
two halves of a string without being content". Three successive hand-written
versions of that list each missed a case nobody had enumerated: first only
``\\n``, then ``\\n`` plus tab and CR, then everything a reviewer had tried -
which still missed U+0085 NEL, a genuine ``White_Space=Yes`` character. The
list is now derived from Unicode itself rather than maintained by hand.

THE CLASS is ``White_Space=Yes`` union general category ``Cf`` (format), minus
U+0020 SPACE:

* ``White_Space`` is the obvious half, and is what the scanner's docstring used
  to claim. U+0085 is in it. So is every character any reviewer has planted.
* ``Cf`` covers the invisible characters that are *not* whitespace but separate
  text just as effectively - U+200B ZERO WIDTH SPACE, U+200C/D joiners, U+2060
  WORD JOINER, U+FEFF. The old list already contained U+FEFF, which is ``Cf``
  and not ``White_Space``, so the stated scope never matched the code; taking
  the whole category makes the claim true rather than narrowing it to fit.
* U+0020 SPACE is excluded, and that exclusion is measured rather than assumed:
  stripping it fuses adjacent Tailwind class names into runs that trip the
  opaque-literal rule. See the measurement note in invisible-class.sh.

Deliberately NOT included: general category ``Cc`` beyond the whitespace
controls already in ``White_Space``. Those are arbitrary control bytes, and
stripping them from a binary asset under dist/ would fuse unrelated bytes into
spurious long runs. Whitespace and format characters are enough to reassemble a
split *literal*, which is what the join pass is for.

Usage:
    ./scripts/gen-invisible-class.py            # write the fragment to stdout
    ./scripts/gen-invisible-class.py --check    # diff against the committed file
"""

import pathlib
import re
import sys
import unicodedata

# Unicode defines White_Space as the separator categories plus these six
# controls. Deriving it this way rather than hardcoding the code points means a
# future addition to Zs/Zl/Zp is picked up automatically; the cross-check below
# is what guards the hardcoded half.
WHITESPACE_CONTROLS = frozenset({0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x85})

# str.isspace() is True for White_Space plus these four legacy separators, and
# nothing else. Asserting that relationship checks our derivation against a
# completely separate implementation inside CPython: if either drifts, the
# generator fails loudly instead of emitting a quietly wrong class.
ISSPACE_EXTRAS = frozenset({0x1C, 0x1D, 0x1E, 0x1F})

SPACE = 0x20

MAX_CODEPOINT = 0x110000

OUTPUT = pathlib.Path(__file__).with_name('invisible-class.sh')


def derive_white_space() -> frozenset[int]:
    """Code points with Unicode White_Space=Yes.

    Returns:
        The White_Space property set.

    Raises:
        SystemExit: if the derivation disagrees with str.isspace()
    """
    separators = {
        cp
        for cp in range(MAX_CODEPOINT)
        if unicodedata.category(chr(cp)) in ('Zs', 'Zl', 'Zp')
    }
    white_space = frozenset(separators | WHITESPACE_CONTROLS)

    isspace = {cp for cp in range(MAX_CODEPOINT) if chr(cp).isspace()}
    expected = white_space | ISSPACE_EXTRAS
    if isspace != expected:
        missing = sorted(isspace - expected)
        extra = sorted(expected - isspace)
        sys.exit(
            'White_Space derivation disagrees with str.isspace() on '
            f'Python {sys.version_info.major}.{sys.version_info.minor} '
            f'(Unicode {unicodedata.unidata_version}).\n'
            f'  in isspace() but not derived: {[hex(c) for c in missing]}\n'
            f'  derived but not in isspace(): {[hex(c) for c in extra]}\n'
            'Unicode has changed in a way this generator did not anticipate. '
            'Re-read the White_Space definition before touching this.'
        )
    return white_space


def derive_class() -> list[int]:
    """The full invisible-character class, minus SPACE.

    Returns:
        Sorted code points to strip in the join pass.
    """
    formats = {cp for cp in range(MAX_CODEPOINT) if unicodedata.category(chr(cp)) == 'Cf'}
    return sorted((derive_white_space() | formats) - {SPACE})


def shell_quote_bytes(raw: bytes) -> str:
    """Render bytes as a bash ANSI-C quoted string.

    Args:
        raw: The bytes to render

    Returns:
        A $'...' literal
    """
    return "$'" + ''.join(f'\\x{byte:02x}' for byte in raw) + "'"


def render() -> str:
    """Build the shell fragment.

    Returns:
        The complete file contents
    """
    code_points = derive_class()
    ascii_bytes = bytes(cp for cp in code_points if cp < 0x80)
    multibyte = [cp for cp in code_points if cp >= 0x80]

    alternation = '|'.join(
        ''.join(f'\\x{byte:02x}' for byte in chr(cp).encode('utf-8')) for cp in multibyte
    )

    lines = [
        '# SPDX-License-Identifier: AGPL-3.0-or-later',
        '# Copyright (c) 2025 Lem',
        '#',
        '# GENERATED FILE - DO NOT EDIT BY HAND.',
        '# Regenerate with: ./scripts/gen-invisible-class.py > scripts/invisible-class.sh',
        '#',
        '# The invisible-character class for check-bundle-secrets.sh: Unicode',
        f'# White_Space=Yes union general category Cf, minus U+0020 SPACE. '
        f'{len(code_points)} code',
        f'# points, derived from Unicode {unicodedata.unidata_version} '
        f'(Python {sys.version_info.major}.{sys.version_info.minor}).',
        '#',
        '# SPACE is the one omission and it is a measured one, not a guess:',
        '# stripping it fuses adjacent Tailwind class names into runs that trip the',
        '# opaque-literal rule. Point-in-time measurement, on the tree as it stood',
        '# when this was written - web/local 28 findings, web/remote 45. Those',
        '# numbers move whenever the apps gain UI and are recorded to show the cost',
        '# is large and obvious, NOT as a current guarantee; re-measure before',
        '# relying on either figure.',
        '',
        '# Single-byte members, for tr -d.',
        f'INVISIBLE_ASCII={shell_quote_bytes(ascii_bytes)}',
        '',
        '# Multi-byte members as an ERE alternation of raw UTF-8 byte sequences,',
        '# for a single sed pass under LC_ALL=C.',
        f"INVISIBLE_UTF8_RE=$'{alternation}'",
        '',
        f'INVISIBLE_CLASS_SIZE={len(code_points)}',
        f"INVISIBLE_UNICODE_VERSION='{unicodedata.unidata_version}'",
    ]
    return '\n'.join(lines) + '\n'


def parse_committed(text: str) -> set[int]:
    """Recover the class from a generated shell fragment.

    Args:
        text: Contents of invisible-class.sh

    Returns:
        The code points it encodes

    Raises:
        SystemExit: if the file cannot be parsed
    """
    ascii_match = re.search(r"INVISIBLE_ASCII=\$'([^']*)'", text)
    utf8_match = re.search(r"INVISIBLE_UTF8_RE=\$'([^']*)'", text)
    if ascii_match is None or utf8_match is None:
        sys.exit(f'{OUTPUT} does not define INVISIBLE_ASCII and INVISIBLE_UTF8_RE.')

    def unescape(chunk: str) -> bytes:
        return bytes(int(pair, 16) for pair in re.findall(r'\\x([0-9a-fA-F]{2})', chunk))

    found = {byte for byte in unescape(ascii_match.group(1))}
    for sequence in utf8_match.group(1).split('|'):
        if sequence:
            found.add(ord(unescape(sequence).decode('utf-8')))
    return found


def main() -> int:
    """Entry point.

    Returns:
        Process exit code
    """
    if '--check' in sys.argv[1:]:
        if not OUTPUT.exists():
            print(f'{OUTPUT} does not exist; run this generator to create it.', file=sys.stderr)
            return 1

        # Compare the CLASS, not the rendered file. The provenance comment names
        # the Unicode version that produced it, which legitimately differs
        # between a contributor's interpreter and CI's - and a byte comparison
        # would turn that harmless difference into a failed security gate.
        committed = parse_committed(OUTPUT.read_text(encoding='utf-8'))
        derived = set(derive_class())

        # The safety property is one-directional: the committed class must cover
        # everything the local Unicode knows about. Missing a character is the
        # U+0085 gap and fails. Containing EXTRA characters means the file was
        # generated against a newer Unicode than this interpreter has, which is
        # strictly safer - worth saying out loud, not worth blocking on.
        missing = sorted(derived - committed)
        if missing:
            print(
                f'{OUTPUT} is missing {len(missing)} character(s) that Unicode '
                f'{unicodedata.unidata_version} classifies as invisible:\n'
                + '\n'.join(
                    f'    U+{cp:04X} {unicodedata.name(chr(cp), "<unnamed>")}' for cp in missing
                )
                + '\nA literal split by one of these would not be reassembled. Regenerate:\n'
                '  ./scripts/gen-invisible-class.py > scripts/invisible-class.sh',
                file=sys.stderr,
            )
            return 1

        extra = sorted(committed - derived)
        if extra:
            print(
                f'  NOTE: {OUTPUT.name} covers {len(extra)} character(s) unknown to this '
                f'interpreter (Unicode {unicodedata.unidata_version}); it was generated '
                'against a newer release. Superset, so nothing is missed.'
            )
        return 0

    sys.stdout.write(render())
    return 0


if __name__ == '__main__':
    sys.exit(main())
