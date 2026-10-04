/** Exercise the commit guard against an isolated Git index containing forced local files. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const guard = resolve('scripts/check-git-public-files.mjs')
const ignore = resolve('.gitignore')

test('allows public templates and rejects forced credentials without printing their contents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'data-agent-public-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' })
  git(['init', '--quiet'])
  await copyFile(ignore, join(root, '.gitignore'))
  await writeFile(join(root, '.env.example'), 'DEEPSEEK_API_KEY=\n')
  git(['add', '.gitignore', '.env.example'])
  const run = () => spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(run().status, 0)
  const localPaths = ['.env', '.env.production', '.credentials.yaml', '.dsh/.credentials.yaml',
    'dsh-glm-provider.patch.yml', 'databases/shop.db', 'data-agent-docs/schema.md',
    'evals/data-agent/output/results.jsonl', 'apps/dataagent-ui/dist/index.html',
    'packages/experimental/data-agent/lib/index.js', '.playwright-mcp/trajectory.json']
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
    cwd: root, windowsHide: true, encoding: 'utf8', input: localPaths.join('\0') + '\0',
  })
  assert.equal(ignored.status, 0)
  assert.deepEqual(ignored.stdout.split('\0').filter(Boolean), localPaths)
  const publicPaths = ['.env.example', '.env.development.example',
    'snapshots/session/skill-load/workspace/.dsh/skills/snapshot-skill/SKILL.md',
    'snapshots/sdk/data-agent-tools/session.jsonl']
  const publicSelection = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
    cwd: root, windowsHide: true, encoding: 'utf8', input: publicPaths.join('\0') + '\0',
  })
  assert.equal(publicSelection.status, 1)
  assert.equal(publicSelection.stdout, '')
  await writeFile(join(root, '.env'), 'DEEPSEEK_API_KEY=private-test-sentinel\n')
  git(['add', '--force', '.env'])
  const blocked = run()
  assert.equal(blocked.signal, null)
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /\.env/u)
  assert(!blocked.stderr.includes('private-test-sentinel'))
})
