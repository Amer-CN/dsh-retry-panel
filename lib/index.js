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
import { randomUUID } from 'node:crypto'

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
 * 默认重试码集合。
 *
 * 比 DSH 内置默认多了 QUOTA / PI_AI_ERROR / UNKNOWN：
 * - 很多网关把瞬时 429 capacity/tpm 写成 `insufficient_quota`，DSH 会归到 QUOTA；
 *   QUOTA 不在内置集合里会导致一次都不重试（社区已多次踩到）。
 * - PI_AI_ERROR / UNKNOWN 是未知网关错误的兜底，重试有概率恢复。
 * 真正的余额耗尽也会被重试，但有 maxRetries 上限；「死磕」档本来就不限次数。
 */
const RETRYABLE_CODES = [
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'QUOTA',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'PI_AI_ERROR',
  'UNKNOWN',
]

/** 压缩把整轮吞掉（检查点后零产出 completed）时的续跑提示。 */
const COMPACTION_CONTINUE_TEXT = '请按最近的检查点继续动手，不要重复已经完成的工作。'
/** 单轮内 max-tokens 续写的提示。 */
const IN_TURN_CONTINUE_TEXT = '继续写，从刚才截断的地方接着输出，不要重复已经写过的内容。'
/** 单轮内最多同轮续写次数；超过后放行 turn/end，交给跨轮兜底。 */
const IN_TURN_LIMIT = 3

export const PRESETS = {
  off: {
    mode: 'normal',
    maxRetries: 0,
    retryableCodes: [...RETRYABLE_CODES],
    backoff: { ...BACKOFF },
  },
  normal: {
    mode: 'normal',
    maxRetries: 10,
    retryableCodes: [...RETRYABLE_CODES],
    backoff: { ...BACKOFF },
  },
  long: {
    mode: 'normal',
    maxRetries: 40,
    retryableCodes: [...RETRYABLE_CODES],
    backoff: { ...BACKOFF },
  },
  always: { mode: 'always', backoff: { ...BACKOFF } },
}

/** 合法档位；顺序即设置卡片的展示顺序（normal 为日常默认）。 */
const PATIENCE_IDS = ['off', 'normal', 'long', 'always']
const DEFAULT_PATIENCE = 'normal'

/** 目标命名空间：pi-ai 的每个 provider 都写 `retryPolicy`。 */
const LLM_NS = 'llm-pi-ai'
/** DeepSeek 官方 provider 的 settings 命名空间，`retryPolicy` 是顶层字段。 */
const DEEPSEEK_NS = 'llm-deepseek'

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
  autoContinue: z
    .boolean()
    .default(true)
    .volatile()
    .description('回合失败后自动发送“继续”'),
  continueDelaySec: z
    .number()
    .default(5)
    .volatile()
    .description('自动继续前等待的秒数（0~600）'),
  maxConsecutive: z
    .number()
    .default(5)
    .volatile()
    .description('最多连续自动继续次数（1~50）'),
  continueText: z
    .string()
    .default('继续')
    .volatile()
    .description('自动继续时发送的文本'),
  continueOnMaxTokens: z
    .boolean()
    .default(true)
    .volatile()
    .description('输出被截断时也自动继续'),
  idleWatchdog: z
    .boolean()
    .default(false)
    .volatile()
    .description('卡住不动时取消当前请求并自动继续'),
  idleTimeoutSec: z
    .number()
    .default(180)
    .volatile()
    .description('无活动判定秒数（30~600）'),
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

/** 解包 volatile 引用；读失败返回 undefined，让调用方走默认值。 */
function configValue(ref) {
  try {
    return ref && typeof ref.get === 'function' ? ref.get() : ref
  } catch {
    return undefined
  }
}

/** 整数归一：非有限数回默认值，越界夹到边界。 */
export function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** 自动继续的文本：去首尾空白、限长 200、空串回「继续」。 */
function normalizeContinueText(value) {
  if (typeof value !== 'string') return '继续'
  const text = value.trim()
  if (text === '') return '继续'
  return text.slice(0, 200)
}

/**
 * 读当前全部设置（每次重新解包 volatile 引用）。
 * @param {object|undefined|null} config 插件 config
 * @returns {{patience:string, autoContinue:boolean, continueDelaySec:number, maxConsecutive:number, continueText:string, continueOnMaxTokens:boolean, idleWatchdog:boolean, idleTimeoutSec:number}}
 */
export function readSettings(config) {
  return {
    patience: readPatience(config),
    autoContinue: configValue(config?.autoContinue) !== false,
    continueDelaySec: clampInt(configValue(config?.continueDelaySec), 0, 600, 5),
    maxConsecutive: clampInt(configValue(config?.maxConsecutive), 1, 50, 5),
    continueText: normalizeContinueText(configValue(config?.continueText)),
    continueOnMaxTokens: configValue(config?.continueOnMaxTokens) !== false,
    idleWatchdog: configValue(config?.idleWatchdog) === true,
    idleTimeoutSec: clampInt(configValue(config?.idleTimeoutSec), 30, 600, 180),
  }
}

/** 这些失败重试/继续都不会成功，必须人工处理。 */
const PERMANENT_CODES = new Set([
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'INVALID_REQUEST',
  'CONTEXT_WINDOW_EXCEEDED',
  'UNKNOWN_MODEL',
  'NO_ADAPTER',
  'ACCOUNT_QUOTA',
  'QUOTA',
])

/**
 * 失败是否属于「重试也没用」的永久性错误。
 * 先看稳定 code，再用文本兜底（网关经常把内容塞进 message）。
 * @param {{code?:string, message?:string}|undefined|null} failure
 */
export function isPermanentFailure(failure) {
  if (!failure || typeof failure !== 'object') return false
  const code = String(failure.code ?? '').toUpperCase()
  if (PERMANENT_CODES.has(code)) return true
  const text = `${code} ${String(failure.message ?? '')}`.toLowerCase()
  return (
    /auth|unauthor|forbidden|credential|api[_ -]?key|permission/.test(text) ||
    /insufficient.*(balance|quota)|billing|payment|quota.*exceed/.test(text) ||
    /model.*not.*found|unknown[_ -]?model/.test(text) ||
    /context.*(length|limit|overflow|exceed)|token.*limit|max.*context/.test(text) ||
    /invalid[_ -]?request|bad[_ -]?request/.test(text)
  )
}

/**
 * 连续失败时逐步拉长等待：base × 2^streak，封顶 10 分钟。
 * @param {{continueDelaySec:number}} settings
 * @param {number} streak 已连续自动继续的次数
 */
export function continueDelayMs(settings, streak) {
  const base = Math.max(0, Number(settings?.continueDelaySec) || 0) * 1000
  const exponent = Math.min(Math.max(0, Math.trunc(streak)), 8)
  return Math.min(base * 2 ** exponent, 600000)
}

/** 模板占位符：{code} {kind} {attempt} {tool}。缺失的占位符填空串。 */
export function fillContinueText(template, context = {}) {
  const text = typeof template === 'string' && template.trim() !== '' ? template : '继续'
  return text
    .replace(/\{code\}/g, context.code ?? '')
    .replace(/\{kind\}/g, context.kind ?? '')
    .replace(/\{attempt\}/g, context.attempt !== undefined ? String(context.attempt) : '')
    .replace(/\{tool\}/g, context.tool ?? '')
}

/**
 * 幂等护栏：如果失败前最后一次工具调用没有结果，提醒模型先核验再继续，
 * 避免崩溃在半途的 `git push` / 写文件被无脑重跑。
 * @param {string} text
 * @param {{name:string, result:boolean}|undefined} lastTool
 */
export function applyToolGuard(text, lastTool) {
  if (!lastTool || lastTool.result === true) return text
  return `${text}\n\n（上一步工具「${lastTool.name}」可能没有完成：先确认外部状态再继续，不要重复执行可能产生副作用的操作。）`
}

/**
 * 回合终局该做什么：
 * - `reset`：成功回合，清熔断与「人工接管」状态；
 * - `continue`：排定一次自动继续；
 * - `skip`：永久性失败，提示人工处理，不继续；
 * - `none`：不处理。
 * @param {{kind?:string, reason?:{kind?:string}, error?:{code?:string, message?:string}}|undefined|null} reason
 * @param {{autoContinue:boolean, continueOnMaxTokens:boolean, idleWatchdog:boolean}} settings
 */
export function decideTurnAction(reason, settings) {
  const kind = reason?.kind
  if (kind === 'completed') return 'reset'
  if (kind === 'error') {
    if (!settings.autoContinue) return 'none'
    return isPermanentFailure(reason?.error) ? 'skip' : 'continue'
  }
  if (kind === 'max-tokens') return settings.autoContinue && settings.continueOnMaxTokens ? 'continue' : 'none'
  if (kind === 'aborted') {
    // 只有看门狗自己的 hook 取消才继续；用户手动停止（user）、进程关闭等一律不继续。
    return settings.autoContinue && settings.idleWatchdog && reason?.reason?.kind === 'hook' ? 'continue' : 'none'
  }
  return 'none'
}

/** 与 dsh-llm createUserMessage 产物一致的用户消息。 */
export function buildContinueMessage(text = '继续') {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** 把消息 content（字符串或 parts 数组）展平成纯文本，用于识别自身回显。 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
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

  /** DeepSeek 官方 provider 的 settings 行；不存在时返回 undefined。 */
  function readDeepSeekRow(settings) {
    try {
      const rows = settings.describe()
      if (!Array.isArray(rows)) return undefined
      return rows.find((item) => item && item.ns === DEEPSEEK_NS)
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
    const deepseek = readDeepSeekRow(settings)
    let applied = false

    if (providers) {
      const names = Object.keys(providers)
      if (names.length > 0) {
        try {
          await settings.mutate(LLM_NS, buildOps(providers, patience))
          applied = true
        } catch (error) {
          warn('failed to write llm-pi-ai.retryPolicy', error)
        }
      }
    }

    if (deepseek) {
      try {
        await settings.mutate(DEEPSEEK_NS, [
          { op: 'set', path: ['retryPolicy'], value: structuredClone(PRESETS[normalizePatience(patience)]) },
        ])
        applied = true
      } catch (error) {
        warn('failed to write llm-deepseek.retryPolicy', error)
      }
    }

    if (applied) {
      try {
        ctx?.logger?.info?.(`auto-retry: patience="${patience}" applied`)
      } catch {
        /* 日志失败不影响结果 */
      }
    }
    return applied
  }

  /** 只给还没有 retryPolicy 的命名空间补默认策略，绝不覆盖手工配置。 */
  async function applyMissingPolicies(patience) {
    const settings = getSettings()
    if (!settings) return false
    const providers = readProviders(settings)
    const deepseek = readDeepSeekRow(settings)
    let applied = false

    if (providers) {
      const names = Object.keys(providers)
      const untouched =
        names.length > 0 &&
        names.every((providerName) => {
          const provider = providers[providerName]
          return !provider || typeof provider !== 'object' || provider.retryPolicy === undefined
        })
      if (untouched) {
        try {
          await settings.mutate(LLM_NS, buildOps(providers, patience))
          applied = true
        } catch (error) {
          warn('failed to write llm-pi-ai.retryPolicy', error)
        }
      }
    }

    if (deepseek && (deepseek.value === undefined || deepseek.value.retryPolicy === undefined)) {
      try {
        await settings.mutate(DEEPSEEK_NS, [
          { op: 'set', path: ['retryPolicy'], value: structuredClone(PRESETS[normalizePatience(patience)]) },
        ])
        applied = true
      } catch (error) {
        warn('failed to write llm-deepseek.retryPolicy', error)
      }
    }

    if (applied) {
      try {
        ctx?.logger?.info?.(`auto-retry: patience="${patience}" applied to missing namespaces`)
      } catch {
        /* ignore */
      }
    }
    return applied
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
    const deepseek = readDeepSeekRow(settings)
    if (!providers && !deepseek) return

    firstInstallDone = true
    await applyMissingPolicies(lastPatience)
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

  /* ---------------- 断线后自动继续 + 卡住检测 ---------------- */
  const pendingContinues = new Map()
  const continueStreaks = new Map()
  const stoppedSessions = new Set()
  const lastAutoMessage = new Map()
  const watchdogTimers = new Map()
  /** 每个会话最后一次工具调用（幂等护栏用）：{ name, callId, result }。 */
  const lastTools = new Map()
  /** 当前回合的信号：是否有压缩检查点 / assistant 输出 / 工具调用。 */
  const turnSignals = new Map()
  /** 最近一次 finish 分片的 reason.kind（agent.id → kind）。 */
  const finishKinds = new Map()
  /** 单轮内已续写次数（agent.id → { turn, attempts }）。 */
  const inTurnAttempts = new Map()

  function clearTurnState(sessionId) {
    turnSignals.delete(sessionId)
    finishKinds.delete(sessionId)
    inTurnAttempts.delete(sessionId)
  }

  function isSubagentAgent(agent) {
    return agent?.session?.header?.origin === 'subagent'
  }

  function mainAgentOf(agents, sessionId) {
    try {
      const agent = agents.get(sessionId)
      return agent && !isSubagentAgent(agent) ? agent : undefined
    } catch {
      return undefined
    }
  }

  function clearPendingContinue(sessionId) {
    const timer = pendingContinues.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    pendingContinues.delete(sessionId)
  }

  function disarmWatchdog(sessionId) {
    const timer = watchdogTimers.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    watchdogTimers.delete(sessionId)
  }

  /** 布防「无活动」看门狗：超时取消当前请求（hook），让 turn/end 走自动继续。 */
  function armWatchdog(agents, sessionId) {
    const settings = readSettings(config)
    if (!settings.idleWatchdog || !getSettings()) {
      disarmWatchdog(sessionId)
      return
    }
    const agent = mainAgentOf(agents, sessionId)
    if (!agent || agent.status !== 'running') {
      disarmWatchdog(sessionId)
      return
    }
    disarmWatchdog(sessionId)
    const timer = setTimeout(() => {
      watchdogTimers.delete(sessionId)
      try {
        const live = mainAgentOf(agents, sessionId)
        if (!live || live.status !== 'running') return
        const timeoutSec = readSettings(config).idleTimeoutSec
        ctx?.logger?.warn?.(
          `auto-retry: idle watchdog cancels ${String(sessionId).slice(0, 8)} after ${timeoutSec}s without activity`,
        )
        live.cancel({ kind: 'hook', reason: 'auto-retry: idle watchdog' }, { keepInbox: true })
      } catch (error) {
        warn('idle watchdog cancel failed', error)
      }
    }, settings.idleTimeoutSec * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    watchdogTimers.set(sessionId, timer)
  }

  function syncWatchdogs(agents) {
    try {
      for (const agent of agents.list()) {
        if (!agent || isSubagentAgent(agent)) continue
        if (agent.status === 'running') armWatchdog(agents, agent.id)
        else disarmWatchdog(agent.id)
      }
    } catch (error) {
      warn('watchdog sync failed', error)
    }
  }

  function onToolCall(sessionId, data) {
    lastTools.set(sessionId, {
      name: typeof data?.name === 'string' ? data.name : 'tool',
      callId: typeof data?.callId === 'string' ? data.callId : undefined,
      result: false,
    })
  }

  function onToolResult(sessionId, data) {
    const state = lastTools.get(sessionId)
    if (!state) return
    const parts = Array.isArray(data?.message?.content) ? data.message.content : []
    const part = parts.find((item) => item && item.type === 'tool-result')
    const resultId = typeof part?.toolCallId === 'string' ? part.toolCallId : data?.callId
    // 只认与最近一次调用匹配的结果；无法关联时保守地视为已完成。
    if (state.callId !== undefined && typeof resultId === 'string' && resultId !== state.callId) return
    state.result = true
  }

  /** 排定一次「继续」：延迟后以用户身份 followup，开新回合。 */
  function scheduleContinue(agents, sessionId, label, failure) {
    const settings = readSettings(config)
    if (!settings.autoContinue || !getSettings()) return
    if (stoppedSessions.has(sessionId)) return
    if (pendingContinues.has(sessionId)) return
    const streak = continueStreaks.get(sessionId) ?? 0
    if (streak >= settings.maxConsecutive) {
      ctx?.logger?.warn?.(
        `auto-retry: ${String(sessionId).slice(0, 8)} hit maxConsecutive=${settings.maxConsecutive}, stop auto-continue`,
      )
      return
    }
    if (!mainAgentOf(agents, sessionId)) return

    const delayMs = continueDelayMs(settings, streak)
    const timer = setTimeout(() => {
      pendingContinues.delete(sessionId)
      try {
        const live = mainAgentOf(agents, sessionId)
        if (!live || live.status !== 'idle') return
        const now = readSettings(config)
        if (!now.autoContinue || stoppedSessions.has(sessionId)) return
        const next = (continueStreaks.get(sessionId) ?? 0) + 1
        if (next > now.maxConsecutive) return
        continueStreaks.set(sessionId, next)
        const tool = lastTools.get(sessionId)
        const text = applyToolGuard(
          failure?.kind === 'compaction'
            ? COMPACTION_CONTINUE_TEXT
            : fillContinueText(now.continueText, {
                code: failure?.code,
                kind: failure?.kind ?? label,
                attempt: next,
                tool: tool?.name,
              }),
          tool,
        )
        lastAutoMessage.set(sessionId, { text, at: Date.now() })
        live.followup(buildContinueMessage(text))
        ctx?.logger?.info?.(
          `auto-retry: auto-continue ${next}/${now.maxConsecutive} in ${Math.round(delayMs / 1000)}s (${label}) for ${String(sessionId).slice(0, 8)}`,
        )
      } catch (error) {
        warn('auto-continue send failed', error)
      }
    }, delayMs)
    if (typeof timer.unref === 'function') timer.unref()
    pendingContinues.set(sessionId, timer)
  }

  function onHumanMessage(sessionId, data) {
    if (!data || data.source?.kind !== 'user') return
    const text = contentToText(data.content)
    const last = lastAutoMessage.get(sessionId)
    // 自己发出的「继续」也会以 user 身份回显：文本相同 + 8 秒内，忽略。
    if (last && text === last.text && Date.now() - last.at < 8000) return
    const active = pendingContinues.has(sessionId) || (continueStreaks.get(sessionId) ?? 0) > 0
    clearPendingContinue(sessionId)
    continueStreaks.delete(sessionId)
    if (active) stoppedSessions.add(sessionId)
  }

  function onTurnEnd(agents, sessionId, data) {
    const reason = data?.reason
    const signal = turnSignals.get(sessionId)
    const settings = readSettings(config)
    clearTurnState(sessionId)

    // 压缩事务把整轮吞了：completed，但只有一个 compact checkpoint，
    // 中间零 assistant 输出、零工具调用。这不是正常完成，补一条续写。
    if (
      reason?.kind === 'completed' &&
      signal?.checkpoint === true &&
      signal.assistant !== true &&
      signal.tool !== true &&
      settings.autoContinue
    ) {
      scheduleContinue(agents, sessionId, 'compaction', { kind: 'compaction', code: 'COMPACTION_STALL' })
      return
    }

    const action = decideTurnAction(reason, settings)
    if (action === 'reset') {
      continueStreaks.delete(sessionId)
      stoppedSessions.delete(sessionId)
      clearPendingContinue(sessionId)
      disarmWatchdog(sessionId)
      lastTools.delete(sessionId)
      return
    }
    if (action === 'skip') {
      clearPendingContinue(sessionId)
      continueStreaks.delete(sessionId)
      stoppedSessions.add(sessionId)
      const code = reason?.error?.code ?? 'permanent'
      ctx?.logger?.warn?.(
        `auto-retry: ${String(sessionId).slice(0, 8)} failed permanently (${code}), auto-continue skipped — manual action required`,
      )
      return
    }
    if (action === 'continue') {
      const label = reason?.kind === 'aborted' ? 'watchdog' : reason?.error?.code ?? reason?.kind ?? 'turn-end'
      scheduleContinue(agents, sessionId, label, reason?.error ?? { kind: reason?.kind })
      return
    }
    if (reason?.kind === 'aborted') {
      // 用户手动停止：清掉待发，并暂停到下一次成功回合。
      clearPendingContinue(sessionId)
      continueStreaks.delete(sessionId)
      stoppedSessions.add(sessionId)
    }
  }

  try {
    ctx.inject(['agents'], (agentsCtx) => {
      const agents = agentsCtx.agents
      if (!agents) return
      const disposers = []
      const listen = (event, handler) => {
        try {
          const off = agentsCtx.on(event, handler)
          if (typeof off === 'function') disposers.push(off)
        } catch (error) {
          warn(`listen ${event} failed`, error)
        }
      }

      listen('session/event', (session, event) => {
        const sessionId = session?.id
        if (!sessionId) return
        if (event?.type === 'turn/start') {
          clearPendingContinue(sessionId)
          lastTools.delete(sessionId)
          clearTurnState(sessionId)
          turnSignals.set(sessionId, { checkpoint: false, assistant: false, tool: false })
        } else if (event?.type === 'user/message') {
          onHumanMessage(sessionId, event.data)
          const source = event.data?.source
          const signal = turnSignals.get(sessionId)
          if (
            signal &&
            (source?.kind === 'compact-checkpoint' ||
              (source?.kind === 'plugin' && source?.plugin === 'compact'))
          ) {
            signal.checkpoint = true
          }
        } else if (event?.type === 'assistant/message') {
          const signal = turnSignals.get(sessionId)
          if (signal) signal.assistant = true
        } else if (event?.type === 'turn/end') {
          onTurnEnd(agents, sessionId, event.data)
        } else if (event?.type === 'tool/call') {
          const signal = turnSignals.get(sessionId)
          if (signal) signal.tool = true
          onToolCall(sessionId, event.data)
        } else if (event?.type === 'tool/result') {
          const signal = turnSignals.get(sessionId)
          if (signal) signal.tool = true
          onToolResult(sessionId, event.data)
        }
        // 任何 durable 事件都是活动信号，重置看门狗倒计时。
        if (watchdogTimers.has(sessionId)) armWatchdog(agents, sessionId)
      })

      listen('agent/status', (payload) => {
        const agent = payload?.agent
        if (!agent || isSubagentAgent(agent)) return
        if (payload.status === 'running') armWatchdog(agents, agent.id)
        else disarmWatchdog(agent.id)
      })

      listen('agent/assistant-stream', (payload) => {
        const agent = payload?.agent
        if (!agent) return
        const frame = payload.frame
        const chunk = frame?.type === 'chunk' ? frame.chunk : undefined
        if (chunk?.type === 'finish' && typeof chunk.reason?.kind === 'string') {
          finishKinds.set(agent.id, chunk.reason.kind)
        }
        if (watchdogTimers.has(agent.id)) armWatchdog(agents, agent.id)
      })

      // max-tokens 同轮续写：turn 真正关闭前 steer 一条消息，让它接着写。
      listen('agent/turn-stopping', (payload) => {
        const agent = payload?.agent
        if (!agent || isSubagentAgent(agent) || payload?.signal?.aborted === true) return
        if (finishKinds.get(agent.id) !== 'max-tokens') return
        const settings = readSettings(config)
        if (!settings.autoContinue || !settings.continueOnMaxTokens || !getSettings()) return
        const previous = inTurnAttempts.get(agent.id)
        const attempts = previous && previous.turn === payload.turn ? previous.attempts : 0
        if (attempts >= IN_TURN_LIMIT) {
          finishKinds.delete(agent.id)
          return
        }
        try {
          const accepted = agent.steer(buildContinueMessage(IN_TURN_CONTINUE_TEXT))
          if (accepted === false) {
            finishKinds.delete(agent.id)
            return
          }
          inTurnAttempts.set(agent.id, { turn: payload.turn, attempts: attempts + 1 })
          finishKinds.delete(agent.id)
          ctx?.logger?.info?.(
            `auto-retry: in-turn continue ${attempts + 1}/${IN_TURN_LIMIT} for ${String(agent.id).slice(0, 8)}`,
          )
        } catch (error) {
          warn('in-turn continue failed', error)
        }
      })

      listen('agent/created', (payload) => {
        const agent = payload?.agent
        if (agent && agent.status === 'running' && !isSubagentAgent(agent)) armWatchdog(agents, agent.id)
      })

      listen('agent/disposed', (payload) => {
        const sessionId = payload?.agent?.id
        if (!sessionId) return
        clearPendingContinue(sessionId)
        disarmWatchdog(sessionId)
        continueStreaks.delete(sessionId)
        stoppedSessions.delete(sessionId)
        lastAutoMessage.delete(sessionId)
        lastTools.delete(sessionId)
        clearTurnState(sessionId)
      })

      // 设置变化时重新布防/撤防（看门狗开关与阈值是热的）。
      listen('settings/document-updated', () => syncWatchdogs(agents))

      // 插件加载时已经在跑的回合：按当前配置布防。
      syncWatchdogs(agents)

      if (typeof agentsCtx.effect === 'function') {
        agentsCtx.effect(() => () => {
          for (const off of disposers) {
            try { off() } catch { /* ignore */ }
          }
          for (const timer of pendingContinues.values()) clearTimeout(timer)
          for (const timer of watchdogTimers.values()) clearTimeout(timer)
          pendingContinues.clear()
          watchdogTimers.clear()
        }, 'auto-retry: auto-continue lifecycle')
      }
    })
  } catch (error) {
    warn('ctx.inject([\'agents\']) failed', error)
  }

  // 返回启动检查的 promise：settings 已就绪时（测试/进程内宿主）可 await；
  // 异步就绪时 apply 早已返回，检查在 settings 子级里继续跑。
  return firstInstall
}


