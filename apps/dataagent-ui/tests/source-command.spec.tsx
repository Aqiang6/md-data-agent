/** Source-selection acknowledgements retain errors without exposing large command JSON. */
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ChatStream } from '../src/components/Chat.tsx'
import { t } from '../src/copy.ts'
import type { ChatEntry } from '../src/state/fold.ts'
const command: ChatEntry = {
  kind: 'command',
  key: 'scope',
  seq: [1, 2],
  time: 1,
  name: 'data_scope',
  args: '{"version":1,"sources":[]}',
  done: { ok: true, text: 'data-agent-scope:{"version":1,"sources":[]}' },
}
it('shows a localized scope acknowledgement instead of duplicating the raw selection payload', () => {
  const rendered = renderToStaticMarkup(<ChatStream entries={[command]} running={false} />)
  expect(rendered).toContain(t('scopeSaved'))
  expect(rendered).not.toContain('data-agent-scope:')
  expect(rendered).not.toContain('version')
})
it('retains the validation failure in the command acknowledgement', () => {
  const rendered = renderToStaticMarkup(
    <ChatStream
      entries={[{ ...command, done: { ok: false, text: 'Unknown table selected' } }]}
      running={false}
    />,
  )
  expect(rendered).toContain('Unknown table selected')
  expect(rendered).toContain('cmd-error')
})
