/** Prepare configuration only; the supported dsh profile command launches the application. */
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { prepareDataAgentProfile } from './data-agent-profile.ts'

loadLayeredEnv('data-agent')
const prepared = await prepareDataAgentProfile({ profile: process.argv[2] ?? 'data-agent' })
process.stdout.write(`Data Agent profile: ${prepared.profile} (${prepared.seeded ? 'initialized' : 'preserved'})\n`)
