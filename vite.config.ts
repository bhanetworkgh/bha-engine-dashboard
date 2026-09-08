import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// In development the front end runs on Vite and /api is proxied to the
// server (npm run dev:server, port 8787). In production the server serves
// dist/ itself, so both live on one origin and the session cookie is
// first-party.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: process.env.API_PROXY ?? 'http://localhost:8787', changeOrigin: false },
    },
  },
})
