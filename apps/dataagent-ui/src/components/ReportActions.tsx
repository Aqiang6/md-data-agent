/** Explicit report generation after a completed answer, using the existing logged prompt route. */
import { useRef, useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { t } from '../copy.ts'

/** Report formats accepted by the Data Agent report tool. */
export type ReportFormat = 'md' | 'html' | 'pdf'

/** Build the user-selected report request; no hidden model context is added.
 * @param turn - Completed analysis turn being reported.
 * @param format - User-selected output format.
 * @returns Follow-up prompt logged through the normal session API.
 */
export function reportRequest(turn: number, format: ReportFormat): string {
  return t('reportRequest').replace('{turn}', String(turn)).replace('{format}', format.toUpperCase())
}

/** Display report choices without generating until the user confirms.
 * @param props - Completed answer, session busy state and logged request callback.
 * @returns Compact report controls with retained error feedback.
 */
export function ReportActions({ turn, disabled, generate }: {
  turn: number
  disabled: boolean
  generate: (turn: number, format: ReportFormat) => Promise<unknown>
}) {
  const [format, setFormat] = useState<ReportFormat>('pdf')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const pending = useRef(false)
  const submit = async () => {
    if (pending.current || disabled) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try { await generate(turn, format) }
    catch (_error) { setError(t('reportRequestFailed')) }
    finally { pending.current = false; setBusy(false) }
  }
  return <div className="answer-actions">
    <label className="report-format">
      <span>{t('reportFormat')}</span>
      <select aria-label={t('reportFormat')} value={format} disabled={disabled || busy} onChange={(event) => {
        const value = event.target.value
        if (value === 'md' || value === 'html' || value === 'pdf') setFormat(value)
      }}>
        <option value="pdf">PDF</option>
        <option value="html">HTML</option>
        <option value="md">Markdown</option>
      </select>
    </label>
    <button type="button" disabled={disabled || busy} onClick={() => { void submit() }}>
      {busy ? <Loader2 size={15} className="spin" /> : <FileText size={15} />}{t('report')}
    </button>
    {error && <p role="alert">{error}</p>}
  </div>
}
