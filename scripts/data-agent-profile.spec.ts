/** Isolated, idempotent bootstrap of the mutable Data Agent profile. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProfile, loadOverlayPatches, PROFILE_TEMPLATES, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { prepareDataAgentProfile } from './data-agent-profile.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'data-agent-profile-test-'))
  roots.push(root)
  return root
}

it('seeds editable model configuration once and preserves later user choices, including an empty patch', async () => {
  const root = await home()
  const created = await prepareDataAgentProfile({ home: root })
  expect(created.seeded).toBe(true)
  const patch = join(created.directory, 'cordis.patch.yml')
  const initialPatch = await readFile(patch, 'utf8')
  const initialRows = loadOverlayPatches('test', patch)
  expect(initialRows).toContainEqual({
    id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  expect(initialPatch).not.toMatch(/glm|bigmodel|BIGMODEL_API_KEY|mysqlDatabases|MYSQL_URL|12306/iu)
  expect(initialRows.some(row => row.id === 'llm-pi-ai')).toBe(false)
  expect(initialRows).toContainEqual({
    id: 'agent-preset-registry', config: { default: 'data-agent', selectedDefault: 'data-agent' },
  })
  await writeFile(patch, '[]\n')
  expect((await prepareDataAgentProfile({ home: root })).seeded).toBe(false)
  expect(await readFile(patch, 'utf8')).toBe('[]\n')
})

it('preserves existing custom profiles and never modifies shipped profiles', async () => {
  const root = await home()
  const directory = resolveProfileDir('custom-analysis', root)
  initProfile(directory, PROFILE_TEMPLATES.web!.bundles)
  const content = '- id: agent-default-model\n  config:\n    provider: existing\n    model: selected\n'
  await writeFile(join(directory, 'cordis.patch.yml'), content)
  expect((await prepareDataAgentProfile({ home: root, profile: 'custom-analysis' })).seeded).toBe(false)
  expect(await readFile(join(directory, 'cordis.patch.yml'), 'utf8')).toBe(content)
  await expect(prepareDataAgentProfile({ home: root, profile: 'web' })).rejects.toThrow('dedicated custom profile')
})

it('serializes overlapping initializations and leaves invalid templates recoverable', async () => {
  const root = await home()
  const template = join(root, 'invalid.yml')
  await writeFile(template, '[\n')
  await expect(prepareDataAgentProfile({ home: root, template })).rejects.toThrow()
  const first = prepareDataAgentProfile({ home: root })
  const second = prepareDataAgentProfile({ home: root })
  const values = await Promise.all([first, second])
  expect(values.filter(value => value.seeded)).toHaveLength(1)
  expect(await readFile(join(values[0].directory, 'data-agent.bootstrap'), 'utf8')).toBe('initialized\n')
})

it('migrates an initialized profile while retaining model choices, comments, expressions and domain settings', async () => {
  const root = await home()
  const created = await prepareDataAgentProfile({ home: root })
  const patch = join(created.directory, 'cordis.patch.yml')
  const content = `# User model settings
- id: agent-default-model
  config: { provider: custom, model: glm-db }
- insert:
    - id: glm-db
      name: '@deepseek-ai/dsh-experimental-glm-db' # Saved connection setup
      config:
        directory: chosen-databases
        mysqlUrlEnv: SAVED_MYSQL_URL
        mysqlDatabases: [chosen]
    - id: nested
      group: true
      config:
        - id: data-agent-preset
          name: '@deepseek-ai/dsh-experimental-glm-db/preset'
          config: { benchmark: true }
- id: glm-db
  name: '@deepseek-ai/dsh-experimental-glm-db'
  config: { uiDist: !!js "process.env.DATA_UI" }
`
  await writeFile(patch, content)
  expect((await prepareDataAgentProfile({ home: root })).seeded).toBe(false)
  const migrated = await readFile(patch, 'utf8')
  expect(migrated).toContain('# User model settings')
  expect(migrated).toContain('# Saved connection setup')
  expect(loadOverlayPatches('test', patch)).toEqual([
    { id: 'agent-default-model', config: { provider: 'custom', model: 'glm-db' } },
    { insert: [
      { id: 'data-agent', name: '@deepseek-ai/dsh-experimental-data-agent', config: {
        directory: 'chosen-databases', mysqlUrlEnv: 'SAVED_MYSQL_URL', mysqlDatabases: ['chosen'],
      } },
      { id: 'nested', group: true, config: [
        { id: 'data-agent-preset', name: '@deepseek-ai/dsh-experimental-data-agent/preset', config: { benchmark: true } },
      ] },
    ] },
    { id: 'data-agent', name: '@deepseek-ai/dsh-experimental-data-agent', config: { uiDist: { __jsExpr: 'process.env.DATA_UI' } } },
    { id: 'agent-preset-registry', config: { default: 'data-agent', selectedDefault: 'data-agent' } },
  ])
  expect((await prepareDataAgentProfile({ home: root })).seeded).toBe(false)
  expect(await readFile(patch, 'utf8')).toBe(migrated)
})

it('repairs a saved coding default using the configured analysis identity without replacing other registry settings', async () => {
  const root = await home()
  const created = await prepareDataAgentProfile({ home: root })
  const patch = join(created.directory, 'cordis.patch.yml')
  await writeFile(patch, `- id: agent-preset-registry
  config: { default: standard, selectedDefault: standard }
- insert:
    - id: data-agent-preset
      name: '@deepseek-ai/dsh-experimental-data-agent/preset'
      config: { id: custom-analysis, benchmark: true }
- id: agent-default-model
  config: { provider: saved-provider, model: saved-model }
`)
  await prepareDataAgentProfile({ home: root })
  expect(loadOverlayPatches('test', patch)).toEqual([
    { id: 'agent-preset-registry', config: { default: 'custom-analysis', selectedDefault: 'custom-analysis' } },
    { insert: [{ id: 'data-agent-preset', name: '@deepseek-ai/dsh-experimental-data-agent/preset', config: { id: 'custom-analysis', benchmark: true } }] },
    { id: 'agent-default-model', config: { provider: 'saved-provider', model: 'saved-model' } },
  ])
})
