import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * 网页版 Vite 配置（P1 接线）。
 *
 * 独立文件，不改动 vite.config.ts —— 桌面版 `pnpm dev` 完全不受影响。
 * 启动：pnpm exec vite --config vite.web.config.ts
 *
 * 做三件事：
 * 1. 不加载 electron / electronRenderer 插件
 * 2. 把 65+ 处相对路径 import 的 `services/ipc-client` 重定向到
 *    ipc-client.web.ts（源码用的是相对路径，不是 @/ 别名，所以 alias 无效）
 * 3. 把 /api 代理到 server/index.mjs 的 RPC 服务
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))
const desktopClient = path.resolve(__dirname, 'src/services/ipc-client.ts')
const webClient = path.resolve(__dirname, 'src/services/ipc-client.web.ts')

function webIpcClientBridge() {
  const pattern = /(from\s+['"][^'"]*services\/)ipc-client(['"])/
  return {
    name: 'web-ipc-client-bridge',
    enforce: 'pre' as const,
    // 源码 65+ 处都是相对路径 import，Vite 的 resolve.alias 对相对 specifier
    // 不可靠；在转换阶段直接改写 import 语句最稳妥。
    transform(code: string, id: string) {
      if (!id.includes('/src/') && !id.includes('\\src\\')) return null
      if (!pattern.test(code)) return null
      return {
        code: code.replace(new RegExp(pattern.source, 'g'), '$1ipc-client.web$2'),
        map: null,
      }
    },
    // 双保险：若其它插件按解析后的绝对路径再问一次，仍指向网页版
    resolveId(source: string, importer: string | undefined) {
      if (!importer || !source.startsWith('.')) return null
      if (!/(^|\/)services\/ipc-client$/.test(source)) return null
      const resolved = path.resolve(path.dirname(importer), source)
      if (resolved.toLowerCase() !== desktopClient.toLowerCase()) return null
      return webClient
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [webIpcClientBridge(), tailwindcss(), react()],
  publicDir: 'public',
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    watch: {
      ignored: ['**/docs/**', '**/data/**'],
    },
    proxy: {
      '/api': {
        target: process.env.RPC_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    entries: ['index.html', 'src/**/*.{ts,tsx}'],
  },
})
