import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { AGENT_API_PORT, PLAYGROUND_WORKSPACE_ROOT, VITE_PORT, startBoringMailPlaygroundServer } from './src/server/dev'
import { createStandaloneHostAuth, resolveStandaloneDeploymentConfig } from './src/server/standaloneHostAuth'

const fsAllow = [
  resolve(__dirname),
  resolve(__dirname, '../boring-mail'),
  // published @hachej deps live in the workspace-root node_modules
  resolve(__dirname, '..'),
]

export default defineConfig(({ command }) => {
  if (command !== 'serve') {
    return {
      plugins: [react()],
      server: { fs: { allow: fsAllow } },
    }
  }

  const deployment = resolveStandaloneDeploymentConfig({
    backendPort: AGENT_API_PORT,
    defaultVitePort: VITE_PORT,
    defaultWorkspaceRoot: PLAYGROUND_WORKSPACE_ROOT,
  })
  const hostAuth = createStandaloneHostAuth(deployment)

  return {
    plugins: [
      hostAuth.plugins[0],
      react(),
      {
        name: 'boring-mail-agent-backend',
        async configureServer() {
          await startBoringMailPlaygroundServer({
            browserAuthPolicy: hostAuth.browserAuthPolicy,
            deployment,
          })
        },
      },
      hostAuth.plugins[1],
    ],
    server: {
      ...hostAuth.viteServer,
      fs: { allow: fsAllow },
    },
  }
})
