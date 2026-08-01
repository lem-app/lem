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

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ..core.ratelimit import (
    client_ip,
    login_account_limiter,
    login_ip_limiter,
    register_limiter,
)
from ..core.security import create_access_token, get_password_hash, verify_password
from ..db import USE_POSTGRES, DBConnection, DBRow, as_postgres, as_sqlite, get_db
from ..models import Token, UserCreate, UserLogin

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)

_RATE_LIMITED = "Too many requests. Try again later."


@router.post("/register", response_model=Token, status_code=status.HTTP_201_CREATED)
async def register(
    user_data: UserCreate, request: Request, db: DBConnection = Depends(get_db)
) -> Token:
    """Register a new user.

    Args:
        user_data: User registration data.
        request: Incoming request, used to identify the caller for throttling.
        db: Database connection.

    Returns:
        JWT access token.

    Raises:
        HTTPException: If user already exists or the caller is rate limited.
    """
    # Registration is unauthenticated, so without a limit a single host can
    # mint unlimited accounts, and an account is all it takes to reach the
    # tunnel endpoints.
    source = client_ip(request)
    if not register_limiter.check(source):
        logger.warning(f"Registration rate limit exceeded for {source}")
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=_RATE_LIMITED
        )

    user_id: int | None
    if USE_POSTGRES:
        # PostgreSQL syntax
        pg = as_postgres(db)
        existing_user = await pg.fetchrow(
            "SELECT id FROM users WHERE email = $1", user_data.email
        )
        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered",
            )

        # Create new user with RETURNING
        hashed_password = get_password_hash(user_data.password)
        row = await pg.fetchrow(
            "INSERT INTO users (email, hashed_password) VALUES ($1, $2) RETURNING id",
            user_data.email,
            hashed_password,
        )
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create user",
            )
        user_id = row["id"]
    else:
        # SQLite syntax
        sqlite = as_sqlite(db)
        async with sqlite.execute(
            "SELECT id FROM users WHERE email = ?", (user_data.email,)
        ) as cursor:
            existing_user = await cursor.fetchone()
            if existing_user:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Email already registered",
                )

        # Create new user
        hashed_password = get_password_hash(user_data.password)
        async with sqlite.execute(
            "INSERT INTO users (email, hashed_password) VALUES (?, ?)",
            (user_data.email, hashed_password),
        ) as cursor:
            user_id = cursor.lastrowid

        await sqlite.commit()

    # Create access token
    access_token = create_access_token(data={"sub": user_data.email, "user_id": user_id})

    return Token(access_token=access_token)


@router.post("/login", response_model=Token)
async def login(
    credentials: UserLogin, request: Request, db: DBConnection = Depends(get_db)
) -> Token:
    """Login and get access token.

    Args:
        credentials: User login credentials.
        request: Incoming request, used to identify the caller for throttling.
        db: Database connection.

    Returns:
        JWT access token.

    Raises:
        HTTPException: If credentials are invalid or the caller is rate limited.
    """
    # Throttle per source address and per targeted account: the first stops one
    # host spraying many accounts, the second stops a botnet brute-forcing one.
    source = client_ip(request)
    account = credentials.email.lower()
    if not login_ip_limiter.check(source) or not login_account_limiter.check(account):
        logger.warning(f"Login rate limit exceeded for {source}")
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=_RATE_LIMITED
        )

    user: DBRow | None
    if USE_POSTGRES:
        # PostgreSQL syntax
        user = await as_postgres(db).fetchrow(
            "SELECT id, email, hashed_password FROM users WHERE email = $1",
            credentials.email,
        )
    else:
        # SQLite syntax
        async with as_sqlite(db).execute(
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
