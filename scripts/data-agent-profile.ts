/** Initialize a mutable Data Agent Web profile without command-line model overrides. */
import { access, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml'
import { initProfile, loadOverlayPatches, PROFILE_PATCH_FILENAME, PROFILE_TEMPLATES, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function migrateAnalysisProfile(content: string): string {
  const document = parseDocument(content, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('Data Agent profile patch must be a YAML list')
  const changed = new Set<YAMLMap>()
  let analysisPreset: string | undefined
  const rename = (row: YAMLMap, key: string): void => {
    const field = row.get(key, true)
    if (!isScalar(field) || typeof field.value !== 'string') return
    const previous = field.value
    if (key === 'id' && previous === 'glm-db') field.value = 'data-agent'
    const oldPackage = '@deepseek-ai/dsh-experimental-glm-db'
    if (key === 'name' && (previous === oldPackage || previous.startsWith(`${oldPackage}/`))) {
      field.value = previous.replace(oldPackage, '@deepseek-ai/dsh-experimental-data-agent')
    }
    if (field.value !== previous) changed.add(row)
  }
  const visit = (row: YAMLMap): void => {
    rename(row, 'id')
    rename(row, 'name')
    if (row.get('name') === '@deepseek-ai/dsh-experimental-data-agent/preset') {
      const config = row.get('config', true)
      const id = isMap(config) ? config.get('id') : undefined
      analysisPreset = typeof id === 'string' ? id : 'data-agent'
    }
    const inserted = row.get('insert', true)
    const grouped = row.get('group') === true ? row.get('config', true) : undefined
    for (const children of [inserted, grouped]) {
      if (isSeq(children)) for (const child of children.items) if (isMap(child)) visit(child)
    }
  }
  for (const row of document.contents.items) if (isMap(row)) visit(row)
  if (analysisPreset !== undefined) {
    let registry: YAMLMap | undefined
    for (const item of document.contents.items) {
      if (!isMap(item)) continue
      const row: YAMLMap = item
      if (row.get('id') === 'agent-preset-registry') registry = row
    }
    if (!registry) {
      registry = document.createNode({ id: 'agent-preset-registry', config: {} })
      document.add(registry)
    }
    const current = registry.get('config', true)
    let config: YAMLMap | undefined = isMap(current) ? current : undefined
    if (!config) {
      config = document.createNode({})
      registry.set('config', config)
    }
    for (const key of ['default', 'selectedDefault']) {
      if (config.get(key) !== analysisPreset) {
        config.set(key, analysisPreset)
        changed.add(registry)
      }
    }
  }
  return changed.size > 0 ? document.toString() : content
}

/**
 * Seed a custom profile once and select its analysis preset, preserving model settings and YAML comments.
 * @param options - custom profile name, optional Harness home and source template.
 * @returns profile location and whether this call installed the initial configuration.
 * @throws when targeting a shipped profile or reading an invalid patch.
 */
export async function prepareDataAgentProfile(options: { profile?: string; home?: string; template?: string } = {}): Promise<{
  profile: string
  directory: string
  seeded: boolean
}> {
  const profile = options.profile ?? 'data-agent'
  if (profile === 'desktop' || Object.hasOwn(PROFILE_TEMPLATES, profile)) throw new Error('Data Agent requires a dedicated custom profile')
  const directory = resolveProfileDir(profile, options.home)
  await mkdir(directory, { recursive: true })
  return withFileLock(join(directory, 'package.json'), async () => {
    const template = PROFILE_TEMPLATES.web
    if (!template) throw new Error('Harness Web profile template is unavailable')
    initProfile(directory, template.bundles)
    const stamp = join(directory, 'data-agent.bootstrap')
    const patch = join(directory, PROFILE_PATCH_FILENAME)
    const current = loadOverlayPatches('data-agent', patch)
    const initialized = await exists(stamp)
    const seeded = !initialized && current.length === 0
    if (seeded) {
      const template = options.template ?? fileURLToPath(new URL('../dsh-data-agent.patch.yml', import.meta.url))
      loadOverlayPatches('data-agent', template)
      await writeFileAtomic(patch, await readFile(template, 'utf8'), { mode: 0o600 })
    } else {
      const content = await readFile(patch, 'utf8')
      const migrated = migrateAnalysisProfile(content)
      if (migrated !== content) await writeFileAtomic(patch, migrated, { mode: 0o600 })
    }
    if (!initialized) await writeFileAtomic(stamp, 'initialized\n', { mode: 0o600 })
    return { profile, directory, seeded }
  })
}
