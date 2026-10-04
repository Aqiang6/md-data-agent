import { clientBundle } from '../../client/tsdown.client.ts'

/** Build the Host plugin during the Host pass and the dynamic Client plugin during the Client pass. */
export default clientBundle(
  '@deepseek-ai/dsh-experimental-data-agent',
  ['lib/types/index.js', 'lib/types/preset.js', 'lib/types/policy.js', 'lib/types/primitives.js', 'lib/types/analysis.js'],
  { hostPhase: true },
)
