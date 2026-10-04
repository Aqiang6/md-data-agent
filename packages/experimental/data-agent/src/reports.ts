/** Markdown-source reports with data-bound values and immutable deliverables. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import MarkdownIt from 'markdown-it'
import { chromium } from 'playwright'
import { z } from 'zod'
import type { DataCore, DocumentRef } from './data-core.ts'
import { ArtifactId, ReportId } from './brand.ts'

const escape = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
const renderer = new MarkdownIt({ html: false, linkify: false })

/** Artifact descriptor accepted by the download endpoint. */
export interface ArtifactRef {
  artifactId: ArtifactId
  filename: string
  url: string
  version: string
}

/** Resolve an artifact descriptor from the owning Session's persisted manifest.
 * @param data - artifact store.
 * @param sessionId - owning Session.
 * @param artifactId - artifact identity, never a filesystem path.
 * @returns validated descriptor suitable for a final submission.
 */
export async function artifactReference(
  data: DataCore,
  sessionId: string,
  artifactId: string,
): Promise<ArtifactRef> {
  const id = z.uuid().parse(artifactId)
  const manifest = z
    .object({
      artifactId: z.uuid(),
      filename: z.string().min(1).refine(filename => filename !== 'manifest.json' && filename !== '.' && filename !== '..' && !filename.includes('/') && !filename.includes('\\') && !filename.includes('\0')),
      version: z.string().regex(/^[a-f0-9]{64}$/u),
      url: z.string(),
    })
    .parse(
      JSON.parse(
        await readFile(
          join(data.root(sessionId), 'artifacts', id, 'manifest.json'),
          'utf8',
        ),
      ),
    )
  const expectedUrl = `/api/data-agent/artifact?sessionId=${encodeURIComponent(sessionId)}&artifactId=${id}&filename=${encodeURIComponent(manifest.filename)}`
  if (manifest.artifactId !== id || manifest.url !== expectedUrl)
    throw new Error('Artifact manifest does not match its owner or identity.')
  return { ...manifest, artifactId: ArtifactId(id) }
}
/** Chart artifact and exact source columns. */
export interface ChartRef extends ArtifactRef {
  resultId: string
  x: string
  y: string
  rowCount: number
}
/** Immutable report revision and downloadable formats. */
export interface ReportRef extends ReportOptions {
  reportId: ReportId
  document: Pick<DocumentRef, 'version' | 'title' | 'path'>
  artifacts: ArtifactRef[]
  resultIds: string[]
  version: string
}

/** Persist an artifact owned by a session.
 * @param data - data storage.
 * @param sessionId - owning session.
 * @param filename - artifact basename.
 * @param content - bytes to persist.
 * @returns immutable artifact descriptor.
 */
export async function artifact(
  data: DataCore,
  sessionId: string,
  filename: string,
  content: string | Buffer,
): Promise<ArtifactRef> {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(filename) ||
    filename === 'manifest.json'
  ) {
    throw new Error(
      'Artifact filename must be a safe basename other than manifest.json.',
    )
  }
  const artifactId = ArtifactId(randomUUID())
  const version = createHash('sha256').update(content).digest('hex')
  const directory = join(data.root(sessionId), 'artifacts', artifactId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, filename), content, { flag: 'wx' })
  const ref = {
    artifactId,
    filename,
    version,
    url: `/api/data-agent/artifact?sessionId=${encodeURIComponent(sessionId)}&artifactId=${artifactId}&filename=${encodeURIComponent(filename)}`,
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(ref), {
    flag: 'wx',
  })
  return ref
}

/** Render a deterministic data-bound bar chart.
 * @param data - data storage.
 * @param sessionId - evidence owner.
 * @param resultId - complete result.
 * @param x - label field.
 * @param y - numeric field.
 * @param title - chart title.
 * @returns chart and evidence manifest.
 */
export async function chart(
  data: DataCore,
  sessionId: string,
  resultId: string,
  x: string,
  y: string,
  title: string,
): Promise<ChartRef> {
  const result = await data.result(sessionId, resultId)
  if (!result.columns.includes(x) || !result.columns.includes(y))
    throw new Error('Chart fields must exist in the result.')
  if (result.rows.length > data.config.maxChartPoints)
    throw new Error('Too many chart points; aggregate the result first.')
  const values = result.rows.map((row) => {
    const value = row[y]
    if (value === null || value === '' || !Number.isFinite(Number(value)))
      throw new Error('Chart requires finite numeric values.')
    return Number(value)
  })
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const range = max - min || 1
  const width = 840
  const height = 100 + result.rows.length * 38
  const baseline = 190 + ((0 - min) / range) * 530
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><text x="20" y="30" font-family="sans-serif" font-size="20">${escape(title)}</text>${result.rows
    .map((row, index) => {
      const value = values[index] ?? 0
      const end = 190 + ((value - min) / range) * 530
      const yPosition = 64 + index * 38
      return `<text x="12" y="${yPosition + 17}" font-family="sans-serif" font-size="12">${escape(String(row[x]).slice(0, 24))}</text><rect x="${Math.min(baseline, end)}" y="${yPosition}" width="${Math.abs(end - baseline)}" height="25" fill="${value >= 0 ? '#157f69' : '#b63853'}"/><text x="${Math.max(baseline, end) + 8}" y="${yPosition + 17}" font-family="sans-serif" font-size="12">${escape(String(row[y]))}</text>`
    })
    .join('')}</svg>`
  const ref = await artifact(data, sessionId, 'chart.svg', svg)
  await writeFile(
    join(data.root(sessionId), 'artifacts', ref.artifactId, 'evidence.json'),
    JSON.stringify({ resultId, x, y }),
  )
  return { ...ref, resultId, x, y, rowCount: result.rows.length }
}

/** Requested report language, chart evidence, and immutable revision parent. */
export interface ReportOptions {
  language?: string
  chartIds?: string[]
  revisionOf?: { reportId: string; version: string }
}

/** Generate selected formats from one Markdown source; value placeholders bind actual results.
 * @param data - data storage and rendering limits.
 * @param sessionId - evidence owner.
 * @param title - report title.
 * @param markdown - narrative with optional {{result:id:row:column}} values.
 * @param resultIds - evidence result references.
 * @param formats - requested output formats.
 * @param signal - rendering cancellation.
 * @param options - language, charts, and revision parent.
 * @returns report version and downloadable artifacts.
 */
export async function report(
  data: DataCore,
  sessionId: string,
  title: string,
  markdown: string,
  resultIds: string[],
  formats: Array<'md' | 'html' | 'pdf'>,
  signal: AbortSignal,
  options: ReportOptions = {},
): Promise<ReportRef> {
  signal.throwIfAborted()
  if (!formats.length) throw new Error('Select at least one report format.')
  let reportId = ReportId(randomUUID())
  if (options.revisionOf) {
    if (
      !/^[a-f0-9-]{36}$/u.test(options.revisionOf.reportId) ||
      !/^[a-f0-9]{64}$/u.test(options.revisionOf.version)
    )
      throw new Error('Invalid report revision parent.')
    await readFile(
      join(
        data.root(sessionId),
        'reports',
        `${options.revisionOf.reportId}-${options.revisionOf.version}.json`,
      ),
      'utf8',
    )
    reportId = ReportId(options.revisionOf.reportId)
  }
  const results = new Map(
    await Promise.all(
      resultIds.map(
        async id => [id, await data.result(sessionId, id)] as const,
      ),
    ),
  )
  const bound = markdown.replace(
    /\{\{result:([a-f0-9-]{36}):(\d+):([^}]+)\}\}/gu,
    (_match: string, id: string, rowIndex: string, column: string) => {
      const result = results.get(id)
      const row = result?.rows[Number(rowIndex)]
      if (row === undefined || !result?.columns.includes(column))
        throw new Error(
          'Report contains an invalid or unlisted evidence placeholder.',
        )
      return String(row[column] ?? 'null')
    },
  )
  const charts = new Map<string, Buffer>()
  let chartMarkdown = ''
  for (const id of options.chartIds ?? []) {
    const bytes = await readArtifact(data, sessionId, id, 'chart.svg')
    const evidence = JSON.parse(
      await readFile(
        join(data.root(sessionId), 'artifacts', id, 'evidence.json'),
        'utf8',
      ),
    ) as { resultId: string }
    if (!results.has(evidence.resultId))
      throw new Error('Every chart must reference a listed resultId.')
    const url = `/api/data-agent/artifact?sessionId=${encodeURIComponent(sessionId)}&artifactId=${id}&filename=chart.svg`
    charts.set(url, bytes)
    chartMarkdown += `![Chart](${url})\n\n`
  }
  let content = `# ${title}\n\n${bound}\n\n${chartMarkdown}${resultIds.length ? '## Evidence\n\n' : ''}`
  for (const [id, result] of results)
    content += `### ${id}\n\nComplete rows: ${result.rows.length}. Preview rows: ${Math.min(result.rows.length, data.config.maxRows)}.\n\n\`\`\`json\n${JSON.stringify(result.rows.slice(0, data.config.maxRows), null, 2)}\n\`\`\`\n\n`
  const version = createHash('sha256').update(content).digest('hex')
  const directory = join(data.root(sessionId), 'reports')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${reportId}-${version}.md`)
  await writeFile(path, content, { flag: 'wx' })
  const source = { version, title, path: path.replaceAll('\\', '/') }
  let rendered = renderer.render(content)
  for (const [url, bytes] of charts)
    rendered = rendered.replaceAll(
      `src="${escape(url)}"`,
      `src="data:image/svg+xml;base64,${bytes.toString('base64')}"`,
    )
  const html = `<!doctype html><html lang="${escape(options.language ?? 'zh')}"><head><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:14px "Microsoft YaHei","Noto Sans CJK SC",sans-serif;color:#17251f;max-width:960px;margin:36px auto;padding:0 24px;line-height:1.65}h1,h2,h3{font-weight:500}img,svg{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f4;padding:12px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd7d0;padding:6px}h2,h3{break-after:avoid}tr,img{break-inside:avoid}@page{size:A4;margin:18mm}</style></head><body>${rendered}</body></html>`
  const artifacts: ArtifactRef[] = []
  if (formats.includes('md'))
    artifacts.push(await artifact(data, sessionId, 'report.md', content))
  if (formats.includes('html'))
    artifacts.push(await artifact(data, sessionId, 'report.html', html))
  if (formats.includes('pdf')) {
    const browser = await chromium.launch({
      ...(data.config.browserExecutablePath
        ? { executablePath: data.config.browserExecutablePath }
        : {}),
      headless: true,
    })
    const abort = (): void => {
      void browser.close()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const page = await browser.newPage()
      await page.route('**/*', route => route.abort())
      await page.setContent(html, {
        waitUntil: 'load',
        timeout: data.config.queryTimeoutMs,
      })
      signal.throwIfAborted()
      await page.evaluate(() => document.fonts.ready)
      const pdf = await page.pdf({ format: 'A4', printBackground: true })
      signal.throwIfAborted()
      artifacts.push(await artifact(data, sessionId, 'report.pdf', pdf))
    } finally {
      signal.removeEventListener('abort', abort)
      await browser.close()
    }
  }
  const manifest = {
    reportId,
    document: source,
    artifacts,
    resultIds,
    version: source.version,
    ...options,
  }
  await writeFile(
    join(data.root(sessionId), 'reports', `${reportId}-${source.version}.json`),
    JSON.stringify(manifest),
    { flag: 'wx' },
  )
  return manifest
}

/** Read an artifact by its manifest, never by a supplied filesystem path.
 * @param data - artifact store.
 * @param sessionId - owning session.
 * @param artifactId - artifact identity.
 * @param filename - exact manifest filename.
 * @returns bytes, or an error for an invalid or unowned name.
 */
export async function readArtifact(
  data: DataCore,
  sessionId: string,
  artifactId: string,
  filename: string,
): Promise<Buffer> {
  const manifest = await artifactReference(data, sessionId, artifactId)
  if (manifest.filename !== filename)
    throw new Error('Artifact filename does not match its manifest.')
  const bytes = await readFile(
    join(data.root(sessionId), 'artifacts', manifest.artifactId, filename),
  )
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.version)
    throw new Error('Artifact content does not match its recorded version.')
  return bytes
}
