// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('@hachej/boring-workspace 0.1.103 host contract tripwire', () => {
  it('pins the trusted bridge and browser provider assumptions used by Boring Mail standalone auth', () => {
    const serverJsPath = require.resolve('@hachej/boring-workspace/server')
    const packageRoot = serverJsPath.replace(/\/dist\/server\.js$/, '')
    const packageJsonPath = `${packageRoot}/package.json`
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string; exports?: Record<string, unknown> }
    expect(packageJson.version).toBe('0.1.103')
    expect(packageJson.exports).toHaveProperty('./server')
    expect(packageJson.exports).toHaveProperty('./plugin')

    const appPackageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts?: Record<string, string> }
    expect(appPackageJson.scripts?.dev).toBe('vite')

    const serverTypes = [
      readFileSync(`${packageRoot}/dist/server.d.ts`, 'utf8'),
      readFileSync(`${packageRoot}/dist/runtimeEnv-B1AfbgTN.d.ts`, 'utf8'),
    ].join('\n')
    expect(serverTypes).toContain('declare function defineTrustedDomainBridgeHandler')
    for (const requiredBridgeShape of [
      'op: string;',
      'version: number;',
      'owner: string;',
      'callerClassesAllowed: readonly BridgeCallerClass[];',
      'requiredCapabilities: readonly string[];',
      'inputSchema: unknown;',
      'maxInputBytes?: number;',
      'maxOutputBytes: number;',
      'handler: WorkspaceBridgeHandler<TInput, TOutput>;',
      'declare function createBrowserBridgeAuthPolicy',
      'getPrincipal(input: BridgeAuthPolicyInput)',
      'authorizeWorkspace(input: {',
      'allowedOrigins?: readonly string[];',
      'requireCsrfHeader?: boolean;',
    ]) {
      expect(serverTypes).toContain(requiredBridgeShape)
    }

    const serverRuntime = readFileSync(serverJsPath, 'utf8')
    expect(serverRuntime).toContain('app.post("/api/v1/workspace-bridge/call"')
    expect(serverRuntime).toContain('const workspaceId = firstHeader')
    expect(serverRuntime).toContain('?? "default"')
    expect(serverRuntime).toContain('options.allowedOrigins.includes(origin)')
    expect(serverRuntime).toContain('firstHeader(input.request?.headers, "x-csrf-token")')

    const askUserPackageJsonPath = require.resolve('@hachej/boring-ask-user/package.json')
    const askUserPackageRoot = askUserPackageJsonPath.replace(/\/package\.json$/, '')
    const askUserPackageJson = JSON.parse(readFileSync(askUserPackageJsonPath, 'utf8')) as { version?: string }
    expect(askUserPackageJson.version).toBe('0.1.103')
    const askUserShared = readFileSync(`${askUserPackageRoot}/dist/shared/index.js`, 'utf8')
    expect(askUserShared).toContain('answer: "ask-user:answer"')
    expect(askUserShared).toContain('cancel: "ask-user:cancel"')
    expect(askUserShared).toContain('pending: "ask-user:pending"')
    expect(askUserShared).toContain('request: "ask-user:request"')
    expect(askUserShared).toContain('transcriptRead: "ask-user:transcript.read"')

    const pluginTypes = readFileSync(`${packageRoot}/dist/plugin.d.ts`, 'utf8')
    for (const providerProp of [
      'interface PluginProviderProps',
      'agentTypeId: string;',
      'apiBaseUrl: string;',
      'authHeaders?: Record<string, string>;',
      'authScopeKey?: string;',
      'onAuthError?: (statusCode: number) => void;',
      'apiTimeout?: number;',
      'activeSessionId?: string | null;',
      'openSessionIds?: readonly string[];',
      'children: ReactNode;',
    ]) {
      expect(pluginTypes).toContain(providerProp)
    }
  })
})
