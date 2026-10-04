// @vitest-environment jsdom
/** Complete request sections stay readable and late fetches cannot replace the selected tab. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RequestInspector } from '../src/components/Panels.tsx'
import { t } from '../src/copy.ts'
import type { TraceRequest } from '../src/state/fold.ts'

const request: TraceRequest = { requestId: 'fixture-request', attempt: 1, startedAt: 100, endedAt: 200, status: 'completed', inputThroughSeq: 4 }
const raw = JSON.stringify([{
  name: 'query_database', description: 'Read-only '.repeat(1600),
  parameters: { type: 'object' }, lastField: 'FINAL TOOL',
}], null, 2)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each(['tools', 'info', 'raw'] as const)('loads complete %s JSON immediately and downloads the complete selected section', async (section) => {
  const fetch = vi.fn(async (url: string) => {
    const parsed = new URL(url, 'http://host')
    const text = parsed.searchParams.get('section') === 'system' ? '# Prompt' : raw
    return new Response(text)
  })
  vi.stubGlobal('fetch', fetch)
  render(<RequestInspector sessionId="fixture-session" request={request} dismiss={vi.fn()} />)
  await screen.findByRole('heading', { name: 'Prompt' })
  fireEvent.click(screen.getByRole('button', { name: t(section === 'tools' ? 'declarations' : section) }))
  await waitFor(() => { expect(document.querySelector('.request-content > pre')?.textContent).toBe(raw) })
  expect(fetch.mock.calls.at(-1)?.[0]).toContain('request-download')
  expect(screen.queryByRole('button', { name: t('showComplete') })).toBeNull()
  expect(screen.queryByRole('button', { name: t('next') })).toBeNull()
  expect(screen.queryByRole('button', { name: t('previous') })).toBeNull()
  expect(screen.getByRole('link', { name: t('downloadComplete') }).getAttribute('href')).toContain(`section=${section}`)
  expect(screen.getByText(new RegExp(t('completeContent')))).toBeDefined()
  if (section === 'tools') expect(screen.getByRole('table', { name: t('toolPurposes') }).textContent).toContain(t('purposeQueryDatabase'))
})

it.each(['system', 'context'] as const)('opens complete long %s Markdown without a paging or expansion action', async (section) => {
  const markdown = '# Prompt\n\n' + 'Context '.repeat(2000) + '\n\nFINAL PROMPT'
  const fetch = vi.fn(async (_url: string, _options?: RequestInit) => new Response(markdown))
  vi.stubGlobal('fetch', fetch)
  render(<RequestInspector sessionId="fixture-session" request={request} dismiss={vi.fn()} />)
  if (section === 'context') fireEvent.click(screen.getByRole('button', { name: t('context') }))
  expect(await screen.findByRole('heading', { name: 'Prompt' })).toBeDefined()
  expect(screen.getByText('FINAL PROMPT', { exact: false })).toBeDefined()
  expect(screen.getByRole('link', { name: t('downloadComplete') }).getAttribute('href')).toContain(`section=${section}`)
  expect(screen.getByText(new RegExp(t('completeContent')))).toBeDefined()
  expect(screen.queryByRole('button', { name: t('next') })).toBeNull()
  expect(screen.queryByRole('button', { name: t('showComplete') })).toBeNull()
  expect(fetch.mock.calls.at(-1)?.[0]).toContain('request-download')
  expect(fetch.mock.calls.at(-1)?.[1]?.signal).toBeInstanceOf(AbortSignal)
})

it('ignores a stale section after changing tabs and exposes errors without inventing content', async () => {
  let settle: (value: Response) => void = () => { throw new Error('Pending response was not created.') }
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const section = new URL(url, 'http://host').searchParams.get('section')
    return section === 'system' ? new Promise<Response>((accept) => { settle = accept })
      : Promise.resolve(section === 'info' ? Response.json({ error: 'Observation unavailable' }, { status: 400 }) : new Response(raw))
  }))
  render(<RequestInspector sessionId="fixture-session" request={request} dismiss={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: t('declarations') }))
  await waitFor(() =>{  expect(document.querySelector('.request-content > pre')).not.toBeNull() })
  await act(async () => { settle(new Response('STALE SYSTEM')) })
  expect(screen.queryByText('STALE SYSTEM')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: t('info') }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Error: Observation unavailable')
})
