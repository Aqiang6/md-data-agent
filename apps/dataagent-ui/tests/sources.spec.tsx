// @vitest-environment jsdom
/** Database selection submits no table options and leaves the table list read-only. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SourceManager } from '../src/components/SourceManager.tsx'
import { executeCommand } from '../src/protocol/api.ts'
import { t } from '../src/copy.ts'

vi.mock('../src/protocol/api.ts', () => ({ executeCommand: vi.fn() }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks() })
const requestUrl = (input: RequestInfo | URL): string => typeof input === 'string'
  ? input : input instanceof URL ? input.href : input.url

it('shows all tables without checkboxes and applies databases without fetching unopened databases', async () => {
  const scope = { version: 2, sources: [{ database: 'shop.db' }, { database: 'other.db' }], defaultDatabase: 'shop.db' }
  const requests = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = requestUrl(input).replace('/api/data-agent/', '')
    if (path === 'sources') return Response.json({ sources: [
      { id: 'shop.db', name: 'shop.db', kind: 'sqlite' }, { id: 'other.db', name: 'other.db', kind: 'sqlite' },
    ], connections: [], databases: ['shop.db', 'other.db'] })
    if (path.startsWith('scope?')) return Response.json({ scope })
    if (path.startsWith('tables?')) return Response.json({ database: 'shop.db', markdown: '', documents: [],
      tables: [{ name: 'orders', columns: [{ name: 'id' }] }, { name: 'refunds', columns: [{ name: 'id' }] }] })
    throw new Error(`Unexpected source route: ${path}`)
  })
  const changed = vi.fn()
  const { container } = render(<SourceManager sessionId="source-test" close={vi.fn()} changed={changed} running={false} />)
  await screen.findByText('orders')
  expect(screen.getByText('refunds')).toBeTruthy()
  expect(screen.getByText(t('allTablesEnabled'))).toBeTruthy()
  expect(container.querySelectorAll('.table-list input')).toHaveLength(0)
  expect(container.querySelectorAll('.manager-source input[type="checkbox"]')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: t('applyScope') }))
  await waitFor(() => { expect(changed).toHaveBeenCalledOnce() })
  expect(executeCommand).toHaveBeenCalledWith('source-test', `/data_scope ${JSON.stringify(scope)}`)
  expect(requests.mock.calls.filter(([path]) => requestUrl(path).includes('/tables?'))).toHaveLength(1)
  expect(requests.mock.calls.some(([path]) => requestUrl(path).includes('database=other.db'))).toBe(false)
})
