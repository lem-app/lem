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
    // Loopback by default; `pnpm run dev:lan` passes --host when LAN access is
    // wanted. `pnpm run dev` used to bind 0.0.0.0 unconditionally.
    host: '127.0.0.1',
    port: 5173,
  },
})
