// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025 Lem
//
// This file is part of Lem.
//
// Lem is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Lem is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General
// Public License for more details.

// The off switch for the credential prompt's "remember on this device".
//
// Without it that opt-in is one-way: tick the box on a shared or borrowed
// machine and the session token sits in localStorage, surviving tab closes and
// restarts, with no way to get it out from inside the product. One control, no
// settings panel - it appears only while a credential is actually held, so the
// loopback case (where the API asks for nothing) never sees it.

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { LogOut } from 'lucide-react'

import { endSession, readSessionToken, subscribeToSessionToken } from '@/api/session'
import { Button } from '@/components/ui/button'

export function SessionStatus(): ReactElement | null {
  const [token, setToken] = useState<string | null>(() => readSessionToken())
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => subscribeToSessionToken(setToken), [])

  if (token === null) {
    return null
  }

  async function handleSignOut(): Promise<void> {
    setSigningOut(true)
    try {
      // Never rejects: endSession drops the local copy before it talks to the
      // server, and swallows the revoke failing.
      await endSession()
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={signingOut}
      onClick={() => {
        void handleSignOut()
      }}
    >
      <LogOut />
      {signingOut ? 'Signing out...' : 'Sign out'}
    </Button>
  )
}
