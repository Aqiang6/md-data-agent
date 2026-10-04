/**
 * DbDock: the database picker docked above the composer (input dock strip).
 * The available databases and the durable `/db` selection arrive through the
 * `glmDb` session projection; picking an entry submits a `/db <name>` command
 * through the composer, so the selection is logged exactly like a typed one.
 */
import type { CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Props for the projected database dock. */
export type DbDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'dataAgent'>

/** Strip height shared by the picker row. */
const STRIP_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 12px',
  fontSize: 12,
}

/**
 * Render the database picker, or nothing while the projection is absent.
 * @param props - framework session props plus the dock's locale.
 * @returns the picker strip element.
 */
export function DbDock({ useProjection, inputActions, t }: DbDockProps) {
  const state = useProjection('glmDb')
  if (state === undefined) return null
  const select = (name: string): void => {
    if (name === '') return
    inputActions.setDraft(`/db ${name}`)
    inputActions.submit()
  }
  return (
    <div role="toolbar" aria-label={t('label')} style={STRIP_STYLE}>
      <span style={{ color: 'var(--dsh-text-secondary, #666)' }}>{t('label')}</span>
      <select
        value={state.selected ?? ''}
        disabled={state.databases.length === 0}
        onChange={(event) =>{  select(event.target.value) }}
        style={{ minWidth: 160, maxWidth: 240 }}
      >
        <option value="">{state.databases.length === 0 ? t('none') : t('placeholder')}</option>
        {state.databases.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
    </div>
  )
}
