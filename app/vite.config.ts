import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { AGENT_API_PORT, VITE_PORT, startBoringMailPlaygroundServer } from './src/server/dev'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'boring-mail-agent-backend',
      async configureServer() {
        await startBoringMailPlaygroundServer()
      },
    },
  ],
  server: {
    port: VITE_PORT,
    host: true,
    hmr: {
      host: process.env.VITE_HMR_HOST ?? '100.68.199.114',
      clientPort: Number(process.env.VITE_HMR_CLIENT_PORT ?? VITE_PORT),
    },
    fs: {
      allow: [
        resolve(__dirname),
        resolve(__dirname, '../boring-mail'),
        resolve(__dirname, '../../boring-ui-v2-775-pr811-final'),
      ],
    },
    proxy: {
      '/api/v1': `http://127.0.0.1:${AGENT_API_PORT}`,
      '/api/boring-mail': `http://127.0.0.1:${AGENT_API_PORT}`,
    },
  },
})
