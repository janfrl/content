import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Connector, Primitive, Statement } from 'db0'
import { describe, expect, test, vi } from 'vitest'
import { databaseVersion, getLocalDatabase } from '../../src/utils/database'
import { isNodeSqliteAvailable } from '../../src/utils/dependencies'
import type { SQLiteConnector } from '../../src/types/module'

function deferred() {
  let resolve: () => void
  const promise = new Promise<void>((_resolve) => {
    resolve = _resolve
  })
  return { promise, resolve: resolve! }
}

function createConnector(overrides: {
  exec?: (sql: string) => unknown | Promise<unknown>
  all?: (sql: string, params: Primitive[]) => Promise<unknown[]>
  run?: (sql: string, params: Primitive[]) => Promise<{ success: boolean }>
  dispose?: () => void | Promise<void>
} = {}): Connector {
  const prepare = (sql: string, boundParams: Primitive[] = []): Statement => ({
    bind: (...params: Primitive[]) => prepare(sql, params),
    all: (...params: Primitive[]) => overrides.all?.(sql, params.length ? params : boundParams) || Promise.resolve([]),
    run: (...params: Primitive[]) => overrides.run?.(sql, params.length ? params : boundParams) || Promise.resolve({ success: true }),
    get: async () => ({ value: databaseVersion }),
  })

  return {
    name: 'test',
    dialect: 'sqlite',
    getInstance: () => ({}),
    exec: overrides.exec || (() => undefined),
    prepare,
    dispose: overrides.dispose,
  }
}

let databaseId = 0
async function createDatabase(connector: Connector) {
  return await getLocalDatabase(
    { type: 'sqlite', filename: `test-local-database-${databaseId++}.sqlite` },
    { connector },
  )
}

describe('local development database', () => {
  test('enables WAL and a busy timeout before initializing SQLite tables', async () => {
    const calls: string[] = []
    const connector = createConnector({ exec: sql => calls.push(sql) })
    const db = await createDatabase(connector)

    expect(calls.slice(0, 2)).toEqual([
      'PRAGMA journal_mode = WAL',
      'PRAGMA busy_timeout = 5000',
    ])
    await db.close()
  })

  test('shares a pending initialization for the same database', async () => {
    const initialization = deferred()
    const firstExec = vi.fn((sql: string) => sql === 'PRAGMA journal_mode = WAL' ? initialization.promise : undefined)
    const secondExec = vi.fn()
    const firstConnector = createConnector({ exec: firstExec })
    const secondConnector = createConnector({ exec: secondExec })
    const filename = `test-local-database-${databaseId++}.sqlite`

    const first = getLocalDatabase({ type: 'sqlite', filename }, { connector: firstConnector })
    await vi.waitFor(() => expect(firstExec).toHaveBeenCalledWith('PRAGMA journal_mode = WAL'))
    const second = getLocalDatabase({ type: 'sqlite', filename }, { connector: secondConnector })

    await Promise.resolve()
    expect(secondExec).not.toHaveBeenCalled()

    initialization.resolve()
    const [firstDatabase, secondDatabase] = await Promise.all([first, second])
    expect(firstDatabase.database).toBe(firstConnector)
    expect(secondDatabase.database).toBe(firstConnector)
    await firstDatabase.close()
  })

  test('disposes a failed initialization and allows a retry', async () => {
    const filename = `test-local-database-${databaseId++}.sqlite`
    const dispose = vi.fn()
    const failingConnector = createConnector({
      exec: () => {
        throw new Error('initialization failed')
      },
      dispose,
    })

    await expect(getLocalDatabase({ type: 'sqlite', filename }, { connector: failingConnector }))
      .rejects.toThrow('initialization failed')
    expect(dispose).toHaveBeenCalledOnce()

    const retryConnector = createConnector()
    const database = await getLocalDatabase({ type: 'sqlite', filename }, { connector: retryConnector })
    expect(database.database).toBe(retryConnector)
    await database.close()
  })

  test('awaits direct SQL execution', async () => {
    const execution = deferred()
    const connector = createConnector({
      exec: sql => sql === 'SELECT delayed' ? execution.promise : undefined,
    })
    const db = await createDatabase(connector)

    let settled = false
    const operation = db.exec('SELECT delayed').then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    execution.resolve()
    await operation
    expect(settled).toBe(true)
    await db.close()
  })

  test('atomically replaces an existing cache entry', async () => {
    const calls: Array<{ sql: string, params: Primitive[] }> = []
    const connector = createConnector({
      run: async (sql, params) => {
        calls.push({ sql, params })
        return { success: true }
      },
    })
    const db = await createDatabase(connector)
    calls.length = 0

    await db.insertDevelopmentCache('content/page.md', 'checksum', '{"title":"Page"}')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.sql).toContain('ON CONFLICT(id) DO UPDATE SET')
    expect(calls[0]!.params).toEqual(['content/page.md', '{"title":"Page"}', 'checksum'])
    await db.close()
  })

  test('waits until every content table has been dropped', async () => {
    const firstDrop = deferred()
    const calls: string[] = []
    const connector = createConnector({
      all: async sql => sql.includes('sqlite_master')
        ? [{ name: '_content_pages' }, { name: '_content_posts' }]
        : [],
      exec: async (sql) => {
        calls.push(sql)
        if (sql === 'DROP TABLE _content_pages') {
          await firstDrop.promise
        }
      },
    })
    const db = await createDatabase(connector)
    calls.length = 0

    let settled = false
    const operation = db.dropContentTables().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(calls).toEqual(['DROP TABLE _content_pages'])

    firstDrop.resolve()
    await operation
    expect(calls).toEqual(['DROP TABLE _content_pages', 'DROP TABLE _content_posts'])
    await db.close()
  })

  test('waits for connector disposal and disposes a shared connection once', async () => {
    const disposal = deferred()
    const dispose = vi.fn(() => disposal.promise)
    const connector = createConnector({ dispose })
    const filename = `test-local-database-${databaseId++}.sqlite`
    const [firstDatabase, secondDatabase] = await Promise.all([
      getLocalDatabase({ type: 'sqlite', filename }, { connector }),
      getLocalDatabase({ type: 'sqlite', filename }, { connector }),
    ])

    let settled = false
    const operations = Promise.all([firstDatabase.close(), secondDatabase.close()]).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(dispose).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    disposal.resolve()
    await operations
    expect(settled).toBe(true)
  })
})

const sqliteConnectors: SQLiteConnector[] = ['better-sqlite3', 'sqlite3']
if (isNodeSqliteAvailable()) {
  sqliteConnectors.push('native')
}

describe.each(sqliteConnectors)('local development database with the %s connector', (sqliteConnector) => {
  test('initializes and atomically replaces cache entries', async () => {
    const filename = join(tmpdir(), `nuxt-content-${sqliteConnector}-${Date.now()}.sqlite`)
    const db = await getLocalDatabase(
      { type: 'sqlite', filename },
      { sqliteConnector },
    )

    try {
      await db.insertDevelopmentCache('content/page.md', 'first', '{"title":"First"}')
      await db.insertDevelopmentCache('content/page.md', 'second', '{"title":"Second"}')

      expect(await db.fetchDevelopmentCacheForKey('content/page.md')).toMatchObject({
        id: 'content/page.md',
        value: '{"title":"Second"}',
        checksum: 'second',
      })
    }
    finally {
      await db.close()
      await Promise.all([
        fs.rm(filename, { force: true }),
        fs.rm(`${filename}-shm`, { force: true }),
        fs.rm(`${filename}-wal`, { force: true }),
      ])
    }
  })
})
