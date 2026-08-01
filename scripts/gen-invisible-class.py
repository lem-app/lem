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
Derive the non-advancing-character class used by check-bundle-secrets.sh.

Writes a shell fragment to stdout; scripts/invisible-class.sh is that output,
committed. The scanner sources it and, on every run, re-derives and compares -
so a Unicode update that adds a character fails a check instead of silently
opening a gap.

WHY THIS EXISTS. The scanner's join pass reassembles a literal that has been
split, so it needs "every character that can sit between two halves without
being content". Four successive versions of that idea each lost to a case
outside it: only "\\n"; then "\\n" plus tab and CR; then every whitespace
character anyone had demonstrated, which still missed U+0085 NEL; then
White_Space plus Cf, which missed category Mn (combining marks - a live,
confirmed separator, since the scanner renders nothing and only needs bytes
outside the credential alphabet).

THE PRINCIPLE, stated so the members follow from it rather than the reverse:
a character can hide a split if it DOES NOT ADVANCE THE CURSOR. That is
exactly Unicode's separators, formats, and marks that combine onto a base:

    White_Space=Yes  union  Cf (format)  union  Mn (nonspacing mark)
                     union  Me (enclosing mark)        minus  U+0020 SPACE

Mn and Me are zero-width BY DEFINITION - they compose onto a preceding base
character - so they belong to "invisible" for a reason that has nothing to do
with which ones a reviewer happened to try. Mc (spacing combining mark) is
excluded: it advances.

U+0020 SPACE is excluded, and that exclusion is measured, not assumed. See the
measurement note in the generated file.

WHY NOT THE FULLY GENERAL RULE. The general case is "a credential-shaped run
interrupted by a short run of characters outside the credential alphabet",
which would cover every separator including ones nobody has thought of. It was
implemented and measured against real builds of both apps, counting extra
opaque-literal findings over baseline, for a minimum context length L on each
side and a maximum gap N:

    L=4    N=1..3     36-65 (web/local)    42-70 (web/remote)
    L=8    N=1..3     10-15                15-19
    L=12   N=1..3      6-8                  9-10
    L=16   N=1..3      3-4                  6
    L=20   N=1..3      0                    1-2

Rejected on those numbers. The only configuration approaching zero is L=20, and
it fails in both directions at once. The residual findings on web/remote are
ordinary minified code whose punctuation was eaten -
`connectAckPromise=nullCONNECT_ACK_TIMEOUT_MS=3e4` - a shape that gets MORE
common as the apps grow. And requiring 20 characters of context on each side
would miss a 32-character secret split evenly in two, which is precisely the
case the join pass exists for. Worse coverage plus a growing false-positive
tax. The derived class costs zero findings and covers its members exactly.

Usage:
    ./scripts/gen-invisible-class.py            # write the fragment to stdout
    ./scripts/gen-invisible-class.py --check    # verify the committed file
"""

import pathlib
import re
import sys
import unicodedata

# Unicode defines White_Space as the separator categories plus these six
# controls. Deriving the rest from category data means a future addition to
# Zs/Zl/Zp is picked up automatically; the cross-check below guards the
# hardcoded half.
WHITESPACE_CONTROLS = frozenset({0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x85})

# str.isspace() is True for White_Space plus these four legacy separators, and
# nothing else. Asserting that relationship checks the derivation against a
# separate implementation inside CPython.
ISSPACE_EXTRAS = frozenset({0x1C, 0x1D, 0x1E, 0x1F})

# Categories that do not advance the cursor.
NON_ADVANCING = ('Zs', 'Zl', 'Zp', 'Cf', 'Mn', 'Me')

# Categories an "extra" member may legitimately have.
#
# Cn/Co/Cs: unassigned here, which is what a future addition looks like from an
# older interpreter.
#
# M*/Cf/Z*: a character some OTHER Unicode version calls non-advancing. These
# happen - CI caught U+1171E AHOM CONSONANT SIGN MEDIAL RA, which is Mn in
# Unicode 15.0.0 and was reclassified to Mc in 16.0.0. Neither version's set is
# a superset of the other, which is why the class is a UNION rather than
# whatever the newest interpreter says (see render()). Stripping a combining
# mark from build output is harmless; failing to strip one is a bypass.
#
# Everything else - letters, digits, punctuation, symbols - is rejected.
# Stripping those would corrupt content, and review showed the previous version
# accepting 'A' as a "harmless superset".
PLAUSIBLE_EXTRA = ('Cn', 'Co', 'Cs', 'Mn', 'Mc', 'Me', 'Cf', 'Zs', 'Zl', 'Zp')

SPACE = 0x20
MAX_CODEPOINT = 0x110000

OUTPUT = pathlib.Path(__file__).with_name('invisible-class.sh')


def derive_white_space() -> frozenset[int]:
    """Code points with Unicode White_Space=Yes.

    Returns:
        The White_Space property set

    Raises:
        SystemExit: if the derivation disagrees with str.isspace()
    """
    separators = {
        cp for cp in range(MAX_CODEPOINT) if unicodedata.category(chr(cp)) in ('Zs', 'Zl', 'Zp')
    }
    white_space = frozenset(separators | WHITESPACE_CONTROLS)

    isspace = {cp for cp in range(MAX_CODEPOINT) if chr(cp).isspace()}
    if isspace != white_space | ISSPACE_EXTRAS:
        sys.exit(
            'White_Space derivation disagrees with str.isspace() on Unicode '
            f'{unicodedata.unidata_version}. Re-read the White_Space definition '
            'before touching this.'
        )
    return white_space


def derive_class() -> list[int]:
    """The non-advancing class, minus SPACE.

    Returns:
        Sorted code points to strip in the join pass
    """
    categorised = {
        cp for cp in range(MAX_CODEPOINT) if unicodedata.category(chr(cp)) in NON_ADVANCING
    }
    return sorted((derive_white_space() | categorised) - {SPACE})


def to_ranges(values: list[int]) -> list[tuple[int, int]]:
    """Collapse a sorted list into inclusive ranges.

    Args:
        values: Sorted, unique integers

    Returns:
        (first, last) pairs
    """
    ranges: list[tuple[int, int]] = []
    for value in values:
        if ranges and value == ranges[-1][1] + 1:
            ranges[-1] = (ranges[-1][0], value)
        else:
            ranges.append((value, value))
    return ranges


def render_ranges(ranges: list[tuple[int, int]]) -> str:
    """Render ranges as the compact hex form stored in the shell fragment.

    Args:
        ranges: Inclusive (first, last) pairs

    Returns:
        Comma-separated "aaaa" or "aaaa-bbbb" items
    """
    return ','.join(f'{lo:x}' if lo == hi else f'{lo:x}-{hi:x}' for lo, hi in ranges)


def parse_ranges(text: str) -> list[int]:
    """Inverse of render_ranges.

    Args:
        text: Comma-separated hex items

    Returns:
        Sorted code points
    """
    out: set[int] = set()
    for item in text.split(','):
        if not item:
            continue
        if '-' in item:
            lo, hi = item.split('-', 1)
            out.update(range(int(lo, 16), int(hi, 16) + 1))
        else:
            out.add(int(item, 16))
    return sorted(out)


def build_regex(code_points: list[int]) -> str:
    """Build the ERE alternation matching the multi-byte members.

    Sequences sharing a UTF-8 prefix and differing only in their final byte are
    emitted as one bracket expression, which keeps a ~2000-member class down to
    a regex sed can compile and run quickly. Final bytes of multi-byte UTF-8 are
    always 0x80-0xBF, so a bracket range can never capture ']', '^' or '-'.

    Args:
        code_points: Sorted code points; ASCII members are ignored here

    Returns:
        An alternation of \\xNN escapes, for bash $'...' interpolation
    """
    groups: dict[bytes, list[int]] = {}
    for cp in code_points:
        if cp < 0x80:
            continue
        encoded = chr(cp).encode('utf-8')
        groups.setdefault(encoded[:-1], []).append(encoded[-1])

    def esc(raw: bytes) -> str:
        return ''.join(f'\\x{byte:02x}' for byte in raw)

    alternatives: list[str] = []
    for prefix in sorted(groups):
        for lo, hi in to_ranges(sorted(groups[prefix])):
            if lo == hi:
                alternatives.append(esc(prefix) + esc(bytes([lo])))
            else:
                alternatives.append(f'{esc(prefix)}[{esc(bytes([lo]))}-{esc(bytes([hi]))}]')
    return '|'.join(alternatives)


def build_ascii(code_points: list[int]) -> str:
    """Render the single-byte members for `tr -d`.

    Args:
        code_points: Sorted code points

    Returns:
        A \\xNN escape sequence string
    """
    return ''.join(f'\\x{cp:02x}' for cp in code_points if cp < 0x80)


def build_canary_separators(code_points: list[int]) -> list[str]:
    """One representative multi-byte member per emitted regex alternative.

    The self-test plants a split canary for each of these. Testing every one of
    the ~2200 members would dominate the scanner's runtime for no extra signal:
    the alternative is the unit that can actually break, since each is a
    separate branch of the compiled regex, and a broken branch takes its whole
    byte range with it. Emitting them here rather than parsing byte ranges back
    out in bash keeps the shell free of UTF-8 arithmetic.

    Args:
        code_points: Sorted code points

    Returns:
        \\xNN escape strings, one per alternative
    """
    groups: dict[bytes, list[int]] = {}
    for cp in code_points:
        if cp < 0x80:
            continue
        encoded = chr(cp).encode('utf-8')
        groups.setdefault(encoded[:-1], []).append(encoded[-1])

    separators: list[str] = []
    for prefix in sorted(groups):
        for lo, _hi in to_ranges(sorted(groups[prefix])):
            raw = prefix + bytes([lo])
            separators.append(''.join(f'\\x{byte:02x}' for byte in raw))
    return separators


def committed_class() -> list[int]:
    """The class as currently committed, or empty if there is none.

    Returns:
        Sorted code points
    """
    if not OUTPUT.exists():
        return []
    found = re.search(r"INVISIBLE_RANGES='([^']*)'", OUTPUT.read_text(encoding='utf-8'))
    return parse_ranges(found.group(1)) if found else []


def render() -> str:
    """Build the shell fragment.

    The class is MONOTONE: whatever is already committed is unioned in rather
    than replaced. Unicode reclassifies characters between releases in both
    directions - U+1171E is Mn in 15.0.0 and Mc in 16.0.0 - so "regenerate on
    the newest interpreter" would silently drop members that an older one still
    considers non-advancing. Losing a member is a bypass; keeping a spurious one
    costs nothing measurable, because a combining mark never legitimately
    appears inside a credential run.

    Returns:
        The complete file contents
    """
    code_points = sorted(set(derive_class()) | set(committed_class()))
    lines = [
        '# SPDX-License-Identifier: AGPL-3.0-or-later',
        '# Copyright (c) 2025 Lem',
        '#',
        '# GENERATED FILE - DO NOT EDIT BY HAND.',
        '# Regenerate with: ./scripts/gen-invisible-class.py > scripts/invisible-class.sh',
        '#',
        '# Characters that do not advance the cursor, and so can hide a split inside a',
        '# credential: Unicode White_Space=Yes plus general categories Cf, Mn and Me,',
        f'# minus U+0020 SPACE. {len(code_points)} code points, derived from Unicode',
        f'# {unicodedata.unidata_version}. See gen-invisible-class.py for the reasoning,',
        '# including the measurements that rejected the fully general "short gap',
        '# between long runs" rule.',
        '#',
        '# SPACE is the one omission and it is measured, not guessed: stripping it',
        '# fuses adjacent Tailwind class names into runs that trip the opaque-literal',
        '# rule. Point-in-time measurement on the tree as it stood when this was',
        '# written - web/local 28 findings, web/remote 45. Those numbers move whenever',
        '# the apps gain UI; they are recorded to show the cost is large and obvious,',
        '# NOT as a current guarantee. Re-measure before relying on either figure.',
        '',
        '# Canonical membership, as hex code-point ranges. This is what --check',
        '# verifies and what the self-test enumerates; the two compiled forms below',
        '# are built from it and checked against it.',
        f"INVISIBLE_RANGES='{render_ranges(to_ranges(code_points))}'",
        '',
        '# Single-byte members, for tr -d.',
        f"INVISIBLE_ASCII=$'{build_ascii(code_points)}'",
        '',
        '# Multi-byte members as an ERE alternation of raw UTF-8 byte sequences,',
        '# for a single sed pass under LC_ALL=C.',
        f"INVISIBLE_UTF8_RE=$'{build_regex(code_points)}'",
        '',
        '# One representative member per regex alternative, for the self-test to plant',
        '# split canaries with. See build_canary_separators() for why per-alternative',
        '# rather than per-code-point.',
        'INVISIBLE_CANARY_SEPS=(',
    ]
    lines += [f"  $'{sep}'" for sep in build_canary_separators(code_points)]
    lines += [
        ')',
        '',
        f'INVISIBLE_CLASS_SIZE={len(code_points)}',
        f"INVISIBLE_UNICODE_VERSION='{unicodedata.unidata_version}'",
    ]
    return '\n'.join(lines) + '\n'


def check() -> int:
    """Verify the committed fragment against Unicode and against itself.

    Returns:
        Process exit code
    """
    if not OUTPUT.exists():
        print(f'{OUTPUT} does not exist; run this generator to create it.', file=sys.stderr)
        return 1
    text = OUTPUT.read_text(encoding='utf-8')

    ranges_match = re.search(r"INVISIBLE_RANGES='([^']*)'", text)
    regex_match = re.search(r"INVISIBLE_UTF8_RE=\$'([^']*)'", text)
    ascii_match = re.search(r"INVISIBLE_ASCII=\$'([^']*)'", text)
    if ranges_match is None or regex_match is None or ascii_match is None:
        print(f'{OUTPUT} is missing one of its generated variables.', file=sys.stderr)
        return 1

    committed = parse_ranges(ranges_match.group(1))
    derived = derive_class()

    # One-directional on purpose: the committed class must cover everything the
    # local Unicode knows about. A character it lacks is the U+0085 gap.
    missing = sorted(set(derived) - set(committed))
    if missing:
        print(
            f'{OUTPUT} is missing {len(missing)} character(s) that Unicode '
            f'{unicodedata.unidata_version} treats as non-advancing:\n'
            + '\n'.join(
                f'    U+{cp:04X} {unicodedata.name(chr(cp), "<unnamed>")}' for cp in missing[:20]
            )
            + '\nA literal split by one of these would not be reassembled. Regenerate:\n'
            '  ./scripts/gen-invisible-class.py > scripts/invisible-class.sh',
            file=sys.stderr,
        )
        return 1

    # Extras are tolerated - the file may have been generated against a newer
    # Unicode than this interpreter has - but NOT unconditionally. Review showed
    # the previous version accepting 'A' as a "harmless superset". Anything this
    # interpreter can classify as a real, advancing character is not a plausible
    # future member, and stripping it would corrupt content.
    extras = sorted(set(committed) - set(derived))
    implausible = [cp for cp in extras if unicodedata.category(chr(cp)) not in PLAUSIBLE_EXTRA]
    if implausible:
        print(
            f'{OUTPUT} contains {len(implausible)} character(s) that Unicode '
            f'{unicodedata.unidata_version} says are ordinary content, so they cannot '
            'be members of this class under any reading:\n'
            + '\n'.join(
                f'    U+{cp:04X} category {unicodedata.category(chr(cp))} '
                f'{unicodedata.name(chr(cp), "<unnamed>")}'
                for cp in implausible[:20]
            )
            + '\nStripping those from build output would corrupt it. Regenerate.',
            file=sys.stderr,
        )
        return 1
    if extras:
        print(
            f'  NOTE: {OUTPUT.name} carries {len(extras)} code point(s) this interpreter '
            f'(Unicode {unicodedata.unidata_version}) does not class as non-advancing - '
            'unassigned here, or reclassified between releases. The class is a union '
            'across versions, so this is expected; nothing is missed.'
        )

    # The regex and the tr set are compiled artefacts of the canonical ranges.
    # Rebuild both from the COMMITTED ranges - not from local Unicode - so this
    # catches hand-editing without being sensitive to the interpreter's version.
    if regex_match.group(1) != build_regex(committed):
        print(
            f'{OUTPUT}: INVISIBLE_UTF8_RE does not match INVISIBLE_RANGES. The regex was '
            'hand-edited, or the file is half-regenerated.',
            file=sys.stderr,
        )
        return 1
    if ascii_match.group(1) != build_ascii(committed):
        print(
            f'{OUTPUT}: INVISIBLE_ASCII does not match INVISIBLE_RANGES.',
            file=sys.stderr,
        )
        return 1

    committed_seps = re.findall(r"^  \$'([^']*)'$", text, re.MULTILINE)
    if committed_seps != build_canary_separators(committed):
        print(
            f'{OUTPUT}: INVISIBLE_CANARY_SEPS does not match INVISIBLE_RANGES, so the '
            'self-test would not exercise every branch of the regex.',
            file=sys.stderr,
        )
        return 1

    return 0


def main() -> int:
    """Entry point.

    Returns:
        Process exit code
    """
    if '--check' in sys.argv[1:]:
        return check()
    sys.stdout.write(render())
    return 0


if __name__ == '__main__':
    sys.exit(main())
