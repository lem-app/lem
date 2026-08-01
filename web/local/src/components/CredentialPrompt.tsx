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

// Runtime credential entry for the local dashboard (issue #48).
//
// Not a login page and not a route: Lem's local API has exactly one principal,
// the machine's operator. This is a 401 handler with a text box. It appears
// when a request is refused and disappears when one succeeds, so the dashboard
// keeps working unchanged on a loopback bind where no credential is required.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { AlertCircle } from 'lucide-react'

import { ApiError } from '@/api/http'
import {
  exchangeRootToken,
  resolveCredentialRequest,
  subscribeToCredentialPrompt,
} from '@/api/session'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export const TOKEN_PATH = '~/.lem/api_token'

export function CredentialPrompt(): ReactElement {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)
  const [hasValue, setHasValue] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Uncontrolled on purpose. The root token is full Docker control; holding it
  // in React state would keep it in a fiber for as long as this component is
  // mounted, and in every render closure along the way. The DOM node is the
  // only place it lives, and it is wiped the moment the form is submitted.
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(
    () =>
      subscribeToCredentialPrompt(() => {
        setOpen(true)
        // "Unchecked by default" means every prompt, not just the first. This
        // component stays mounted across sign-out and re-prompt, so without
        // this an earlier tick would silently carry into the next credential.
        setRemember(false)
      }),
    []
  )

  const handleOpenChange = useCallback((next: boolean): void => {
    if (next) {
      return
    }
    // Dismissed - escape, overlay click, or the close button. Every request
    // waiting on this prompt gets its 401 back rather than hanging.
    setOpen(false)
    setError(null)
    resolveCredentialRequest(null)
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    const input = inputRef.current
    if (input === null) {
      return
    }

    const rootToken = input.value.trim()
    // Wipe the field before anything can await: the token must not sit in the
    // DOM across a network round-trip, and must not survive this handler.
    input.value = ''
    setHasValue(false)

    if (rootToken === '') {
      setError(`Paste the contents of ${TOKEN_PATH}.`)
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const sessionToken = await exchangeRootToken(rootToken, remember)
      setOpen(false)
      resolveCredentialRequest(sessionToken)
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 401
          ? `That token was not accepted. Check the contents of ${TOKEN_PATH}.`
          : caught instanceof Error
            ? caught.message
            : 'The credential exchange failed.'
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Lem needs your API token</DialogTitle>
          <DialogDescription>
            This server requires a credential. Paste the contents of{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{TOKEN_PATH}</code> on
            the machine running Lem. The server logs that path on startup, and the file is readable
            only by your user account.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            void handleSubmit(event)
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="lem-api-token">API token</Label>
            <Input
              id="lem-api-token"
              ref={inputRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your token"
              disabled={submitting}
              onChange={(event) => setHasValue(event.target.value.trim() !== '')}
            />
            <p className="text-xs text-muted-foreground">
              The token you paste is exchanged for a temporary session token and is not stored. Only
              the session token is kept, and it expires after 12 hours.
            </p>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="lem-remember"
              checked={remember}
              disabled={submitting}
              onCheckedChange={(checked) => setRemember(checked === true)}
            />
            <div className="space-y-1">
              <Label htmlFor="lem-remember" className="cursor-pointer">
                Remember on this device
              </Label>
              <p className="text-xs text-muted-foreground">
                Off by default: the session token lives in this tab only and is gone when you close
                it. Turning this on keeps it in this browser profile until it expires.
              </p>
            </div>
          </div>

          {error !== null && (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={submitting || !hasValue}>
              {submitting ? 'Connecting...' : 'Connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
