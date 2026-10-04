/** Analysis navigation row with independently confirmed record removal. */
import { useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle, Trash2, X } from 'lucide-react'
import { t } from '../copy.ts'

/**
 * Keep record selection separate from deletion and retain confirmation on failure.
 * @param props - Record state and actions; removal resolves false after reporting a failure.
 * @returns Sidebar row and its inline confirmation.
 */
export function AnalysisRecord({ id, title, time, active, running, busy, disabled = false, select, remove }: {
  id: string
  title: string
  time: string
  active: boolean
  running: boolean
  busy: boolean
  disabled?: boolean
  select: () => void
  remove: () => Promise<boolean>
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const cancel = () => {
    setConfirming(false)
    deleteButton.current?.focus()
  }
  useEffect(() => {
    if (!confirming) return
    cancelButton.current?.focus()
    const outside = (event: PointerEvent) => {
      if (!busy && event.target instanceof Node && !root.current?.contains(event.target)) setConfirming(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('pointerdown', outside) }
  }, [confirming, busy])
  return (
    <div className={`session-record${active ? ' active' : ''}`} data-session-id={id} ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && confirming && !busy) { event.stopPropagation(); cancel() }
      }}>
      <div className="session-record-heading">
        <button type="button" className={`session-item${active ? ' active' : ''}`} onClick={select} aria-current={active ? 'page' : undefined}>
          <span className={`session-dot${running ? ' live' : ''}`} />
          <span className="session-title">{title}</span>
          <span className="session-time">{time}</span>
        </button>
        <button type="button" className="session-delete" ref={deleteButton}
          disabled={busy || running || disabled} aria-label={`${t('deleteAnalysis')} ${title}`}
          title={running ? t('stopBeforeDelete') : t('deleteAnalysis')}
          onClick={() => { setConfirming(true) }}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
        </button>
      </div>
      {confirming && <div className="session-delete-confirm" role="group" aria-label={t('confirmDeleteAnalysis')}>
        <p>{t('deleteAnalysisNotice')}</p>
        {running && <p>{t('stopBeforeDelete')}</p>}
        <div>
          <button type="button" className="session-delete-accept" disabled={busy || running || disabled}
            onClick={() => { void remove().then((removed) => { if (removed) setConfirming(false) }) }}>
            <Check size={14} />{t('confirmDeleteAnalysis')}
          </button>
          <button type="button" className="session-delete" ref={cancelButton} disabled={busy}
            aria-label={t('cancelOperation')} title={t('cancelOperation')} onClick={cancel}><X size={15} /></button>
        </div>
      </div>}
    </div>
  )
}
