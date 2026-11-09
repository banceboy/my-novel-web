/**
 * 服务端启动引导：复刻 electron/main.ts 的 prepareGlobalRuntime()。
 *
 * 原桌面版在 registerIPCHandlers() 之前必须先激活全局数据目录，
 * 否则 assertGlobalDataReady() 抛 GLOBAL_DATA_NOT_READY。
 *
 * 所有路径都隔离在 DATA_ROOT（默认 ./data）下，避免读写用户真实的
 * ~/.vela 或 %APPDATA%\ai-novel-writer 数据。
 *
 * TODO(P3)：改成按 userId 隔离的租户数据根，替换这里的单一全局根。
 */
import path from 'node:path'
import os from 'node:os'
import { mkdirSync } from 'node:fs'

export async function prepareGlobalRuntime() {
  const locator = await import('../electron/services/app-data-locator.ts')
  const migration = await import('../electron/services/global-data-migration.ts')
  const configUtils = await import('../electron/utils/config-utils.ts')

  const root = path.resolve(process.env.DATA_ROOT ?? './data')
  const userData = path.join(root, 'user-data')
  const canonical = path.join(root, 'global')
  const legacy = path.join(root, 'legacy-empty')
  for (const dir of [userData, canonical, legacy]) {
    mkdirSync(dir, { recursive: true })
  }

  const roots = locator.resolveGlobalDataRoots(
    userData,
    () => root,
    {
      AI_NOVEL_APP_DATA_HOME: canonical,
      AI_NOVEL_LEGACY_SOURCE_HOME: legacy,
    },
    os.homedir(),
  )

  const migrated = migration.runGlobalDataMigration({ ...roots, exclusiveAccess: true })
  if (migrated.state !== 'ready') {
    throw new Error(`GLOBAL_DATA_${migrated.code ?? 'BLOCKED'}`)
  }

  migration.activateGlobalData(migrated)
  configUtils.ensureVelaHome()
  return { root, generation: migrated.globalGeneration }
}
