// @vitest-environment jsdom
/** Post-answer report choices keep evidence in the journal and require explicit submission. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatStream } from '../src/components/Chat.tsx'
import { ReportActions, reportRequest } from '../src/components/ReportActions.tsx'
import { answerMarkdown } from '../src/state/answer.ts'
import type { ChatEntry } from '../src/state/fold.ts'
import { t } from '../src/copy.ts'

const answer: ChatEntry = {
  kind: 'assistant', key: 'answer', seq: 10, time: 1, turn: 1, step: 3,
  text: '# Analysis\n\nOrders: 42\n\n**证据**： [Result](private-result.md)',
}
afterEach(cleanup)

it('hides terminal evidence while preserving inline citations, code and later answer sections', () => {
  expect(answerMarkdown(answer.text)).toBe('# Analysis\n\nOrders: 42')
  expect(answerMarkdown('# Analysis\n\n## 证据\n\n- [Result](private.md)')).toBe('# Analysis')
  expect(answerMarkdown('# Analysis\n\n## Evidence\n\n### SQL\n\nReference')).toBe('# Analysis')
  for (const text of [
    'Inline [evidence](public.md) supports the conclusion.',
    '```md\n证据： This is a code example.\n```',
    '## 证据\n\nReference\n\n## Limitations\n\nRetained content',
    '证据不足，无法确认。',
  ]) expect(answerMarkdown(text)).toBe(text)
})

it('offers reports only on the final answer of a completed turn, without generating automatically', () => {
  const generate = vi.fn(async () => {})
  const intermediate = { ...answer, key: 'intermediate', seq: 5, text: 'Checking data' }
  const { rerender } = render(<ChatStream entries={[intermediate, answer]} running={false}
    completedTurns={[1]} generateReport={generate} />)
  expect(screen.getAllByRole('button', { name: t('report') })).toHaveLength(1)
  expect(document.querySelector('.msg-assistant:last-child .answer-actions')).not.toBeNull()
  expect(screen.queryByRole('link', { name: 'Result' })).toBeNull()
  expect(generate).not.toHaveBeenCalled()
  expect(answer.text).toContain('private-result.md')
  rerender(<ChatStream entries={[answer]} running={false} completedTurns={[]} generateReport={generate} />)
  expect(screen.queryByRole('button', { name: t('report') })).toBeNull()
  rerender(<ChatStream entries={[answer]} running={true} completedTurns={[1]} generateReport={generate} plain />)
  expect(screen.getByRole('button', { name: t('report') }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByText(/private-result/)).toBeNull()
})

it.each(['md', 'html', 'pdf'] as const)('sends the chosen %s format once and keeps it disabled while pending', async (format) => {
  let accept: () => void = () => { throw new Error('Request was not sent') }
  const generate = vi.fn(() => new Promise<void>((resolve) => { accept = resolve }))
  render(<ReportActions turn={2} disabled={false} generate={generate} />)
  fireEvent.change(screen.getByRole('combobox', { name: t('reportFormat') }), { target: { value: format } })
  fireEvent.click(screen.getByRole('button', { name: t('report') }))
  fireEvent.click(screen.getByRole('button', { name: t('report') }))
  expect(generate).toHaveBeenCalledExactlyOnceWith(2, format)
  expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(true)
  await act(async () => { accept() })
  expect(screen.getByRole('button', { name: t('report') }).hasAttribute('disabled')).toBe(false)
  const prompt = reportRequest(2, format)
  expect(prompt).toContain(format.toUpperCase())
  expect(prompt).toContain('2')
  expect(prompt).toContain('report')
})

it('retains the answer and selected format after a send failure and allows retry', async () => {
  const generate = vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce(undefined)
  render(<ChatStream entries={[answer]} running={false} completedTurns={[1]} generateReport={generate} />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'html' } })
  fireEvent.click(screen.getByRole('button', { name: t('report') }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('reportRequestFailed'))
  expect(screen.getByText('Orders: 42')).toBeDefined()
  expect(screen.getByRole('combobox')).toHaveProperty('value', 'html')
  fireEvent.click(screen.getByRole('button', { name: t('report') }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(generate).toHaveBeenCalledTimes(2)
})

it('records the compact report choices as an owner-local UI snapshot', () => {
  expect(renderToStaticMarkup(<ReportActions turn={1} disabled={false} generate={async () => {}} />)).toMatchSnapshot()
})
