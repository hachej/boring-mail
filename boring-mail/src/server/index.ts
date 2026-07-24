export interface BoringMailServerOptions {
  port?: number
  storageRoot?: string
}

export function createBoringMailServer(_options: BoringMailServerOptions = {}) {
  return {
    status: 'mock-only',
    routes: [],
  } as const
}
