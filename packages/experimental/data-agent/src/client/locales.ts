/**
 * Dictionary for the Data Agent database dock. `zh` owns the key set; `en` is
 * checked complete against it.
 * @module @deepseek-ai/dsh-experimental-data-agent/client/locales
 */

/** Dictionary keys owned by the `dataAgent` namespace. */
export type DataAgentKey =
  | 'label'
  | 'placeholder'
  | 'none'

/** Database picker dictionary namespace. */
export const NS = 'dataAgent'

/** Chinese picker labels. */
export const zh: Record<DataAgentKey, string> = {
  label: '数据库',
  placeholder: '选择数据库…',
  none: '（无可用数据库）',
}

/** English picker labels. */
export const en: Record<DataAgentKey, string> = {
  label: 'Database',
  placeholder: 'Select a database…',
  none: '(no databases)',
}
