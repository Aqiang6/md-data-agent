/** Public connection metadata and human-only database creation with fake worker I/O. */
import { expect, it, vi } from 'vitest'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { Config } from '../src/config.ts'
import { SourceCatalog } from '../src/source-catalog.ts'
import type { ConnectionCredentials } from '../src/source-catalog.ts'

function setup() {
  const records = new Map<CredentialKey, CredentialRecord>()
  let value = 'mysql://tester:secret-original@localhost:3306'
  const credentials: ConnectionCredentials = {
    resolve: async () => ({ value, source: 'fixture' }),
    listRecords: async () => [...records].map(([key, record]) => ({ key, kind: record.kind })),
    readRecord: async key => records.get(key),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key))
      if (next) records.set(key, next)
      return records.get(key)
    },
    deleteRecord: async (key) => {
      records.delete(key)
    },
  }
  const execute = vi.fn(async (input: Record<string, unknown>) =>
    input.action === 'mysql-create'
      ? { created: input.databaseName }
      : { rows: [{ name: 'sales' }, { name: 'warehouse' }] },
  )
  const catalog = new SourceCatalog(
    new Config(Object.assign(Config(), { directory: 'not-a-test-source-directory', mysqlDatabases: [] })),
    execute,
    credentials,
  )
  return {
    catalog,
    credentials,
    records,
    execute,
    rotate: () => {
      value = 'mysql://tester:secret-rotated@localhost:3306'
    },
  }
}
const signal = new AbortController().signal
it('saves credentials only in the provider while returning connection labels and stable source keys', async () => {
  const { catalog, records } = setup()
  const connection = await catalog.add(
    {
      label: 'Sales connection',
      host: 'localhost',
      username: 'user+name',
      password: 'special#secret@pass',
      databases: ['sales'],
    },
    signal,
  )
  const publicViews = JSON.stringify({
    connection,
    sources: await catalog.list(),
    connections: await catalog.connections(),
  })
  expect(publicViews).not.toContain('special#secret')
  expect(publicViews).not.toContain('mysql://')
  expect(connection.username).toBe('user+name')
  expect(records.size).toBe(1)
  expect([...records.keys()][0]).toMatch(/^glm-db\/connection-/)
  const source = (await catalog.list())[0]!
  expect(source.id).toBe(`mysql:${connection.id}:sales`)
  const target = await catalog.target(source.id)
  if (target.action !== 'mysql') throw new Error('Expected MySQL source')
  expect(target.database).toBe('sales')
  expect(target.url).toContain('special%23secret%40pass')
})
it('resolves credential references for each operation without storing their values', async () => {
  const { catalog, records, rotate } = setup()
  await catalog.add({ label: 'Referenced', credentialEnv: 'MYSQL_URL', databases: ['warehouse'] }, signal)
  expect(JSON.stringify([...records.values()])).not.toContain('secret-original')
  const id = (await catalog.list())[0]!.id
  const original = await catalog.target(id)
  if (original.action !== 'mysql') throw new Error('Expected MySQL source')
  expect(original.url).toContain('secret-original')
  rotate()
  const rotated = await catalog.target(id)
  if (rotated.action !== 'mysql') throw new Error('Expected MySQL source')
  expect(rotated.url).toContain('secret-rotated')
})
it('refuses unsaved schema names, invalid credentials and path-like database names', async () => {
  const { catalog, execute } = setup()
  await expect(
    catalog.add({ label: 'Missing', credentialEnv: 'MYSQL_URL', databases: ['not-visible'] }, signal),
  ).rejects.toThrow('accessible')
  const connection = await catalog.add(
    { label: 'Valid', credentialEnv: 'MYSQL_URL', databases: ['sales'] },
    signal,
  )
  for (const name of ['../escape', 'mysql', 'sales`; DROP DATABASE sales', ''])
    await expect(catalog.createDatabase(connection.id, name, signal)).rejects.toThrow()
  expect(execute.mock.calls.filter(([input]) => input.action === 'mysql-create')).toHaveLength(0)
  await expect(catalog.target(`mysql:${connection.id}:warehouse`)).rejects.toThrow('Unknown')
})
it('creates only a new empty database and removes only connection configuration', async () => {
  const { catalog, execute } = setup()
  const connection = await catalog.add(
    { label: 'Admin', credentialEnv: 'MYSQL_URL', databases: ['sales'] },
    signal,
  )
  const changed = await catalog.createDatabase(connection.id, 'demo-analysis', signal)
  expect(changed.databases).toEqual(['sales', 'demo-analysis'])
  expect(execute.mock.calls.at(-1)?.[0]).toMatchObject({
    action: 'mysql-create',
    databaseName: 'demo-analysis',
  })
  expect((await catalog.list()).map(source => source.name)).toEqual(['sales', 'demo-analysis'])
  await catalog.remove(connection.id)
  expect(await catalog.list()).toEqual([])
  expect(execute.mock.calls.filter(([input]) => input.action === 'mysql-create')).toHaveLength(1)
})
it('does not save anything while testing a connection without credential storage', async () => {
  const execute = vi.fn(async () => ({ rows: [{ name: 'sales' }] }))
  const catalog = new SourceCatalog(new Config(Object.assign(Config(), { mysqlDatabases: [] })), execute)
  expect(await catalog.test({ label: 'Test', username: 'user' }, signal)).toEqual({ databases: ['sales'] })
  await expect(
    catalog.add({ label: 'Test', username: 'user', databases: ['sales'] }, signal),
  ).rejects.toThrow('credential storage')
  expect(await catalog.connections()).toEqual([])
})

it('uses a credential provider that becomes available after plugin construction', async () => {
  const { credentials, execute } = setup()
  const available: { provider?: ConnectionCredentials } = {}
  const catalog = new SourceCatalog(new Config(Object.assign(Config(), { mysqlDatabases: [] })), execute, () => available.provider)
  expect(await catalog.connections()).toEqual([])
  available.provider = credentials
  const connection = await catalog.add(
    { label: 'Late provider', credentialEnv: 'MYSQL_URL', databases: ['sales'] },
    signal,
  )
  expect((await catalog.connections())[0]?.id).toBe(connection.id)
})
