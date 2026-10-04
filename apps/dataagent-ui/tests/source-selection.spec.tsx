// @vitest-environment jsdom
/** Source selection creates a missing analysis before dispatching its durable command. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import * as api from '../src/protocol/api.ts'
import { t } from '../src/copy.ts'
import type { MuxHandlers } from '../src/protocol/mux.ts'
import sourceSelection from './expected/source-selection.json'

const streams = vi.hoisted(() => new Map<string, MuxHandlers>())
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
vi.mock('../src/protocol/api.ts', async original => ({
  ...await original<typeof api>(), listSessions: vi.fn(), createSession: vi.fn(), executeCommand: vi.fn(),
}))
vi.mock('../src/protocol/sources.ts', () => ({ sourceRequest: vi.fn(async () => ({
  sources: [{ id: 'shop.db', name: 'Shop', kind: 'sqlite' }], connections: [], scope: null,
})) }))
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
vi.mock('../src/components/SourceManager.tsx', () => ({
  SourceManager: ({ sessionId }: { sessionId: string }) => <div data-testid="source-manager">{sessionId}</div>,
}))

const record = { sessionId: 'created', updatedAt: 1, running: false, blank: true, projections: { values: { agentPreset: 'data-agent' } } }
const picker = () => screen.getByRole('combobox', { name: t('chooseSource') })
const sourceCard = () => document.querySelector<HTMLButtonElement>('.source-row')!
const start = async () => {
  render(<App />)
  act(() => { streams.get('workspace/follow')!.onItem({ type: 'baseline', value: { archivedSessionIds: [] } }) })
  await waitFor(() => { expect(sourceCard()).toBeTruthy() })
}

beforeEach(() => {
  vi.resetAllMocks()
  streams.clear()
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true })
  vi.mocked(api.listSessions).mockResolvedValue({ items: [] })
  vi.mocked(api.createSession).mockImplementation(async () => {
    vi.mocked(api.listSessions).mockResolvedValue({ items: [record] })
    return { sessionId: record.sessionId }
  })
  vi.mocked(api.executeCommand).mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalScroll) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScroll)
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

it('excludes recovered coding sessions and creates an analysis when a source is selected', async () => {
  vi.mocked(api.listSessions).mockResolvedValue({ items: [
    { ...record, sessionId: 'old-coding-session', projections: { values: { agentPreset: 'standard' } } },
  ] })
  await start()
  expect(document.querySelectorAll('.session-record')).toHaveLength(0)
  fireEvent.click(sourceCard())
  await waitFor(() => { expect(api.executeCommand).toHaveBeenCalledExactlyOnceWith('created', '/db shop.db') })
  expect(api.createSession).toHaveBeenCalledOnce()
  expect(document.querySelector('[data-session-id="old-coding-session"]')).toBeNull()
  expect(document.querySelector('.session-record.active')?.getAttribute('data-session-id')).toBe('created')
})

it.each(['card', 'picker'])('creates one analysis from the home %s and applies the chosen source after creation', async (entry) => {
  let finish!: (value: { sessionId: string }) => void
  vi.mocked(api.createSession).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  await start()
  if (entry === 'card') fireEvent.click(sourceCard())
  else fireEvent.change(picker(), { target: { value: 'shop.db' } })
  expect(api.createSession).toHaveBeenCalledOnce()
  expect(api.executeCommand).not.toHaveBeenCalled()
  expect(picker()).toHaveProperty('disabled', true)
  expect(sourceCard().disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: t('newAnalysis'), exact: true }))
  fireEvent.click(screen.getByRole('button', { name: t('manageSources'), exact: true }))
  expect(api.createSession).toHaveBeenCalledOnce()
  vi.mocked(api.listSessions).mockResolvedValue({ items: [record] })
  await act(async () => { finish({ sessionId: record.sessionId }) })
  expect(api.executeCommand).toHaveBeenCalledExactlyOnceWith('created', '/db shop.db')
  expect(document.querySelector('.session-record.active')?.getAttribute('data-session-id')).toBe('created')
  expect(picker()).toHaveProperty('disabled', false)
  expect(screen.queryByText(t('createSessionFirst'))).toBeNull()
  act(() => { streams.get('session/follow')!.onItem({
    type: 'snapshot', cursor: sourceSelection.records.at(-1)!.event.seq, ...sourceSelection,
  }) })
  expect(picker()).toHaveProperty('value', 'shop.db')
})

it('uses the current analysis for both source selection entries', async () => {
  vi.mocked(api.listSessions).mockResolvedValue({ items: [record] })
  await start()
  await waitFor(() => { expect(document.querySelector('.session-record.active')).toBeTruthy() })
  fireEvent.click(sourceCard())
  fireEvent.change(picker(), { target: { value: 'shop.db' } })
  await waitFor(() => { expect(api.executeCommand).toHaveBeenCalledTimes(2) })
  expect(api.executeCommand).toHaveBeenNthCalledWith(1, 'created', '/db shop.db')
  expect(api.executeCommand).toHaveBeenNthCalledWith(2, 'created', '/db shop.db')
  expect(api.createSession).not.toHaveBeenCalled()
})

it('retains an empty home on creation failure and allows retry', async () => {
  vi.mocked(api.createSession).mockRejectedValueOnce(new Error('offline'))
  await start()
  fireEvent.click(sourceCard())
  await screen.findByText(`${t('createSessionFailed')}: Error: offline`)
  expect(api.executeCommand).not.toHaveBeenCalled()
  expect(document.querySelector('.session-record')).toBeNull()
  expect(sourceCard().disabled).toBe(false)
  fireEvent.click(sourceCard())
  await waitFor(() => { expect(api.executeCommand).toHaveBeenCalledWith('created', '/db shop.db') })
  expect(api.createSession).toHaveBeenCalledTimes(2)
  expect(screen.queryByText(`${t('createSessionFailed')}: Error: offline`)).toBeNull()
})

it('retains the created analysis when source selection fails and retries in that analysis', async () => {
  vi.mocked(api.executeCommand).mockRejectedValueOnce(new Error('source unavailable'))
  await start()
  fireEvent.click(sourceCard())
  await screen.findByText(`${t('chooseSourceFailed')}: Error: source unavailable`)
  expect(document.querySelector('.session-record.active')?.getAttribute('data-session-id')).toBe('created')
  fireEvent.click(sourceCard())
  await waitFor(() => { expect(api.executeCommand).toHaveBeenCalledTimes(2) })
  expect(api.createSession).toHaveBeenCalledOnce()
  expect(api.executeCommand).toHaveBeenLastCalledWith('created', '/db shop.db')
})

it('opens source management after creating an analysis from the empty home', async () => {
  await start()
  fireEvent.click(screen.getByRole('button', { name: t('manageSources'), exact: true }))
  expect(await screen.findByTestId('source-manager')).toHaveProperty('textContent', 'created')
  expect(api.createSession).toHaveBeenCalledOnce()
  expect(api.executeCommand).not.toHaveBeenCalled()
})
