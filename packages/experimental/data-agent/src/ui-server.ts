/**
 * Static file and UI serving for Data Agent: the built
 * React app under `/da-assets`, the database-list endpoint under `/da-api`,
 * and an index tap that swaps the workbench index for the data-agent shell.
 * @module @deepseek-ai/dsh-experimental-data-agent/ui-server
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

/** Minimal MIME table covering every file a Vite build emits. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** Resolve one UI directory against the process cwd.
 * @param uiDist - configured relative or absolute path.
 * @returns absolute UI directory.
 */
export function resolveUiDist(uiDist: string): string {
  return resolve(process.cwd(), uiDist)
}

/**
 * Whether the configured UI dist is buildable to serve: the directory must
 * contain a built `index.html`.
 * @param uiDistRoot - absolute dist directory.
 * @returns whether the built index exists.
 */
export function uiIndexExists(uiDistRoot: string): boolean {
  return uiDistRoot.length > 0 && existsSync(join(uiDistRoot, 'index.html'))
}

/**
 * Serve one static file from the dist root, refusing paths that escape it.
 * @param res - the response to own.
 * @param uiDistRoot - absolute dist directory.
 * @param relativePath - URL path after the mount prefix, `/`-separated.
 */
function serveFile(res: ServerResponse, uiDistRoot: string, relativePath: string): void {
  const cleaned = normalize(relativePath).replace(/^([.][.](\\|\/|$))+/u, '')
  const file = resolve(uiDistRoot, cleaned)
  if (!file.startsWith(uiDistRoot + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}

/**
 * Register the data-agent UI surface on the webserver: the asset prefix, the
 * database-list endpoint, and the index tap. Registration is skipped with a
 * console note when the dist is not built, leaving the shipped workbench UI.
 * @param webServer - the host web carrier service.
 * @param uiDistRoot - absolute dist directory with a built index.html.
 * @param listDatabasesFn - the deployment's exposed database names.
 * @param rejection - Connection authentication and Host/Origin check.
 * @returns the disposer removing every registration.
 */
export function registerUiSurface(
  webServer: WebServer,
  uiDistRoot: string,
  listDatabasesFn: () => string[],
  rejection: (request: IncomingMessage) => 401 | 403 | undefined,
): () => void {
  const disposers = [
    webServer.register({
      kind: 'prefix',
      path: '/da-assets',
      handler(_req: IncomingMessage, res: ServerResponse): void {
        const url = new URL(_req.url ?? '/', 'http://localhost')
        serveFile(res, uiDistRoot, url.pathname.slice('/da-assets/'.length) || 'index.html')
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/da-api/databases',
      handler(_req: IncomingMessage, res: ServerResponse): void {
        const status = rejection(_req)
        if (status !== undefined) { res.writeHead(status); res.end('unauthorized'); return }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ databases: listDatabasesFn() }))
      },
    }),
    webServer.tapIndex((html: string): string => {
      const index = join(uiDistRoot, 'index.html')
      if (!existsSync(index)) return html
      return `<!-- served by @deepseek-ai/dsh-experimental-data-agent -->\n${readFileSync(index, 'utf8')}`
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
