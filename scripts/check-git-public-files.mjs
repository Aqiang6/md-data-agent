/** Reject tracked machine-local files selected by the repository's ignore rules. */
import { execFileSync } from 'node:child_process'

const paths = execFileSync('git', ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'], {
  encoding: 'utf8', windowsHide: true,
}).split('\0').filter(Boolean)

if (paths.length) {
  console.error('Ignored local files are present in the Git index:')
  for (const path of paths) console.error(`  ${path}`)
  console.error('Remove these files from the index with git rm --cached; keep local copies outside the commit.')
  process.exitCode = 1
} else {
  console.log('check:git-files: no ignored local files in the Git index.')
}
