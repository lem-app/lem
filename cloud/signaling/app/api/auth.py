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

"""Authentication endpoints."""

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, status

from ..core.security import create_access_token, get_password_hash, verify_password
from ..db import get_db
from ..models import Token, UserCreate, UserLogin

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=Token, status_code=status.HTTP_201_CREATED)
async def register(
    user_data: UserCreate, db: aiosqlite.Connection = Depends(get_db)
) -> Token:
    """Register a new user.

    Args:
        user_data: User registration data.
        db: Database connection.

    Returns:
        JWT access token.

    Raises:
        HTTPException: If user already exists.
    """
    # Check if user already exists
    async with db.execute("SELECT id FROM users WHERE email = ?", (user_data.email,)) as cursor:
        existing_user = await cursor.fetchone()
        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered",
            )

    # Create new user
    hashed_password = get_password_hash(user_data.password)
    async with db.execute(
        "INSERT INTO users (email, hashed_password) VALUES (?, ?)",
        (user_data.email, hashed_password),
    ) as cursor:
        user_id = cursor.lastrowid

    await db.commit()

    # Create access token
    access_token = create_access_token(data={"sub": user_data.email, "user_id": user_id})

    return Token(access_token=access_token)


@router.post("/login", response_model=Token)
async def login(credentials: UserLogin, db: aiosqlite.Connection = Depends(get_db)) -> Token:
    """Login and get access token.

    Args:
        credentials: User login credentials.
        db: Database connection.

    Returns:
        JWT access token.

    Raises:
        HTTPException: If credentials are invalid.
    """
    # Get user from database
    async with db.execute(
        "SELECT id, email, hashed_password FROM users WHERE email = ?",
        (credentials.email,),
    ) as cursor:
        user = await cursor.fetchone()

    if not user or not verify_password(credentials.password, user["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Create access token
    access_token = create_access_token(data={"sub": user["email"], "user_id": user["id"]})

    return Token(access_token=access_token)
