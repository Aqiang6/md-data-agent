// @vitest-environment jsdom
/// <reference types="vite/client" />
/** Record deletion through the existing durable Workspace archive and reconnect feed. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { AnalysisRecord } from '../src/components/AnalysisRecord.tsx'
import { analysisHistory, archiveIds } from '../src/state/analysis-history.ts'
import * as api from '../src/protocol/api.ts'
import { RpcError } from '../src/protocol/api.ts'
import { t } from '../src/copy.ts'
import type { MuxHandlers } from '../src/protocol/mux.ts'
import type { SessionSummary } from '../src/protocol/wire.ts'
import recordedSession from '../../../snapshots/session/model-switch-notice/session.v3.jsonl?raw'

const streams = vi.hoisted(() => new Map<string, MuxHandlers>())
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
vi.mock('../src/protocol/api.ts', async original => ({
  ...await original<typeof api>(), listSessions: vi.fn(), deleteAnalysis: vi.fn(), createSession: vi.fn(),
}))
vi.mock('../src/protocol/sources.ts', () => ({ sourceRequest: vi.fn(async () => ({ sources: [], connections: [], scope: null })) }))
vi.mock('../src/protocol/mux.ts', () => ({ Mux: class {
  start() {}
  close() {}
  open(endpoint: string, _payload: unknown, handlers: MuxHandlers) {
    streams.set(endpoint, handlers)
    return { cancel: vi.fn() }
  }
} }))
vi.mock('../src/components/ModelControl.tsx', () => ({ ModelControl: () => null }))
vi.mock('../src/components/Panels.tsx', () => ({ ExecutionPanel: () => null }))
vi.mock('../src/components/Questions.tsx', () => ({ Questions: () => null }))

const records: SessionSummary[] = [
  { sessionId: 'first', updatedAt: 1, running: false, blank: true, projections: { values: { agentPreset: 'data-agent' } } },
  { sessionId: 'second', updatedAt: 2, running: false, blank: true, projections: { values: { agentPreset: 'data-agent' } } },
]
const row = (id: string) => document.querySelector(`[data-session-id="${id}"]`)!
const emitArchives = (ids: string[], baseline = false) => {
  act(() => {
    streams.get('workspace/follow')!.onItem(baseline
      ? { type: 'baseline', value: { archivedSessionIds: ids } }
      : { type: 'archived', archivedSessionIds: ids })
  })
}
const beginDelete = (id: string) => {
  fireEvent.click(row(id).querySelector('.session-delete')!)
  fireEvent.click(screen.getByRole('button', { name: t('confirmDeleteAnalysis'), exact: true }))
}
beforeEach(() => {
  vi.resetAllMocks()
  streams.clear()
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true })
  vi.mocked(api.listSessions).mockResolvedValue({ items: records })
  vi.mocked(api.deleteAnalysis).mockResolvedValue({ archivedSessionIds: ['first'] })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalScroll) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScroll)
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

it('filters archived roots only after a baseline, ignores unrelated updates and rejects malformed archive frames', () => {
  const all = [...records, { ...records[0], sessionId: 'child', parentSessionId: 'first' }]
  expect(analysisHistory(all, undefined)).toEqual([])
  expect(analysisHistory(all, ['first'])).toEqual([records[1]])
  expect(analysisHistory([
    { ...records[0], projections: { values: { agentPreset: 'standard' } } },
    { ...records[1], projections: undefined },
  ], [])).toEqual([])
  expect(archiveIds({ type: 'baseline', value: { archivedSessionIds: ['first'] } })).toEqual(['first'])
  expect(archiveIds({ type: 'pinned', pinnedSessionIds: [] })).toBeUndefined()
  for (const malformed of [null, {}, { type: 'baseline' }, { type: 'archived', archivedSessionIds: [1] }])
    expect(() => archiveIds(malformed)).toThrow()
})

it('separates selection and deletion, cancels with Escape or outside click and retains a failed confirmation', async () => {
  const select = vi.fn()
  const remove = vi.fn(async () => false)
  const component = render(<AnalysisRecord id="first" title="Long analysis" time="Now" active running={false} busy={false} select={select} remove={remove} />)
  const trigger = screen.getByRole('button', { name: `${t('deleteAnalysis')} Long analysis` })
  fireEvent.click(trigger)
  expect(select).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: t('cancelOperation') }))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('group')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('group')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: t('confirmDeleteAnalysis') }))
  await waitFor(() => { expect(remove).toHaveBeenCalledOnce() })
  expect(screen.getByRole('group')).toBeTruthy()
  component.rerender(<AnalysisRecord id="first" title="Long analysis" time="Now" active running busy={false} select={select} remove={remove} />)
  expect(screen.getByRole('button', { name: t('confirmDeleteAnalysis') })).toHaveProperty('disabled', true)
})

it('removes the active record, selects the next record and hides persisted deletions after a fresh mount', async () => {
  render(<App />)
  expect(document.querySelectorAll('.session-record')).toHaveLength(0)
  emitArchives([], true)
  await waitFor(() => { expect(document.querySelector('.session-record.active')?.getAttribute('data-session-id')).toBe('first') })
  beginDelete('first')
  await screen.findByText(t('analysisDeleted'))
  expect(document.querySelector('[data-session-id="first"]')).toBeNull()
  expect(document.querySelector('.session-record.active')?.getAttribute('data-session-id')).toBe('second')
  expect(api.deleteAnalysis).toHaveBeenCalledWith('first')
  cleanup()
  render(<App />)
  emitArchives(['first'], true)
  await waitFor(() => { expect(document.querySelector('.session-record.active')?.getAttribute('data-session-id')).toBe('second') })
  expect(document.querySelectorAll('.session-record')).toHaveLength(1)
})

it('retains records on failure and offers stopping analysis for a Host activity refusal', async () => {
  vi.mocked(api.deleteAnalysis).mockRejectedValueOnce(new Error('offline'))
  render(<App />)
  emitArchives([], true)
  await waitFor(() => { expect(document.querySelectorAll('.session-record')).toHaveLength(2) })
  beginDelete('first')
  await screen.findByText(t('deleteAnalysisFailed'))
  expect(document.querySelectorAll('.session-record')).toHaveLength(2)
  expect(screen.getByRole('group')).toBeTruthy()
  vi.mocked(api.deleteAnalysis).mockRejectedValueOnce(new RpcError('workspace/session-active', 'A job is running'))
  fireEvent.click(screen.getByRole('button', { name: t('confirmDeleteAnalysis') }))
  await waitFor(() => { expect(document.querySelector('.analysis-toast')?.textContent).toContain(t('stopBeforeDelete')) })
  expect(document.querySelectorAll('.session-record')).toHaveLength(2)
})

it('keeps a newer stream archive set when a deletion response arrives late and clears the last active record', async () => {
  let finish: (result: { archivedSessionIds: string[] }) => void = () => { throw new Error('Deletion not started') }
  vi.mocked(api.deleteAnalysis).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  render(<App />)
  emitArchives([], true)
  await waitFor(() => { expect(document.querySelectorAll('.session-record')).toHaveLength(2) })
  beginDelete('first')
  emitArchives(['first', 'second'])
  await act(async () => { finish({ archivedSessionIds: ['first'] }) })
  expect(document.querySelectorAll('.session-record')).toHaveLength(0)
  expect(screen.getByText(t('noSessions'))).toBeTruthy()
  expect(document.querySelectorAll('.session-item.active')).toHaveLength(0)
})

it('does not switch away from a different record selected while deletion is pending', async () => {
  let finish: (result: { archivedSessionIds: string[] }) => void = () => { throw new Error('Deletion not started') }
  vi.mocked(api.deleteAnalysis).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  render(<App />)
  emitArchives([], true)
  await waitFor(() => { expect(document.querySelectorAll('.session-record')).toHaveLength(2) })
  beginDelete('first')
  fireEvent.click(row('second').querySelector('.session-item')!)
  await act(async () => { finish({ archivedSessionIds: ['first'] }) })
  expect(document.querySelector('.session-record.active')?.getAttribute('data-session-id')).toBe('second')
})

it('renders the deletion confirmation for a retained keyless recorded Session', async () => {
  type Recorded = { type: string; id?: string; data?: { content?: Array<{ type: string; text?: string }>; source?: { kind: string } } }
  const events = recordedSession.trim().split('\n').map(line => JSON.parse(line) as Recorded)
  const id = events.find(event => event.type === 'session')?.id
  const title = events.find(event => event.type === 'user/message' && event.data?.source?.kind === 'user')
    ?.data?.content?.find(block => block.type === 'text')?.text?.slice(0, 80)
  if (!id || !title) throw new Error('Recorded Session has no header or user task')
  const rendered = render(<AnalysisRecord id={id} title={title} time="Now" active running={false} busy={false} select={vi.fn()} remove={vi.fn(async () => true)} />)
  fireEvent.click(screen.getByRole('button', { name: `${t('deleteAnalysis')} ${title}` }))
  await expect(rendered.container.innerHTML).toMatchFileSnapshot('./expected/analysis-record.html')
})
