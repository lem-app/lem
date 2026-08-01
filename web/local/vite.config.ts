import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Loopback only, on purpose.
    //
    // This dev server proxies /v1/* straight to the local Lem API, which can
    // install, start and stop Docker containers with no authentication of its
    // own. Binding to 0.0.0.0 (`host: true`, the previous default) therefore
    // handed container control to anyone who could reach this machine's port
    // 5174 - every device on the coffee-shop wifi included.
    //
    // Use `pnpm run dev:lan` (which passes --host) when you actually want LAN
    // access and understand what you are exposing.
    host: '127.0.0.1',
    port: 5174,
    // Proxy API requests to the backend server
    proxy: {
      '/v1': {
        // Default to localhost, override with VITE_API_TARGET env var
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:5142',
        changeOrigin: true,
      },
    },
  },
})
