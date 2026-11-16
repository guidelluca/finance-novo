import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

// GitHub Pages publica em /<repositório>/ — o workflow define VITE_BASE=/finance-novo/
const base = process.env.VITE_BASE || '/'

export default defineConfig({
  base,
  server: {
    // Escuta em todas as interfaces — permite abrir no telemóvel via IP da rede (mesmo Wi‑Fi).
    host: true,
    port: 5173,
  },
  build: {
    chunkSizeWarningLimit: 1600,
  },
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      workbox: {
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      manifest: {
        name: 'Finanças',
        short_name: 'Finanças',
        description: 'Controle financeiro mensal',
        theme_color: '#14161a',
        background_color: '#f2f3ee',
        display: 'standalone',
        start_url: base,
        scope: base,
        lang: 'pt-BR',
        icons: [
          { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: `${base}icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: `${base}favicon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
