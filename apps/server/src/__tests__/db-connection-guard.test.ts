import { afterEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { databaseUrlFor } from '../db/client'
import { buildApp } from '../app'

/**
 * Stands in for the driver so that CONSTRUCTION is observable. The rule below is
 * enforced at one seam, and a test of the filter alone cannot tell a wired guard
 * from one nobody calls.
 */
vi.mock('pg', () => {
  const Pool = vi.fn(function Pool(this: unknown) {
    return {
      on: vi.fn(),
      connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })),
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => {}),
    }
  })
  return { default: { Pool }, Pool }
})

/** A URL shaped like the real one and pointing at no database that exists. */
const AMBIENT = 'postgres://test-user:test-password@localhost:15432/test-db'

const poolSpy = pg.Pool as unknown as ReturnType<typeof vi.fn>

afterEach(() => {
  vi.unstubAllEnvs()
  poolSpy.mockClear()
})

describe('an ambient DATABASE_URL never reaches the suite', () => {
  it('runs under a test runner, which is the signal the guard keys on', () => {
    expect(Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test').toBe(true)
  })

  it('is dropped while a test runner is present', () => {
    expect(databaseUrlFor({ DATABASE_URL: AMBIENT, VITEST: 'true' })).toBeUndefined()
    expect(databaseUrlFor({ DATABASE_URL: AMBIENT, NODE_ENV: 'test' })).toBeUndefined()
  })

  it('is still handed to a process that is not a test run', () => {
    expect(databaseUrlFor({ DATABASE_URL: AMBIENT, NODE_ENV: 'production' })).toBe(AMBIENT)
  })

  it('leaves this process with no database, whatever the shell exported', () => {
    expect(databaseUrlFor(process.env)).toBeUndefined()
  })
})

describe('and the drop is wired to the one seam that builds a database', () => {
  it('builds no pool for an app under the test runner, even with DATABASE_URL exported', async () => {
    vi.stubEnv('DATABASE_URL', AMBIENT)
    const app = await buildApp({})
    expect(poolSpy).not.toHaveBeenCalled()
    await app.close()
  })

  it('still builds one when a caller names a database itself', async () => {
    const app = await buildApp({ databaseUrl: AMBIENT })
    expect(poolSpy).toHaveBeenCalledTimes(1)
    await app.close()
  })
})
