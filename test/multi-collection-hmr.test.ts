import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { defineCollection } from '../src/utils'
import { generateCollectionTableDefinition, resolveCollection } from '../src/utils/collection'
import { contentHooks, getContentChecksum, logger, watchContents } from '../src/utils/dev'
import { getLocalDatabase } from '../src/utils/database'
import { initiateValidatorsContext, isNodeSqliteAvailable } from '../src/utils/dependencies'
import type { LocalDevelopmentDatabase } from '../src/module'
import type { Manifest } from '../src/types/manifest'

const rootDir = join(tmpdir(), 'nuxt-content-hmr-test-' + Date.now())
const contentDir = join(rootDir, 'content')
const dbPath = join(rootDir, 'contents.sqlite')

const closeHooks: Array<() => void | Promise<void>> = []
let callNuxtHook: (...args: unknown[]) => Promise<void> = () => Promise.resolve()
const nuxtMock = {
  options: { rootDir, buildDir: join(rootDir, '.nuxt') },
  callHook: (...args: unknown[]) => callNuxtHook(...args),
  hook: (event: string, cb: () => void | Promise<void>) => {
    if (event === 'close') {
      closeHooks.push(cb)
    }
  },
} as never

describe('multi-collection HMR — file matched by multiple collections', () => {
  let db: LocalDevelopmentDatabase
  let manifest: Manifest

  beforeAll(async () => {
    await initiateValidatorsContext()

    await fs.mkdir(join(contentDir, 'blog'), { recursive: true })
    await fs.writeFile(join(contentDir, 'index.md'), '---\ntitle: Home\n---\n# Home\n')
    await fs.writeFile(join(contentDir, 'blog', 'hello.md'), '---\ntitle: Hello\n---\n# Hello\n')

    db = await getLocalDatabase({ type: 'sqlite', filename: dbPath })

    const contentCollection = resolveCollection('content', defineCollection({ type: 'page', source: '**' }))!
    const blogCollection = resolveCollection('blog', defineCollection({ type: 'page', source: 'blog/**' }))!
    for (const collection of [contentCollection, blogCollection]) {
      for (const stmt of generateCollectionTableDefinition(collection, { drop: true }).split('\n')) {
        await db.exec(stmt)
      }
      for (const source of collection.source!) {
        await source.prepare?.({ rootDir })
      }
    }

    manifest = {
      collections: [contentCollection, blogCollection],
      dump: { content: [], blog: [] },
      checksum: {},
      checksumStructure: {},
      components: [],
    }

    const options = {
      _localDatabase: { type: 'sqlite' as const, filename: dbPath },
      experimental: {},
    } as never

    watchContents(nuxtMock, options, manifest)
    await new Promise(resolve => setTimeout(resolve, 100))
  })

  afterAll(async () => {
    await Promise.all(closeHooks.map(hook => hook()))
    await fs.rm(rootDir, { recursive: true, force: true })
  })

  test('modifying a file that matches multiple collections updates all of them', async () => {
    const updatedCollections: string[] = []
    let resolveUpdates: (() => void) | undefined
    const updatesReceived = new Promise<void>((resolve) => {
      resolveUpdates = resolve
    })
    const stopListening = contentHooks.hook('hmr:content:update', ({ collection }) => {
      updatedCollections.push(collection)
      if (new Set(updatedCollections).size === 2) {
        resolveUpdates?.()
      }
    })

    const blogPost = join(contentDir, 'blog', 'hello.md')
    const original = await fs.readFile(blogPost, 'utf8')
    const updated = original.replace('# Hello', '# Hello Updated')
    await fs.writeFile(blogPost, updated)

    await Promise.race([
      updatesReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for HMR updates')), 5000)),
    ])

    stopListening()

    expect(updatedCollections, 'both collections should have been notified').toContain('content')
    expect(updatedCollections, 'both collections should have been notified').toContain('blog')
    expect(manifest.dump.content[0]).toMatch(/; -- [\w-]+$/)
    expect(manifest.dump.blog[0]).toMatch(/; -- [\w-]+$/)

    for (const key of ['content/blog/hello.md', 'blog/blog/hello.md']) {
      const cacheEntry = await db.fetchDevelopmentCacheForKey(key)
      expect(cacheEntry?.checksum).toBe(getContentChecksum(updated))
      expect(JSON.parse(cacheEntry!.value).body.value[0][2]).toBe('Hello Updated')
    }
  })

  test('rapid changes to one file are committed in event order', async () => {
    const page = join(contentDir, 'index.md')
    const firstContent = '---\ntitle: Home\n---\n# First update\n'
    const secondContent = '---\ntitle: Home\n---\n# Second update\n'

    let releaseFirstParse: (() => void) | undefined
    const firstParseReleased = new Promise<void>((resolve) => {
      releaseFirstParse = resolve
    })
    let markFirstParseStarted: (() => void) | undefined
    const firstParseStarted = new Promise<void>((resolve) => {
      markFirstParseStarted = resolve
    })

    callNuxtHook = async (name, context) => {
      if (name === 'content:file:beforeParse' && (context as { file?: { body?: string } })?.file?.body === firstContent) {
        markFirstParseStarted?.()
        await firstParseReleased
      }
    }

    let updateCount = 0
    let resolveUpdates: (() => void) | undefined
    const updatesReceived = new Promise<void>((resolve) => {
      resolveUpdates = resolve
    })
    const stopListening = contentHooks.hook('hmr:content:update', ({ key }) => {
      if (key === 'content/index.md' && ++updateCount === 2) {
        resolveUpdates?.()
      }
    })

    await fs.writeFile(page, firstContent)
    await firstParseStarted
    await new Promise(resolve => setTimeout(resolve, 100))
    await fs.writeFile(page, secondContent)
    await new Promise(resolve => setTimeout(resolve, 200))
    releaseFirstParse?.()

    await Promise.race([
      updatesReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for rapid HMR updates')), 5000)),
    ])

    stopListening()
    callNuxtHook = () => Promise.resolve()

    const cacheEntry = await db.fetchDevelopmentCacheForKey('content/index.md')
    expect(cacheEntry?.checksum).toBe(getContentChecksum(secondContent))
    expect(JSON.parse(cacheEntry!.value).body.value[0][2]).toBe('Second update')
    expect(manifest.dump.content.some(item => item.includes('Second update'))).toBe(true)
  })

  test('rolls back a failed update and continues processing later changes', async () => {
    const page = join(contentDir, 'index.md')
    const failedContent = '---\ntitle: Home\n---\n# Failed update\n'
    const recoveredContent = '---\ntitle: Home\n---\n# Recovered update\n'
    const collection = manifest.collections.find(item => item.name === 'content')!
    const database = db.database!
    const originalExec = database.exec.bind(database)
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const before = await database.prepare(`SELECT * FROM ${collection.tableName} WHERE id = ?`)
      .get('content/index.md')
    let rejectNextInsert = true

    database.exec = async (sql: string) => {
      if (rejectNextInsert && sql.startsWith(`INSERT INTO ${collection.tableName}`)) {
        rejectNextInsert = false
        throw new Error('Simulated insert failure')
      }
      return await originalExec(sql)
    }

    try {
      await fs.writeFile(page, failedContent)
      await vi.waitFor(() => expect(rejectNextInsert).toBe(false))
      await vi.waitFor(async () => {
        const after = await database.prepare(`SELECT * FROM ${collection.tableName} WHERE id = ?`)
          .get('content/index.md')
        expect(after).toEqual(before)
      })
      expect(logError).toHaveBeenCalledOnce()
    }
    finally {
      database.exec = originalExec
      logError.mockRestore()
    }

    let resolveUpdate: (() => void) | undefined
    const updateReceived = new Promise<void>((resolve) => {
      resolveUpdate = resolve
    })
    const stopListening = contentHooks.hook('hmr:content:update', ({ key }) => {
      if (key === 'content/index.md') {
        resolveUpdate?.()
      }
    })

    await fs.writeFile(page, recoveredContent)
    await Promise.race([
      updateReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for HMR recovery')), 5000)),
    ])
    stopListening()

    const cacheEntry = await db.fetchDevelopmentCacheForKey('content/index.md')
    expect(cacheEntry?.checksum).toBe(getContentChecksum(recoveredContent))
    expect(JSON.parse(cacheEntry!.value).body.value[0][2]).toBe('Recovered update')
  })

  test.runIf(isNodeSqliteAvailable())('updates content while another connection holds a read transaction', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const reader = new DatabaseSync(dbPath)
    const collection = manifest.collections.find(item => item.name === 'content')!
    const page = join(contentDir, 'reader-lock.md')
    const updatedContent = '---\ntitle: Reader lock\n---\n# Added alongside a reader\n'
    const journalMode = reader.prepare('PRAGMA journal_mode').get()
    let stopListening: (() => void) | undefined

    try {
      reader.exec('BEGIN')
      reader.prepare(`SELECT * FROM ${collection.tableName}`).all()

      let resolveUpdate: (() => void) | undefined
      const updateReceived = new Promise<void>((resolve) => {
        resolveUpdate = resolve
      })
      stopListening = contentHooks.hook('hmr:content:update', ({ key }) => {
        if (key === 'content/reader-lock.md') {
          resolveUpdate?.()
        }
      })

      await fs.writeFile(page, updatedContent)
      await Promise.race([
        updateReceived,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out while a second connection held a read transaction')), 5000)),
      ])
    }
    finally {
      stopListening?.()
      reader.exec('ROLLBACK')
      reader.close()
    }

    const cacheEntry = await db.fetchDevelopmentCacheForKey('content/reader-lock.md')
    expect(journalMode).toEqual({ journal_mode: 'wal' })
    expect(cacheEntry?.checksum).toBe(getContentChecksum(updatedContent))
    expect(JSON.parse(cacheEntry!.value).body.value[0][2]).toBe('Added alongside a reader')
  }, 10_000)
})
