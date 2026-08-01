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

"""Pins the *string* behaviour of our string-valued enums.

`class X(str, Enum)` and `class X(StrEnum)` differ in exactly one respect:
`str()` / f-string / `%s` / `.format()` render `"X.MEMBER"` for the former and
the member's *value* for the latter. Everything else -- `==` against a plain
str, dict/set membership, `json.dumps`, and Pydantic serialisation (which goes
via `.value`) -- is identical.

That asymmetry is why swapping an enum's base is a silent change: the wire
format and the whole test suite stay green while log lines and any
string-formatted output flip. These tests make the swap fail loudly instead.

See ruff's UP042, which suggests `StrEnum` for every `(str, Enum)` class and
classifies its own fix as *unsafe* for this reason.
"""

from __future__ import annotations

import json
from enum import Enum, StrEnum

import pytest

from app.catalog.models import ServiceCategory, ServiceStatus
from app.jobs.models import JobStatus, JobType
from app.tunnel.relay_client import RelayConnectionState
from app.tunnel.webrtc_client import ConnectionState

# Enums converted to StrEnum: no call site formats a member without `.value`,
# so rendering the bare value is safe and is what we now rely on.
STR_ENUM_MEMBERS: list[Enum] = [
    ServiceCategory.BACKEND,
    ServiceStatus.NOT_INSTALLED,
    JobStatus.PENDING,
    JobType.INSTALL,
]

# Enums deliberately left as `(str, Enum)`, carrying a UP042 suppression: their
# members are interpolated bare into operator-facing log lines, which expect the
# qualified `Class.MEMBER` form.
QUALIFIED_MEMBERS: list[tuple[Enum, str]] = [
    (ConnectionState.CONNECTED, "ConnectionState.CONNECTED"),
    (RelayConnectionState.CONNECTED, "RelayConnectionState.CONNECTED"),
]

ALL_MEMBERS: list[Enum] = [m for m, _ in QUALIFIED_MEMBERS] + STR_ENUM_MEMBERS


class TestStrEnumsRenderTheirValue:
    """`str()`/f-string on a converted enum yields the value, not `Class.MEMBER`."""

    @pytest.mark.parametrize("member", STR_ENUM_MEMBERS)
    def test_str_is_the_value(self, member: Enum) -> None:
        assert str(member) == member.value

    @pytest.mark.parametrize("member", STR_ENUM_MEMBERS)
    def test_fstring_is_the_value(self, member: Enum) -> None:
        assert f"{member}" == member.value

    @pytest.mark.parametrize("member", STR_ENUM_MEMBERS)
    def test_percent_and_format_are_the_value(self, member: Enum) -> None:
        # `%` and `.format()` are the point of this test -- they are two of the
        # four renderings that change with the enum base -- so the lint rules
        # that would rewrite them into f-strings are suppressed here.
        assert "%s" % member == member.value  # noqa: UP031
        assert "{}".format(member) == member.value  # noqa: UP032

    @pytest.mark.parametrize("member", STR_ENUM_MEMBERS)
    def test_declared_as_strenum(self, member: Enum) -> None:
        """A regression to `(str, Enum)` reintroduces the `Class.MEMBER` form."""
        assert isinstance(member, StrEnum)
        assert "." not in str(member)


class TestQualifiedEnumsKeepClassPrefix:
    """The tunnel state enums must keep rendering as `Class.MEMBER` in logs.

    `webrtc_client._set_state` and `relay_client._set_state` interpolate these
    bare; `manager.on_state_change` and `webrtc_client._on_relay_state_change`
    do too. Converting them to `StrEnum` would rewrite those log lines.
    """

    @pytest.mark.parametrize(("member", "expected"), QUALIFIED_MEMBERS)
    def test_str_is_qualified(self, member: Enum, expected: str) -> None:
        assert str(member) == expected

    @pytest.mark.parametrize(("member", "expected"), QUALIFIED_MEMBERS)
    def test_fstring_is_qualified(self, member: Enum, expected: str) -> None:
        assert f"{member}" == expected

    @pytest.mark.parametrize(("member", "_expected"), QUALIFIED_MEMBERS)
    def test_str_mixin_is_retained(self, member: Enum, _expected: str) -> None:
        """The `str` mixin is load-bearing for comparisons; don't drop it."""
        assert isinstance(member, str)
        assert not isinstance(member, StrEnum)


class TestWireFormatIsBaseIndependent:
    """Serialisation and comparison must not depend on which base the enum uses.

    These hold for `(str, Enum)` and `StrEnum` alike -- that is precisely why a
    green suite cannot, on its own, catch a base swap.
    """

    @pytest.mark.parametrize("member", ALL_MEMBERS)
    def test_json_dumps_emits_the_value(self, member: Enum) -> None:
        assert json.loads(json.dumps(member)) == member.value

    @pytest.mark.parametrize("member", ALL_MEMBERS)
    def test_equals_its_plain_string_value(self, member: Enum) -> None:
        assert member == member.value

    @pytest.mark.parametrize("member", ALL_MEMBERS)
    def test_interchangeable_as_dict_key_and_set_entry(self, member: Enum) -> None:
        value = member.value
        assert {member: 1}[value] == 1
        assert value in {member}
