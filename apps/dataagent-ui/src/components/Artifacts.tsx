/** Download links derived only from persisted, same-origin artifact metadata. */
import { Download, Eye } from 'lucide-react'
import { t } from '../copy.ts'

/** Render persisted deliverables without accepting arbitrary remote URLs. */
export function ArtifactLinks({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const items = Array.isArray(record.artifacts) ? record.artifacts : typeof record.url === 'string' ? [record] : []
  return (
    <div className="artifact-links">
      {items.map((item: Record<string, unknown>) =>
        typeof item.url === 'string' && item.url.startsWith('/api/data-agent/artifact?') ? (
          <span key={item.url}>
            <a href={item.url}>
              <Download size={14} />
              {typeof item.filename === 'string' ? item.filename : 'artifact'}
            </a>
            {typeof item.filename === 'string' && /\.(html|pdf|svg)$/u.test(item.filename) && (
              <a title={t('preview')} href={`${item.url}&preview=1`} target="_blank" rel="noreferrer">
                <Eye size={14} />
              </a>
            )}
          </span>
        ) : null,
      )}
    </div>
  )
}
