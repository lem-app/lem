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
    // Allow access from other machines on the network
    host: true,
    port: 5174,
    // Proxy API requests to the backend server
    proxy: {
      '/v1': {
        // Default to localhost, override with VITE_API_TARGET env var
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:5142',
        changeOrigin: true,
      },
    },
    allowedHosts: true
  },
})
