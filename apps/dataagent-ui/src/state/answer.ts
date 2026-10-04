/** Answer display removes trailing reference sections without changing recorded model output. */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { RootContent, PhrasingContent } from 'mdast'

const parser = unified().use(remarkParse)
const evidenceTitle = /^(?:证据|证据清单|证据引用|查询证据|数据证据|证据与来源|evidence|sources|references)[:：]?$/iu

function inlineText(nodes: readonly PhrasingContent[]): string {
  return nodes.map(node => 'value' in node ? node.value : 'children' in node ? inlineText(node.children) : '').join('')
}

function evidenceMarker(node: RootContent): boolean {
  if (node.type !== 'heading' && node.type !== 'paragraph') return false
  const text = inlineText(node.children).trim()
  if (node.type === 'heading') return evidenceTitle.test(text)
  return /^(?:证据|证据清单|证据引用|查询证据|数据证据|evidence|sources|references)\s*[:：]/iu.test(text)
}

/** Strip only a terminal evidence section; code, ordinary inline citations and later sections remain intact.
 * @param text - Original assistant Markdown; the Session event remains unchanged.
 * @returns Answer Markdown without its trailing evidence block.
 */
export function answerMarkdown(text: string): string {
  const tree = parser.parse(text)
  const index = tree.children.findIndex((node, index) => evidenceMarker(node)
    && !tree.children.slice(index + 1).some(later => later.type === 'heading'
      && (node.type !== 'heading' || later.depth <= node.depth)))
  const offset = index < 0 ? undefined : tree.children[index]?.position?.start.offset
  return offset === undefined ? text : text.slice(0, offset).trimEnd()
}
