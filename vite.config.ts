import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // The frontend must never load the backend's .env file.
  envDir: false,
  envPrefix: [],
  publicDir: false,
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem}',
        '**/.git/**',
        '**/server/**',
        '**/tests/**',
        '**/dist-server/**',
      ],
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
  },
})
