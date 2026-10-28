/**
 * dsh-auto-retry —— Host 侧（插件本体）。
 *
 * 本插件**不自己实现重试**。真正的重试由 DSH 自带的 `@deepseek-ai/dsh-llm-retry`
 * 执行（默认对 RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE 生效）。
 * Host 侧只做一件事：把用户在设置面板里选的「耐心程度」（本插件 Config 的
 * `patience` 字段）翻译成 `llm-pi-ai` 下每个 provider 的 `retryPolicy`。
 *
 * 为什么写进 `llm-pi-ai` 而不是自己的命名空间：retryPolicy 是 `dsh-llm-retry`
 * 认的官方字段，写在 provider 上才会被它读到；本插件只是「代用户填表」，
 * 不参与重试决策。`llm-pi-ai` 的 `providers` 整体是 `.volatile()` 字段，
 * 因此 `settings.mutate()` 可以合法改写它。
 *
 * 设计约束（见 SPEC.md）：
 *   - 只依赖 `@deepseek-ai/schemastery` 与 Node 内置能力，不 import cordis / dsh-*；
 *   - `inject = []`，不硬依赖 settings：headless profile 没有设置面板时必须静默跳过；
 *   - 所有 settings 操作都 try/catch + logger.warn，任何异常都不能让插件加载失败。
 *
 * @module dsh-auto-retry
 */
import z from '@deepseek-ai/schemastery'

/** 插件名。同时是 `cordis.patch.yml` 的 entry id、设置表单的 entryId、事件里的 ns。 */
export const name = 'auto-retry'

/**
 * 不硬依赖任何服务。
 *
 * settings 服务只在 desktop / web profile 里存在（headless 不挂设置面板）。
 * 把它写进 `inject` 会让 headless 下整条插件行不加载；正确做法是在 apply 里
 * 用 `ctx.inject(['settings'], ...)` 注册一段**可选**子级。
 */
export const inject = []

/**
 * 重试退避参数：与 `dsh-llm-retry` 的 retryPolicy.backoff 同形。
 *
 * 三个字段都带上，避免上游缺省值随版本漂移；数值取保守的指数退避 + 抖动。
 * initialDelayMs 1s、maxDelayMs 60s、jitterRatio 0.2（±20% 抖动，防惊群）。
 */
const BACKOFF = { initialDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.2 }

/**
 * 四档耐心的 retryPolicy 预设。
 *
 * 等待时长按 `backoff` 的指数退避（1s 起、60s 封顶）粗算：
 *   - off    maxRetries = 0    → 不重试，0 等待；
 *   - normal maxRetries = 10   → 1+2+4+8+16+32+60×4 ≈ 303s ≈ 5 分钟；
 *   - long   maxRetries = 40   → 前 10 次 ≈5 分钟，再加 30×60s = 30 分钟 ≈ 35 分钟；
 *   - always mode = 'always'   → 不限次数，一直等到成功（整晚挂机）。
 *
 * 导出给测试断言用；运行时只读不改（buildOps 会深拷贝后再写进 settings）。
 */
export const PRESETS = {
  off: { mode: 'normal', maxRetries: 0, backoff: { ...BACKOFF } },
  normal: { mode: 'normal', maxRetries: 10, backoff: { ...BACKOFF } },
  long: { mode: 'normal', maxRetries: 40, backoff: { ...BACKOFF } },
  always: { mode: 'always', backoff: { ...BACKOFF } },
}

/** 合法档位；顺序即设置卡片的展示顺序（normal 为日常默认）。 */
const PATIENCE_IDS = ['off', 'normal', 'long', 'always']
const DEFAULT_PATIENCE = 'normal'

/** 目标命名空间：每个 provider 的 `retryPolicy` 都写在它下面。 */
const LLM_NS = 'llm-pi-ai'

/**
 * 插件 Config。
 *
 * `.volatile()` 是设置面板能编辑该字段的**唯一**方式（0.2.0-rc.2 起），必须保留。
 * 在 apply 收到的 config 上，这个字段是引用而不是普通值，读法见 readPatience()。
 */
export const Config = z.object({
  patience: z
    .string()
    .default('normal')
    .volatile()
    .description('断线重试耐心：off / normal / long / always'),
})

/**
 * 把任意输入归一到合法档位；非法值回 `normal`（与面板默认档一致）。
 *
 * @param {unknown} raw
 * @returns {'off'|'normal'|'long'|'always'}
 */
export function normalizePatience(raw) {
  return PATIENCE_IDS.includes(raw) ? raw : DEFAULT_PATIENCE
}

/**
 * 读当前生效的耐心档位。
 *
 * `.volatile()` 字段在 config 上是稳定引用，必须每次重新 `.get()`，不能缓存；
 * 兼容三种形态：引用 `{ get() }`、普通字符串、config 缺失/半截对象。
 * 读取本身抛错时也回 `normal` —— 配置读失败不能把插件带崩。
 *
 * @param {{ patience?: unknown }|undefined|null} config
 * @returns {'off'|'normal'|'long'|'always'}
 */
export function readPatience(config) {
  let raw
  try {
    const ref = config?.patience
    raw = ref && typeof ref.get === 'function' ? ref.get() : ref
  } catch {
    return DEFAULT_PATIENCE
  }
  return normalizePatience(raw)
}

/**
 * 为一个 provider 集合生成 `settings.mutate()` 的 ops。
 *
 * 每个 provider 一条 `set`，路径固定 `['providers', <name>, 'retryPolicy']`；
 * `value` 是预设的**深拷贝**（structuredClone），既避免 settings 层与 PRESETS
 * 共享引用，也避免多条 op 之间共享同一个 backoff 对象。
 *
 * @param {Record<string, unknown>|null|undefined} providers `llm-pi-ai` 的 providers 映射
 * @param {string} patience 档位（非法值归一到 normal）
 * @returns {Array<{ op: 'set', path: string[], value: object }>}
 */
export function buildOps(providers, patience) {
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return []
  const policy = PRESETS[normalizePatience(patience)]
  return Object.keys(providers).map((providerName) => ({
    op: 'set',
    path: ['providers', providerName, 'retryPolicy'],
    value: structuredClone(policy),
  }))
}

/**
 * 插件入口。
 *
 * @param {object} ctx Cordis 上下文（Host 平面）。
 * @param {object} config 本条目 config；`patience` 是 volatile 引用。
 * @returns {Promise<void>} 启动期首次安装检查完成时 settle（永不 reject）。
 */
export function apply(ctx, config) {
  /** 启动那一刻的生效档位：既作为去重基线，也是「首次安装」要写入的值。 */
  let lastPatience = readPatience(config)
  /** 首次安装检查的 promise：settings 子级启动后才有意义，供测试 await。 */
  let firstInstall = Promise.resolve()
  let firstInstallDone = false
  // 启动时读一次服务：settings 缺席是正常情况；宿主 registry 抛错则只 warn。
  void getSettings()

  /** 任何异常都只 warn，绝不上抛 —— 插件加载失败的代价远大于少写一次设置。 */
  function warn(message, error) {
    try {
      const detail = error === undefined ? '' : ` (${String(error?.message ?? error)})`
      ctx?.logger?.warn?.(`auto-retry: ${message}${detail}`)
    } catch {
      /* logger 本身异常也不管 */
    }
  }

  /** 读 settings 服务；缺席或读取抛错都返回 undefined（静默跳过）。 */
  function getSettings() {
    try {
      return typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
    } catch (error) {
      warn('settings service unavailable', error)
      return undefined
    }
  }

  /**
   * 从 settings.describe() 里取 `llm-pi-ai.providers`。
   *
   * describe() 返回行形如 `{ ns, revision, value }`。这里不做任何写入，
   * 只读当前投影值；拿不到/形状不对都返回 undefined（由调用方静默返回）。
   */
  function readProviders(settings) {
    try {
      const rows = settings.describe()
      if (!Array.isArray(rows)) return undefined
      const row = rows.find((item) => item && item.ns === LLM_NS)
      const providers = row?.value?.providers
      if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined
      return providers
    } catch (error) {
      warn('settings.describe() failed', error)
      return undefined
    }
  }

  /**
   * 把一档耐心写进 `llm-pi-ai` 的每个 provider。
   *
   * 依赖 configEditor：settings.describe() / settings.mutate() 都只在它可用时工作。
   * 任何失败只警告（例如用户手工在 profile 补丁里写了更高优先级的 retryPolicy，
   * mutate 会被拒绝 —— 这是正常的，尊重手工配置，不重试）。
   */
  async function applyPatience(patience) {
    const settings = getSettings()
    if (!settings) return false

    const providers = readProviders(settings)
    if (!providers) return false
    const names = Object.keys(providers)
    if (names.length === 0) return false

    try {
      await settings.mutate(LLM_NS, buildOps(providers, patience))
    } catch (error) {
      warn('failed to write llm-pi-ai.retryPolicy', error)
      return false
    }
    try {
      ctx?.logger?.info?.(`auto-retry: patience="${patience}" applied to ${names.length} providers`)
    } catch {
      /* 日志失败不影响结果 */
    }
    return true
  }

  /**
   * 首次安装便利：启动时若 `llm-pi-ai` 下**所有** provider 都没有 `retryPolicy`，
   * 才自动应用一次当前耐心；只要有一个已有自定义 retryPolicy 就一律不动。
   *
   * 必须在 settings 就绪**且** `llm-pi-ai` 条目已激活之后才能读 describe()：
   * 实测插件 apply 时 settings 还没挂载，settings 挂载后 llm-pi-ai 也可能还要
   * 几十/几百毫秒才出现在 describe() 里，所以这里允许被重复调用，直到真正
   * 看到 llm-pi-ai 的 providers 才把 firstInstallDone 置真。
   */
  async function maybeFirstInstall() {
    if (firstInstallDone) return
    const settings = getSettings()
    if (!settings) return

    const providers = readProviders(settings)
    if (!providers) return
    const names = Object.keys(providers)
    if (names.length === 0) return

    firstInstallDone = true
    const untouched = names.every((providerName) => {
      const provider = providers[providerName]
      return !provider || typeof provider !== 'object' || provider.retryPolicy === undefined
    })
    if (!untouched) return

    await applyPatience(lastPatience)
  }

  /**
   * 注册可选 settings 子级。
   *
   * - `configure({ auto: false })`：本插件自带面板，关掉按 schema 自动生成的表单；
   *   策略挂在插件 fiber 上（settings 迟到/被替换时会重新采纳）。
   * - `settings/document-updated`：面板保存本插件档位后重新应用。
   *   该事件是全应用广播，必须按 ns 过滤。
   *
   * 子级里的 effect 回调可能被多次执行（服务替换），所以每个回调内部也各自兜底。
   */
  try {
    ctx.inject(['settings'], (settingsCtx) => {
      try {
        settingsCtx.effect(() => {
          try {
            const settings = settingsCtx.settings ?? getSettings()
            return settings?.configure?.({ auto: false }, ctx.fiber)
          } catch (error) {
            warn('settings.configure() failed', error)
            return undefined
          }
        })
      } catch (error) {
        warn('settings effect registration failed', error)
      }

      try {
        settingsCtx.effect(() => {
          try {
            return settingsCtx.on('settings/document-updated', () => {
              // 面板保存时的 provider 写入由浏览器侧直接调 llm-pi-ai 的表单完成；
              // Host 这里绝不能在事件里再 mutate（那发生在 settings 的 HMR 事务内，
              // 必然报 "HMR transactions cannot be nested"）。只补首次安装检查。
              if (!firstInstallDone) void maybeFirstInstall()
            })
          } catch (error) {
            warn('settings listener registration failed', error)
            return undefined
          }
        })
      } catch (error) {
        warn('settings listener effect registration failed', error)
      }

      // 首次安装便利必须在这里做：apply 本身早于 settings 服务就绪，
      // 在 apply 末尾直接调用会拿到 undefined 并静默跳过（已实测）。
      // 再补几个定时器：settings 就绪 ≠ llm-pi-ai 已出现在 describe() 里。
      firstInstall = maybeFirstInstall()
      for (const ms of [300, 1000, 3000]) {
        const timer = setTimeout(() => { void maybeFirstInstall() }, ms)
        if (typeof timer.unref === 'function') timer.unref()
      }
    })
  } catch (error) {
    warn('ctx.inject([\'settings\']) failed', error)
  }

  /**
   * 面板保存后的应用入口。
   *
   * 为什么不让 Host 在 `settings/document-updated` 里直接写：那个事件发生在
   * settings 自己的 HMR 事务内部，再 mutate 另一个条目会报
   * "HMR transactions cannot be nested"（实测）。浏览器保存完自己的档位后
   * POST 这个路由，处理函数是全新的 HTTP 请求任务，不在事务上下文里。
   *
   * 路由是 `/api/...` 下的 exact 路由，必须自己走 connection 的信任栅栏，
   * 否则会绕过 Host/Origin 与浏览器认证（照 collab-mode 的 selfcheck 路由）。
   */
  try {
    ctx.inject(['webServer', 'connection'], (serverCtx) => {
      const sendJson = (res, status, payload) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      const rejected = (req, res) => {
        const connection = serverCtx.connection
        if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
          sendJson(res, 503, { ok: false, code: 'no-trust-fence' })
          return true
        }
        const rejection = connection.requestRejection(req)
        if (rejection === undefined) return false
        res.statusCode = rejection
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return true
      }
      serverCtx.effect(() => {
        const off = serverCtx.webServer.register({
          kind: 'exact',
          path: '/api/auto-retry/apply',
          handler: async (req, res) => {
            if (rejected(req, res)) return
            if (req.method !== 'POST') {
              res.statusCode = 405
              res.setHeader('allow', 'POST')
              res.end()
              return
            }
            const patience = readPatience(config)
            const applied = await applyPatience(patience)
            sendJson(res, applied ? 200 : 500, { ok: applied, patience })
          },
        })
        return () => off()
      }, 'auto-retry: apply route')
    })
  } catch (error) {
    warn('ctx.inject([\'webServer\', \'connection\']) failed', error)
  }

  // 返回启动检查的 promise：settings 已就绪时（测试/进程内宿主）可 await；
  // 异步就绪时 apply 早已返回，检查在 settings 子级里继续跑。
  return firstInstall
}
