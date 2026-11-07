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
      includeAssets: ['favicon.svg'],
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
          {
            src: `${base}favicon.svg`,
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
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
