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
Simple test script to verify database operations.
Run: uv run python test_db.py
"""

import sys
from pathlib import Path

from app.db import (
    DB_PATH,
    delete_auth_state,
    delete_device,
    delete_setting,
    get_auth_state,
    get_device,
    get_setting,
    init_db,
    register_device,
    set_auth_state,
    set_setting,
)


def main() -> None:
    """Test all database operations."""
    print("=" * 60)
    print("Testing Lem Database (v0.1)")
    print("=" * 60)

    # 1. Initialize database
    print("\n[1/9] Initializing database...")
    init_db()
    print(f"✓ Database created at: {DB_PATH}")
    assert DB_PATH.exists(), "Database file not found!"

    # 2. Test settings table - set
    print("\n[2/9] Testing settings table (set)...")
    set_setting("test_key", "test_value")
    print("✓ Setting saved")

    # 3. Test settings table - get
    print("\n[3/9] Testing settings table (get)...")
    value = get_setting("test_key")
    assert value == "test_value", f"Expected 'test_value', got '{value}'"
    print(f"✓ Setting retrieved: {value}")

    # 4. Test settings table - update
    print("\n[4/9] Testing settings table (update)...")
    set_setting("test_key", "updated_value")
    value = get_setting("test_key")
    assert value == "updated_value", f"Expected 'updated_value', got '{value}'"
    print(f"✓ Setting updated: {value}")

    # 5. Test settings table - delete
    print("\n[5/9] Testing settings table (delete)...")
    delete_setting("test_key")
    value = get_setting("test_key")
    assert value is None, f"Expected None, got '{value}'"
    print("✓ Setting deleted")

    # 6. Test device table - register
    print("\n[6/9] Testing device table (register)...")
    device = register_device(
        device_id="test-device-123", pubkey="ed25519:abcd1234"
    )
    print(f"✓ Device registered: {device.to_dict()}")

    # 7. Test device table - get
    print("\n[7/9] Testing device table (get)...")
    retrieved_device = get_device()
    assert retrieved_device is not None, "Device not found!"
    assert retrieved_device.id == "test-device-123", "Device ID mismatch!"
    print(f"✓ Device retrieved: {retrieved_device.to_dict()}")

    # 8. Test auth table
    print("\n[8/9] Testing auth table...")
    auth_json = '{"token": "jwt-token-here", "expires_at": "2025-12-31T23:59:59Z"}'
    set_auth_state(auth_json)
    retrieved_auth = get_auth_state()
    assert retrieved_auth == auth_json, "Auth state mismatch!"
    print(f"✓ Auth state saved and retrieved: {retrieved_auth[:50]}...")

    # 9. Cleanup
    print("\n[9/9] Cleaning up test data...")
    delete_auth_state()
    delete_device()
    print("✓ Cleanup complete")

    print("\n" + "=" * 60)
    print("✅ All database tests passed!")
    print("=" * 60)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n❌ Test failed: {e}", file=sys.stderr)
        sys.exit(1)
