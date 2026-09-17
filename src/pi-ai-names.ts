/**
 * pi-ai 注册表读取：provider id → pi-ai 自己的元数据（name / baseUrl / 认证方式）。
 *
 * 原则是「pi-ai 说了算的，我们不另起一张表」：名字、默认端点、这家支不支持 OAuth、
 * 有没有密钥路径，全部从 provider 工厂对象上读，和 pi-ai 自己内部用的是同一份数据。
 * 同步实现（createRequire，dsh 跑在 Node 22+，require(esm) 可用），按 pi-ai 根目录
 * 缓存——updater 换版本后根目录变化，缓存自然失效。
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { activePiAiRoot } from './bridge.js'

/** 一家 provider 在 pi-ai 注册表里的事实。 */
export interface PiAiProviderMeta {
  name?: string
  /** 这家的默认端点；有的 provider 只在模型上给 baseUrl，这里是 undefined。 */
  baseUrl?: string
  /** 有 apiKey 认证路径（支持手填/环境变量密钥）。 */
  apiKey: boolean
  /** 有 subscription / OAuth 登录路径。 */
  oauth: boolean
}

/** 按 pi-ai 包目录缓存；根目录变了（换版本）自然失效。 */
let cache: { root: string; meta: Map<string, PiAiProviderMeta> } | undefined

/** pi-ai 注册表全量 id → 元数据。读不到时返回空 Map（调用方自行兜底）。 */
export function piAiProviders(): Map<string, PiAiProviderMeta> {
  const root = activePiAiRoot()
  if (root === undefined) return new Map()
  if (cache !== undefined && cache.root === root) return cache.meta
  const meta = new Map<string, PiAiProviderMeta>()
  const dir = join(root, 'dist', 'providers')
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return new Map()
  }
  const require = createRequire(join(root, 'package.json'))
  for (const file of files) {
    if (!file.endsWith('.js') || file.endsWith('.models.js') || file === 'all.js') continue
    const id = file.slice(0, -'.js'.length)
    try {
      const mod = require(join(dir, file)) as Record<string, unknown>
      // pi-ai 每个 provider 文件导出一个 *Provider() 工厂；按函数名认它
      const factory = Object.values(mod).find(
        (value): value is () => { name?: unknown, baseUrl?: unknown, auth?: unknown } =>
          typeof value === 'function' && /Provider$/.test(value.name),
      )
      if (factory === undefined) continue
      const provider = factory()
      const auth = typeof provider.auth === 'object' && provider.auth !== null
        ? provider.auth as Record<string, unknown>
        : {}
      meta.set(id, {
        ...(typeof provider.name === 'string' && provider.name !== '' ? { name: provider.name } : {}),
        ...(typeof provider.baseUrl === 'string' && provider.baseUrl !== '' ? { baseUrl: provider.baseUrl } : {}),
        apiKey: auth['apiKey'] !== undefined,
        oauth: auth['oauth'] !== undefined,
      })
    } catch {
      /* 单个 provider 读失败就跳过，不拖垮整表 */
    }
  }
  cache = { root, meta }
  return meta
}

/** 单个 provider 的 pi-ai 元数据，读不到返回 undefined。 */
export function piAiProviderMeta(id: string): PiAiProviderMeta | undefined {
  return piAiProviders().get(id)
}

/** 单个 provider 的 pi-ai 注册名，读不到返回 undefined。 */
export function piAiName(id: string): string | undefined {
  return piAiProviderMeta(id)?.name
}
