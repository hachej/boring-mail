export interface SqliteMailStoreOptions {
  path: string
}

export function createSqliteMailStore(options: SqliteMailStoreOptions) {
  return { kind: 'not-implemented-yet', path: options.path } as const
}
