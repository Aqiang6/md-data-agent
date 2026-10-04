/** Localized tool purposes alongside the unchanged request declarations. */
import { useMemo } from 'react'
import { t } from '../copy.ts'

const purposes: Readonly<Record<string, Parameters<typeof t>[0]>> = {
  read: 'purposeRead',
  grep: 'purposeGrep', find: 'purposeFind', ls: 'purposeLs',
  sql: 'purposeSql', report: 'purposeReport', benchmark: 'purposeBenchmark', ask: 'purposeAskUserQuestion',
  list_sources: 'purposeListSources',
  list_databases: 'purposeListDatabases',
  search_documents: 'purposeSearchDocuments',
  read_document: 'purposeReadDocument',
  import_dataset: 'purposeImportDataset',
  query_database: 'purposeQueryDatabase',
  analyze_data: 'purposeAnalyzeData',
  render_chart: 'purposeRenderChart',
  generate_report: 'purposeGenerateReport',
  submit_analysis: 'purposeSubmitAnalysis',
  ask_user_question: 'purposeAskUserQuestion',
  present: 'purposePresent',
  subagent: 'purposeSubagent',
  workflow: 'purposeWorkflow',
}

interface Declaration {
  name: string
  description?: string
}

function declarations(raw: string): Declaration[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (_error) {
    // Unrecognized historical declarations remain readable in the original JSON.
    return []
  }
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || !('name' in item) || typeof item.name !== 'string') return []
    return [{
      name: item.name,
      ...('description' in item && typeof item.description === 'string' ? { description: item.description } : {}),
    }]
  })
}

/** Explain only the tools supplied to this recorded request; retain their complete JSON.
 * @param props - Complete tool declarations from the immutable request snapshot.
 * @returns Purpose table followed by the original definitions without clipping.
 */
export function RequestTools({ raw }: { raw: string }) {
  const tools = useMemo(() => declarations(raw), [raw])
  return <>
    {tools.length > 0 && <>
      <table className="request-tools" aria-label={t('toolPurposes')}>
        <thead><tr><th>{t('tools')}</th><th>{t('toolPurpose')}</th></tr></thead>
        <tbody>{tools.map((tool, index) => {
          const purpose = Object.hasOwn(purposes, tool.name) ? purposes[tool.name] : undefined
          return <tr key={`${index}:${tool.name}`}>
            <th scope="row"><code>{tool.name}</code></th>
            <td>{purpose ? t(purpose) : tool.description ?? t('unavailable')}</td>
          </tr>
        })}</tbody>
      </table>
      <h4 className="request-definitions">{t('originalDefinitions')}</h4>
    </>}
    <pre>{raw}</pre>
  </>
}
