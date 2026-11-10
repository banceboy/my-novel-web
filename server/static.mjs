/**
 * 生产静态托管（零依赖）+ 安全响应头。
 *
 * 网页构建产物在 dist-web/；网关单端口同时提供页面与 /api，
 * 不需要在生产环境跑 Vite dev server，也不需要反向代理额外配置。
 * index.html 里的内联主题脚本用一次性 nonce 放行，其余脚本只允许同源外链。
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { createGzip } from 'node:zlib'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|wasm)|image\/svg\+xml)/

export function securityHeaders({ secure = false, nonce = '' } = {}) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  }
  if (secure) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
  return headers
}

export class StaticHost {
  constructor(root) {
    this.root = path.resolve(root)
  }

  get available() {
    return existsSync(path.join(this.root, 'index.html'))
  }

  resolve(urlPath) {
    let decoded
    try { decoded = decodeURIComponent(urlPath) }
    catch { return null }
    const candidate = path.resolve(this.root, `.${decoded}`)
    if (candidate !== this.root && !candidate.startsWith(this.root + path.sep)) return null
    return candidate
  }

  sendFile(res, file, { nonce = '', req } = {}) {
    const stat = statSync(file)
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    const isHtml = path.extname(file).toLowerCase() === '.html'
    const headers = {
      'Content-Type': type,
      'Cache-Control': isHtml
        ? 'no-store'
        : file.includes(`${path.sep}assets${path.sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
    }
    const acceptGzip = /\bgzip\b/.test(String(req?.headers?.['accept-encoding'] ?? ''))
    if (acceptGzip && COMPRESSIBLE.test(type) && !isHtml) {
      headers['Content-Encoding'] = 'gzip'
      headers.Vary = 'Accept-Encoding'
      res.writeHead(200, headers)
      createReadStream(file).pipe(createGzip()).pipe(res)
      return
    }
    headers['Content-Length'] = stat.size
    res.writeHead(200, headers)
    if (isHtml) {
      // 给所有内联 script 注入 nonce；外链脚本继续由 'self' 放行
      const source = readFileSync(file, 'utf8')
      const patched = source.replace(/<script(?![^>]*\bsrc=)/gi, `<script nonce="${nonce}"`)
      res.end(Buffer.from(patched, 'utf8'))
      return
    }
    createReadStream(file).pipe(res)
  }

  serve(req, res, url, nonce) {
    if (!this.available) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('网页构建产物不存在：请先执行 pnpm run build:web（开发模式请用 Vite dev server）')
      return
    }
    const target = this.resolve(url.pathname)
    if (target && existsSync(target) && statSync(target).isFile()) {
      this.sendFile(res, target, { nonce, req })
      return
    }
    // 带扩展名的请求是资源，缺失时不能返回 index.html（否则 MIME 不匹配、缓存错乱）
    if (path.extname(url.pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    // SPA fallback：前端路由
    this.sendFile(res, path.join(this.root, 'index.html'), { nonce, req })
  }
}

