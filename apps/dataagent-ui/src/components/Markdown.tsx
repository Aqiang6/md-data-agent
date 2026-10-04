/** Safe Markdown and GFM rendering for documents, answers, and reports. */
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Render Markdown; request inspection can retain image syntax without fetching it. */
export function Markdown({ text, renderImages = true }: { text: string; renderImages?: boolean }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={renderImages ? undefined : {
          img: ({ src, alt }) => <code>{`![${alt ?? ''}](${src ?? ''})`}</code>,
        }}
      >{text}</ReactMarkdown>
    </div>
  )
}
