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

// Lem Local Dashboard v0.1
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import { ServicesList } from './components/ServicesList'
import { ModelPull } from './components/ModelPull'
import { RemoteAccess } from './components/RemoteAccess'

// Create a client for React Query
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

function App(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card px-6 py-4">
          <div className="text-center">
            <h1 className="text-2xl font-bold">Lem Dashboard</h1>
            <p className="text-sm text-muted-foreground">Local AI Infrastructure Manager</p>
          </div>
        </header>

        <main className="mx-auto max-w-7xl space-y-12 p-8">
          <section>
            <RemoteAccess />
          </section>

          <section>
            <ServicesList />
          </section>

          <section>
            <ModelPull runnerId="ollama" runnerName="Ollama" />
          </section>
        </main>

        {/*
          react-hot-toast renders outside the component tree, so it is styled
          through className rather than Tailwind utilities on a JSX element.
          These are theme tokens, not the hardcoded hex colours that used to be
          here and ignored light/dark entirely.
        */}
        <Toaster
          position="bottom-right"
          toastOptions={{
            duration: 4000,
            className: '!bg-card !text-card-foreground !border !border-border !shadow-lg',
            success: { className: '!bg-card !text-card-foreground !border !border-border' },
            error: {
              className: '!bg-destructive !text-destructive-foreground !border !border-destructive',
            },
          }}
        />
      </div>
    </QueryClientProvider>
  )
}

export default App
