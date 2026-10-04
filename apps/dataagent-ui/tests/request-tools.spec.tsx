// @vitest-environment jsdom
/** Request-specific purposes retain original definitions and unknown tool descriptions. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RequestTools } from '../src/components/RequestTools.tsx'
import { t } from '../src/copy.ts'

const names = ['read', 'grep', 'find', 'ls', 'sql', 'report', 'benchmark', 'ask',
  'list_sources', 'search_documents', 'read_document', 'import_dataset', 'query_database', 'analyze_data', 'render_chart', 'generate_report', 'submit_analysis', 'ask_user_question', 'list_databases', 'present', 'subagent', 'workflow']
const raw = JSON.stringify(names.map(name => ({ name, description: `Original ${name}`, parameters: { type: 'object' } })), null, 2)

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(['zh-CN', 'en-US'])('explains each recorded tool in %s without replacing its original definitions', (language) => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language)
  render(<RequestTools raw={raw} />)
  const table = screen.getByRole('table', { name: t('toolPurposes') })
  expect(table.querySelectorAll('tbody tr')).toHaveLength(names.length)
  expect([...table.querySelectorAll('tbody tr')].map(row => row.textContent)).toMatchSnapshot()
  expect(document.querySelector('pre')?.textContent).toBe(raw)
})

it('shows only recorded tools and preserves an unknown tool description without clipping', () => {
  const description = 'Custom description '.repeat(1000) + 'FINAL DESCRIPTION'
  const original = JSON.stringify([{ name: 'toString', description }, { name: 'new_tool' }])
  render(<RequestTools raw={original} />)
  expect(screen.getAllByRole('row')).toHaveLength(3)
  expect(screen.getByRole('cell', { name: description }).textContent).toBe(description)
  expect(screen.getByText(t('unavailable'))).toBeDefined()
  expect(screen.queryByText('query_database')).toBeNull()
  expect(document.querySelector('pre')?.textContent).toBe(original)
})

it.each(['{incomplete JSON', '{"tools":[]}', '[null, {"name":123}]', '[]'])('retains unrecognized or empty historical JSON: %s', (original) => {
  render(<RequestTools raw={original} />)
  expect(screen.queryByRole('table')).toBeNull()
  expect(document.querySelector('pre')?.textContent).toBe(original)
})
