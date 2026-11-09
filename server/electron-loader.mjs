/**
 * Node ESM loader（P1 适配层，零新增依赖）。
 *
 * resolve hook：
 * 1. `import ... from 'electron'` → server/electron-shim.mjs
 * 2. 无扩展名 / `.js` 结尾的相对导入 → 补成真实 .ts/.tsx/.mjs 文件
 *    （项目 tsconfig 用 moduleResolution: bundler，源码省略了扩展名）
 * 3. `@/xxx` 路径别名 → 项目根 src/xxx
 *
 * load hook：
 * 4. 用项目自带的 typescript.transpileModule 完整转译 .ts/.tsx，
 *    绕开 Node 原生 strip-only 模式不支持「参数属性 / enum / 装饰器」的限制。
 *
 * 启动：`node --import ./server/register.mjs server/index.mjs`
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const EXTS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json']

function fileIfExists(url) {
  try {
    return existsSync(fileURLToPath(url)) ? { url: url.href, shortCircuit: true } : null
  } catch {
    return null
  }
}

function resolveLocal(specifier, parentURL) {
  let base
  if (specifier.startsWith('@/')) {
    base = new URL('../src/' + specifier.slice(2), import.meta.url)
  } else if ((specifier.startsWith('./') || specifier.startsWith('../')) && parentURL) {
    base = new URL(specifier, parentURL)
  } else {
    return null
  }

  const direct = fileIfExists(base)
  if (direct) return direct

  const stem = base.pathname.replace(/\.(js|mjs|jsx)$/, '')
  for (const ext of EXTS) {
    const candidate = new URL(base.href)
    candidate.pathname = stem + ext
    const found = fileIfExists(candidate)
    if (found) return found
  }

  for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
    const asDir = new URL(base.href)
    asDir.pathname = base.pathname.replace(/\/$/, '') + '/index' + ext
    const found = fileIfExists(asDir)
    if (found) return found
  }

  return null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return {
      url: new URL('./electron-shim.mjs', import.meta.url).href,
      shortCircuit: true,
    }
  }

  const local = resolveLocal(specifier, context.parentURL)
  if (local) return local

  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  const pathname = new URL(url).pathname
  // 项目用 resolveJsonModule，且存在 `import { version } from '../../package.json'`
  // 这类 JSON 具名导入。Node 原生 JSON 模块只给 default，这里转成 JS 模块补齐具名导出。
  if (pathname.endsWith('.json')) {
    const raw = await readFile(fileURLToPath(url), 'utf8')
    const parsed = JSON.parse(raw)
    const reserved = new Set([
      'default', 'private', 'public', 'protected', 'static', 'class', 'enum',
      'import', 'export', 'extends', 'super', 'const', 'let', 'var', 'function',
      'return', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'yield',
      'await', 'implements', 'interface', 'package', 'void', 'this', 'if', 'else',
      'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch',
      'finally', 'throw', 'with', 'debugger', 'null', 'true', 'false',
    ])
    const names = Object.keys(parsed).filter(
      (key) => /^[A-Za-z_$][\w$]*$/.test(key) && !reserved.has(key),
    )
    const source = [
      `const __json = ${JSON.stringify(parsed)};`,
      'export default __json;',
      ...names.map((key) => `export const ${key} = __json[${JSON.stringify(key)}];`),
    ].join('\n')
    return { format: 'module', source, shortCircuit: true }
  }
  if (!/\.(ts|tsx|mts)$/.test(pathname)) {
    return nextLoad(url, context)
  }

  const source = await readFile(fileURLToPath(url), 'utf8')
  const result = ts.transpileModule(source, {
    fileName: url,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Automatic,
      useDefineForClassFields: true,
      experimentalDecorators: true,
      isolatedModules: true,
    },
  })

  return {
    format: 'module',
    source: result.outputText,
    shortCircuit: true,
  }
}
