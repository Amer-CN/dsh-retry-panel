/**
 * dsh-auto-retry Host 侧单元测试。
 *
 * 直接跑：`node tests/server.test.mjs`，不启动 DSH、不读写任何真实 profile。
 * 测试自己伪造 ctx / settings：
 *   - fake settings 的 describe() 返回 `{ ns, revision, value }` 行；
 *   - fake ctx.inject(['settings'], cb) 同步创建并调用子级（settings 缺席时不回调），
 *     effect(fn) 立即执行，on(event, handler) 记录监听器。
 *
 * 覆盖：
 *   1. 导出契约（name / inject / Config / PRESETS）；
 *   2. 四档预设字段；
 *   3. buildOps 的路径与深拷贝；
 *   4. readPatience 的兜底与 volatile 引用读法；
 *   5. apply 注册 settings effect/监听，首次安装写入正确 ops；
 *   6. 已有 retryPolicy 时启动不写；
 *   7. 事件去重与换档后写入；
 *   8. settings 缺席 / describe 抛错 / mutate 拒绝时插件加载不失败。
 */
import assert from 'node:assert/strict'

import {
  Config,
  PRESETS,
  apply,
  applyToolGuard,
  buildContinueMessage,
  buildOps,
  clampInt,
  contentToText,
  continueDelayMs,
  countRecentFailures,
  decideTurnAction,
  fillContinueText,
  inject,
  isPermanentFailure,
  name,
  normalizePatience,
  parseFallbacks,
  readPatience,
  readSettings,
} from '../lib/index.js'

const LLM_NS = 'llm-pi-ai'
const failures = []
let passed = 0

/** 顺序执行一条用例；失败只记录，不中断后续用例。 */
async function test(label, run) {
  try {
    await run()
    passed += 1
    console.log(`ok ${passed} - ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.error(`not ok - ${label}`)
    console.error(error)
  }
}

/** 让 `void applyPatience(...)` 这类游离 promise 跑完。 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/**
 * 假 settings 服务。
 * @param {Array<object>} rows describe() 返回的行
 * @param {{ describeError?: Error, mutateError?: Error }} [options]
 */
function makeFakeSettings(rows, options = {}) {
  const calls = { describe: 0, mutate: [], configure: [] }
  const settings = {
    describe() {
      calls.describe += 1
      if (options.describeError) throw options.describeError
      return rows
    },
    async mutate(ns, ops, expectedRevision) {
      calls.mutate.push({ ns, ops, expectedRevision })
      if (options.mutateError) throw options.mutateError
    },
    configure(presentation, owner) {
      calls.configure.push({ presentation, owner })
      return () => {}
    },
  }
  return { settings, calls }
}

/**
 * 假 ctx。
 * @param {{ settings?: object, serviceAvailable?: boolean, getThrows?: Error }} [options]
 */
function makeFakeCtx(options = {}) {
  const { settings, serviceAvailable = true, getThrows, agents, services } = options
  const calls = {
    inject: [],
    effects: 0,
    listeners: new Map(),
    agentListeners: new Map(),
    warnings: [],
    infos: [],
  }
  const ctx = {
    fiber: { fake: true },
    logger: {
      info(message) {
        calls.infos.push(String(message))
      },
      warn(...args) {
        calls.warnings.push(args.map((arg) => String(arg)).join(' '))
      },
      error(...args) {
        calls.warnings.push(args.map((arg) => String(arg)).join(' '))
      },
    },
    get(serviceName) {
      if (getThrows) throw getThrows
      if (serviceName === 'settings') return serviceAvailable ? settings : undefined
      if (serviceName === 'agents') return agents
      if (services && Object.hasOwn(services, serviceName)) return services[serviceName]
      return undefined
    },
    inject(names, callback) {
      calls.inject.push(names)
      if (names.includes('settings')) {
        if (!serviceAvailable || !settings) return () => {}
        const settingsCtx = {
          settings,
          effect(run) {
            calls.effects += 1
            return run()
          },
          on(event, handler) {
            calls.listeners.set(event, handler)
            return () => {}
          },
        }
        callback(settingsCtx)
        return () => {}
      }
      if (names.includes('agents')) {
        if (!agents) return () => {}
        const agentsCtx = {
          agents,
          effect(run) {
            calls.effects += 1
            return run()
          },
          on(event, handler) {
            calls.agentListeners.set(event, handler)
            return () => {}
          },
        }
        callback(agentsCtx)
        return () => {}
      }
      return () => {}
    },
  }
  return { ctx, calls }
}

/** 一行 `llm-pi-ai` describe 结果。 */
function llmRow(providers) {
  return [{ ns: LLM_NS, revision: 0, value: { providers } }]
}

await test('导出契约：name / inject / Config / PRESETS', () => {
  assert.equal(name, 'auto-retry')
  assert.ok(Array.isArray(inject), 'inject 必须是数组')
  assert.deepEqual(inject, [], 'inject 必须为空（不硬依赖 settings）')
  // schemastery 的 schema 是「可调用函数对象」，所以 function 也是合法形态。
  assert.ok(Config && (typeof Config === 'object' || typeof Config === 'function'), 'Config 必须是 schemastery schema')
  assert.equal(typeof Config.toJSON, 'function', 'Config 必须可被 loader 解析（有 toJSON）')
  // 解析后 patience 是 volatile 引用（有 get），readPatience 能正确读到默认值/显式值。
  assert.equal(readPatience(Config({})), 'normal', '默认档位必须是 normal')
  assert.equal(readPatience(Config({ patience: 'long' })), 'long', 'volatile 引用必须能读出面板值')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof buildOps, 'function')
  assert.equal(typeof readPatience, 'function')
  assert.equal(typeof normalizePatience, 'function')
})

await test('PRESETS：四档齐全，字段与等待时长语义正确', () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), ['always', 'long', 'normal', 'off'])
  for (const id of ['off', 'normal', 'long', 'always']) {
    const preset = PRESETS[id]
    assert.ok(preset && typeof preset === 'object', `${id} 必须是对象`)
    assert.ok(preset.mode === 'normal' || preset.mode === 'always', `${id}.mode 合法`)
    assert.ok(preset.backoff && typeof preset.backoff === 'object', `${id}.backoff 存在`)
    assert.equal(typeof preset.backoff.initialDelayMs, 'number')
    assert.equal(typeof preset.backoff.maxDelayMs, 'number')
    assert.equal(typeof preset.backoff.jitterRatio, 'number')
  }
  assert.equal(PRESETS.off.mode, 'normal')
  assert.equal(PRESETS.off.maxRetries, 0, 'off 必须 0 次重试')
  assert.equal(PRESETS.normal.maxRetries, 10)
  assert.equal(PRESETS.long.maxRetries, 40)
  assert.equal(PRESETS.always.mode, 'always')
  assert.equal(PRESETS.always.maxRetries, undefined, 'always 不设次数上限')
  for (const id of ['off', 'normal', 'long']) {
    assert.ok(PRESETS[id].retryableCodes.includes('QUOTA'), `${id} 必须重试 QUOTA（网关会把瞬时 429 误归类）`)
    assert.ok(PRESETS[id].retryableCodes.includes('PI_AI_ERROR'), `${id} 必须重试 PI_AI_ERROR`)
    assert.ok(PRESETS[id].retryableCodes.includes('RATE_LIMIT'))
    assert.ok(PRESETS[id].retryableCodes.includes('UNKNOWN'))
  }
})

await test('buildOps：每个 provider 一条 set，路径正确且值为深拷贝', () => {
  const providers = { mock: {}, other: {} }
  const ops = buildOps(providers, 'long')
  assert.equal(ops.length, 2)
  assert.deepEqual(
    ops.map((op) => op.path),
    [
      ['providers', 'mock', 'retryPolicy'],
      ['providers', 'other', 'retryPolicy'],
    ],
  )
  for (const op of ops) {
    assert.equal(op.op, 'set')
    assert.deepEqual(op.value, PRESETS.long)
  }

  // 深拷贝：改一条 op 的值不能污染 PRESETS，也不能串到另一条 op。
  assert.notEqual(ops[0].value, PRESETS.long)
  assert.notEqual(ops[0].value, ops[1].value)
  assert.notEqual(ops[0].value.backoff, ops[1].value.backoff)
  ops[0].value.backoff.initialDelayMs = 999999
  ops[0].value.maxRetries = -1
  assert.equal(PRESETS.long.backoff.initialDelayMs, 1000, 'PRESETS 不能被测试改动影响')
  assert.equal(PRESETS.long.maxRetries, 40)
  assert.equal(ops[1].value.backoff.initialDelayMs, 1000)
})

await test('buildOps：非法档位回 normal，空/异常 providers 返回空数组', () => {
  const ops = buildOps({ only: {} }, 'bogus')
  assert.equal(ops.length, 1)
  assert.deepEqual(ops[0].value, PRESETS.normal)
  assert.deepEqual(buildOps({}, 'normal'), [])
  assert.deepEqual(buildOps(null, 'normal'), [])
  assert.deepEqual(buildOps(undefined, 'normal'), [])
  assert.deepEqual(buildOps([], 'normal'), [])
})

await test('readPatience：普通值、volatile 引用、非法值与缺省兜底', () => {
  assert.equal(readPatience(undefined), 'normal')
  assert.equal(readPatience(null), 'normal')
  assert.equal(readPatience({}), 'normal')
  assert.equal(readPatience({ patience: 'always' }), 'always')
  assert.equal(readPatience({ patience: 'bogus' }), 'normal')
  assert.equal(
    readPatience({
      patience: {
        get() {
          return 'long'
        },
      },
    }),
    'long',
    'config.patience 是 { get() } 时必须能读',
  )
  assert.equal(
    readPatience({
      patience: {
        get() {
          return 'NOPE'
        },
      },
    }),
    'normal',
  )
  assert.equal(
    readPatience({
      patience: {
        get() {
          throw new Error('boom')
        },
      },
    }),
    'normal',
    '读取抛错也要兜底',
  )
  assert.equal(normalizePatience('off'), 'off')
  assert.equal(normalizePatience(undefined), 'normal')
})

await test('apply：注册 settings effect/监听，首次安装写入全部 provider', async () => {
  const { settings, calls: settingsCalls } = makeFakeSettings(llmRow({ mock: {}, other: {} }))
  const { ctx, calls } = makeFakeCtx({ settings })

  await apply(ctx, { patience: 'long' })

  // 1) 注册了可选 settings 子级，并在子级里注册了两条 effect。
  assert.equal(calls.inject.length, 3)
  assert.deepEqual(calls.inject[0], ['settings'])
  assert.deepEqual(calls.inject[1], ['webServer', 'connection'])
  assert.deepEqual(calls.inject[2], ['agents'])
  assert.equal(calls.effects, 2, '应有 configure + document-updated 两条 effect')
  assert.ok(calls.listeners.has('settings/document-updated'), '必须监听 document-updated')

  // 2) configure({ auto: false }, ctx.fiber)
  assert.equal(settingsCalls.configure.length, 1)
  assert.deepEqual(settingsCalls.configure[0].presentation, { auto: false })
  assert.equal(settingsCalls.configure[0].owner, ctx.fiber)

  // 3) 首次安装：所有 provider 都没有 retryPolicy → 写两处，路径精确。
  assert.equal(settingsCalls.mutate.length, 1)
  const [{ ns, ops }] = settingsCalls.mutate
  assert.equal(ns, LLM_NS)
  assert.equal(ops.length, 2)
  assert.deepEqual(
    ops.map((op) => op.path),
    [
      ['providers', 'mock', 'retryPolicy'],
      ['providers', 'other', 'retryPolicy'],
    ],
  )
  for (const op of ops) {
    assert.equal(op.op, 'set')
    assert.deepEqual(op.value, PRESETS.long)
  }
  assert.ok(calls.infos.some((line) => line.includes('patience="long"')), '成功后有 info 日志')
})

await test('apply：已有任意 retryPolicy 时启动一律不写（尊重手工配置）', async () => {
  const custom = { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 500, maxDelayMs: 5000, jitterRatio: 0 } }
  const rows = llmRow({ mock: {}, other: { retryPolicy: custom } })
  const { settings, calls: settingsCalls } = makeFakeSettings(rows)
  const { ctx } = makeFakeCtx({ settings })

  await apply(ctx, { patience: 'always' })

  assert.equal(settingsCalls.mutate.length, 0, '已有自定义 retryPolicy 时不能写')
})

await test('apply：document-updated 只补首次安装检查，绝不在事件里写 provider', async () => {
  const { settings, calls: settingsCalls } = makeFakeSettings(llmRow({ mock: {}, other: {} }))
  const { ctx, calls } = makeFakeCtx({ settings })

  await apply(ctx, { patience: 'normal' })
  assert.equal(settingsCalls.mutate.length, 1, '首次安装写一次 normal')

  const listener = calls.listeners.get('settings/document-updated')
  assert.equal(typeof listener, 'function')

  // 面板保存触发的 provider 写入由浏览器侧完成；Host 在事件里再写会撞
  // settings 的 HMR 事务（"HMR transactions cannot be nested"），所以这里必须不写。
  listener('auto-retry')
  listener('llm-pi-ai')
  await flush()
  assert.equal(settingsCalls.mutate.length, 1, '事件里不允许再写')
})

await test('apply：settings 缺席时静默跳过，不抛错', async () => {
  const { ctx, calls } = makeFakeCtx({ serviceAvailable: false })
  await apply(ctx, { patience: 'long' })
  assert.deepEqual(calls.inject, [['settings'], ['webServer', 'connection'], ['agents']], '仍尝试注册可选子级')
  assert.equal(calls.effects, 0, 'settings 缺席时子级不运行')
  assert.equal(calls.warnings.length, 0, '缺席是正常情况，不需要警告')
})

await test('apply：ctx.get 抛错时只 warn，不阻断加载', async () => {
  const { ctx, calls } = makeFakeCtx({ getThrows: new Error('no service registry') })
  await apply(ctx, { patience: 'normal' })
  assert.ok(calls.warnings.some((line) => line.includes('settings')), '要有 warn')
})

await test('apply：settings.describe() 抛错时只 warn，不阻断加载', async () => {
  const rows = llmRow({ mock: {} })
  const { settings } = makeFakeSettings(rows, { describeError: new Error('configEditor unavailable') })
  const { ctx, calls } = makeFakeCtx({ settings })
  await apply(ctx, { patience: 'long' })
  assert.ok(calls.warnings.some((line) => line.includes('describe() failed')), '要警告 describe 失败')
})

await test('apply：settings.mutate() 拒绝时只 warn，不阻断加载', async () => {
  const { settings, calls: settingsCalls } = makeFakeSettings(llmRow({ mock: {} }), {
    mutateError: new Error('field is not volatile'),
  })
  const { ctx, calls } = makeFakeCtx({ settings })
  await apply(ctx, { patience: 'off' })
  assert.equal(settingsCalls.mutate.length, 1)
  assert.ok(calls.warnings.some((line) => line.includes('failed to write')), '要警告写入失败')
})

await test('apply：providers 为空或缺失时不写入', async () => {
  for (const rows of [llmRow({}), [], [{ ns: LLM_NS, revision: 0, value: {} }]]) {
    const { settings, calls: settingsCalls } = makeFakeSettings(rows)
    const { ctx } = makeFakeCtx({ settings })
    await apply(ctx, { patience: 'normal' })
    assert.equal(settingsCalls.mutate.length, 0)
  }
})

await test('apply：config 缺省按 normal 处理', async () => {
  const { settings, calls: settingsCalls } = makeFakeSettings(llmRow({ mock: {} }))
  const { ctx } = makeFakeCtx({ settings })
  await apply(ctx, undefined)
  assert.equal(settingsCalls.mutate.length, 1)
  assert.deepEqual(settingsCalls.mutate[0].ops[0].value, PRESETS.normal)
})

await test('readSettings：默认值、volatile 解包与 clamp', () => {
  const defaults = readSettings(undefined)
  assert.equal(defaults.patience, 'normal')
  assert.equal(defaults.autoContinue, true)
  assert.equal(defaults.continueDelaySec, 5)
  assert.equal(defaults.maxConsecutive, 5)
  assert.equal(defaults.continueText, '继续')
  assert.equal(defaults.continueOnMaxTokens, true)
  assert.equal(defaults.idleWatchdog, false)
  assert.equal(defaults.idleTimeoutSec, 180)

  const custom = readSettings({
    patience: { get: () => 'always' },
    autoContinue: { get: () => false },
    continueDelaySec: { get: () => 9999 },
    maxConsecutive: { get: () => 0 },
    continueText: { get: () => '  再试试  ' },
    continueOnMaxTokens: { get: () => false },
    idleWatchdog: { get: () => true },
    idleTimeoutSec: { get: () => 1 },
  })
  assert.equal(custom.patience, 'always')
  assert.equal(custom.autoContinue, false)
  assert.equal(custom.continueDelaySec, 600, '上限 600 秒')
  assert.equal(custom.maxConsecutive, 1, '下限 1 次')
  assert.equal(custom.continueText, '再试试')
  assert.equal(custom.continueOnMaxTokens, false)
  assert.equal(custom.idleWatchdog, true)
  assert.equal(custom.idleTimeoutSec, 30, '下限 30 秒')

  assert.equal(clampInt('abc', 0, 10, 3), 3)
  assert.equal(clampInt(12.6, 0, 10, 3), 10)
  assert.equal(clampInt(-5, 0, 10, 3), 0)
})

await test('decideTurnAction：成功重置 / 失败继续 / 用户停止不继续 / 截断与看门狗', () => {
  const base = { autoContinue: true, continueOnMaxTokens: true, idleWatchdog: false }
  assert.equal(decideTurnAction({ kind: 'completed' }, base), 'reset')
  assert.equal(decideTurnAction({ kind: 'error', error: { code: 'RATE_LIMIT' } }, base), 'continue')
  assert.equal(decideTurnAction({ kind: 'error' }, { ...base, autoContinue: false }), 'none')
  assert.equal(decideTurnAction({ kind: 'error', error: { code: 'AUTH' } }, base), 'skip')
  assert.equal(decideTurnAction({ kind: 'error', error: { code: 'QUOTA' } }, base), 'skip')
  assert.equal(decideTurnAction({ kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } }, base), 'skip')
  assert.equal(decideTurnAction({ kind: 'error', error: { code: 'INVALID_REQUEST' } }, base), 'skip')
  assert.equal(decideTurnAction({ kind: 'error', error: { code: 'SERVER' } }, base), 'continue')
  assert.equal(decideTurnAction({ kind: 'max-tokens' }, base), 'continue')
  assert.equal(decideTurnAction({ kind: 'max-tokens' }, { ...base, continueOnMaxTokens: false }), 'none')
  assert.equal(decideTurnAction({ kind: 'aborted', reason: { kind: 'user' } }, base), 'none')
  assert.equal(decideTurnAction({ kind: 'aborted', reason: { kind: 'hook' } }, { ...base, idleWatchdog: true }), 'continue')
  assert.equal(decideTurnAction({ kind: 'aborted', reason: { kind: 'hook' } }, { ...base, idleWatchdog: false }), 'none')
  assert.equal(decideTurnAction({ kind: 'interrupted' }, base), 'none')
})

await test('isPermanentFailure：认证/额度/上下文/模型不存在为永久，网络类为临时', () => {
  assert.equal(isPermanentFailure({ code: 'AUTH' }), true)
  assert.equal(isPermanentFailure({ code: 'QUOTA' }), true)
  assert.equal(isPermanentFailure({ code: 'UNKNOWN_MODEL' }), true)
  assert.equal(isPermanentFailure({ code: 'X', message: 'invalid api key' }), true)
  assert.equal(isPermanentFailure({ code: 'X', message: 'maximum context length exceeded' }), true)
  assert.equal(isPermanentFailure({ code: 'RATE_LIMIT', message: '429 capacity' }), false)
  assert.equal(isPermanentFailure({ code: 'SERVER', message: '502 bad gateway' }), false)
  assert.equal(isPermanentFailure({ code: 'X', message: 'socket hang up' }), false)
})

await test('continueDelayMs：连续失败按 2 倍增长，封顶 10 分钟', () => {
  const settings = { continueDelaySec: 5 }
  assert.equal(continueDelayMs(settings, 0), 5000)
  assert.equal(continueDelayMs(settings, 1), 10000)
  assert.equal(continueDelayMs(settings, 3), 40000)
  assert.equal(continueDelayMs(settings, 20), 600000)
  assert.equal(continueDelayMs({ continueDelaySec: 0 }, 5), 0)
})

await test('fillContinueText / applyToolGuard：模板占位符与幂等护栏', () => {
  assert.equal(fillContinueText('继续', { code: '429' }), '继续')
  assert.equal(fillContinueText('继续（{code}，第 {attempt} 次）', { code: '429', attempt: 2 }), '继续（429，第 2 次）')
  assert.equal(fillContinueText('', { code: '429' }), '继续')
  const guarded = applyToolGuard('继续', { name: 'git_push', result: false })
  assert.ok(guarded.includes('git_push'))
  assert.ok(guarded.includes('可能没有完成'))
  assert.equal(applyToolGuard('继续', { name: 'git_push', result: true }), '继续')
  assert.equal(applyToolGuard('继续', undefined), '继续')
})

await test('buildContinueMessage：user 角色 + text part + user source', () => {
  const message = buildContinueMessage('继续')
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, '继续')
  assert.equal(message.source.kind, 'user')
  assert.ok(typeof message.id === 'string' && message.id.length > 0)
  assert.equal(contentToText([{ type: 'text', text: '继' }, { type: 'text', text: '续' }]), '继续')
  assert.equal(contentToText('继续'), '继续')
  assert.equal(contentToText(undefined), '')
})

/** 假 agent：只实现自动继续用到的字段。 */
function makeFakeAgent(id = 'session-1', events = []) {
  return {
    id,
    status: 'idle',
    session: {
      header: { origin: 'main' },
      seq: events.length,
      eventAt(index) {
        return events[index]
      },
    },
    followups: [],
    cancels: [],
    steers: [],
    followup(message) {
      this.followups.push(message)
    },
    steer(message) {
      this.steers.push(message)
      return true
    },
    cancel(cause, options) {
      this.cancels.push({ cause, options })
    },
  }
}

function makeFakeAgents(agent) {
  return {
    get(id) {
      return id === agent.id ? agent : undefined
    },
    list() {
      return [agent]
    },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function setupAutoContinue(overrides = {}, agent = makeFakeAgent(), services = {}) {
  const agents = makeFakeAgents(agent)
  const { settings } = makeFakeSettings(llmRow({ mock: { retryPolicy: { mode: 'normal', maxRetries: 0 } } }))
  const { ctx, calls } = makeFakeCtx({ settings, agents, services })
  const config = {
    patience: 'normal',
    autoContinue: true,
    continueDelaySec: 0,
    maxConsecutive: 2,
    continueText: '继续',
    continueOnMaxTokens: true,
    idleWatchdog: false,
    idleTimeoutSec: 180,
    ...overrides,
  }
  await apply(ctx, config)
  const emit = calls.agentListeners.get('session/event')
  assert.equal(typeof emit, 'function', '要注册 session/event')
  return { agent, agents, ctx, calls, emit }
}

await test('auto-continue：error 回合后发送「继续」，达到 maxConsecutive 停止', async () => {
  const { agent, emit } = await setupAutoContinue({ maxConsecutive: 2 })
  const errorTurn = { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } } }

  emit({ id: agent.id }, errorTurn)
  await sleep(20)
  assert.equal(agent.followups.length, 1)
  assert.equal(agent.followups[0].content[0].text, '继续')

  emit({ id: agent.id }, errorTurn)
  await sleep(20)
  assert.equal(agent.followups.length, 2)

  emit({ id: agent.id }, errorTurn)
  await sleep(20)
  assert.equal(agent.followups.length, 2, '超过上限后不再自动继续')
})

await test('auto-continue：截断回合按开关继续；用户手动停止后不再继续，成功回合重置', async () => {
  const { agent, emit } = await setupAutoContinue()
  const maxTokens = { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }
  emit({ id: agent.id }, maxTokens)
  await sleep(20)
  assert.equal(agent.followups.length, 1, '截断也要继续')

  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } } })
  await sleep(20)
  assert.equal(agent.followups.length, 1, '用户手动停止后不自动继续')

  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } } })
  await sleep(20)
  assert.equal(agent.followups.length, 2, '成功回合后恢复自动继续')
})

await test('auto-continue：人工消息取消待发；自身「继续」回显不取消', async () => {
  const { agent, emit } = await setupAutoContinue({ continueDelaySec: 1 })
  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SERVER' } } } })
  // 模拟用户在这 200ms 内插话
  emit(
    { id: agent.id },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先别动' }] } },
  )
  await sleep(300)
  assert.equal(agent.followups.length, 0, '人工消息后取消待发')
})

await test('auto-continue：AUTH 等永久失败不自动继续', async () => {
  const { agent, emit } = await setupAutoContinue()
  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH' } } } })
  await sleep(20)
  assert.equal(agent.followups.length, 0, '认证失败重试无意义，必须人工处理')
})

await test('auto-continue：最后工具无结果时附加幂等护栏；有结果则不附加', async () => {
  const { agent, emit } = await setupAutoContinue()

  emit({ id: agent.id }, { type: 'tool/call', data: { name: 'git_push', callId: 'c1' } })
  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SERVER' } } } })
  await sleep(20)
  const guarded = agent.followups[0].content[0].text
  assert.ok(guarded.includes('git_push'), '护栏要点名工具')
  assert.ok(guarded.includes('可能没有完成'), '没结果时要提醒先核验')

  emit({ id: agent.id }, { type: 'turn/start' })
  emit({ id: agent.id }, { type: 'tool/call', data: { name: 'read_file', callId: 'c2' } })
  emit(
    { id: agent.id },
    { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c2' }] } } },
  )
  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SERVER' } } } })
  await sleep(20)
  assert.equal(agent.followups[1].content[0].text, '继续', '有结果时不附加护栏')
})

await test('压缩吞轮：检查点后零产出 completed 自动补续写；有 assistant 输出不补', async () => {
  const { agent, emit } = await setupAutoContinue()

  emit({ id: agent.id }, { type: 'turn/start' })
  emit(
    { id: agent.id },
    { type: 'user/message', data: { source: { kind: 'compact-checkpoint' }, content: [] } },
  )
  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await sleep(20)
  assert.equal(agent.followups.length, 1, '压缩检查点吞轮要补续写')
  assert.ok(agent.followups[0].content[0].text.includes('检查点'))

  emit({ id: agent.id }, { type: 'turn/start' })
  emit(
    { id: agent.id },
    { type: 'user/message', data: { source: { kind: 'compact-checkpoint' }, content: [] } },
  )
  emit({ id: agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await sleep(20)
  assert.equal(agent.followups.length, 1, '有正常输出就不是压缩吞轮')
})

await test('in-turn：max-tokens 时同轮 steer 续写，单轮上限 3 次', async () => {
  const { agent, calls } = await setupAutoContinue()
  const stream = calls.agentListeners.get('agent/assistant-stream')
  const stopping = calls.agentListeners.get('agent/turn-stopping')
  assert.equal(typeof stream, 'function')
  assert.equal(typeof stopping, 'function')

  for (let i = 1; i <= 3; i += 1) {
    stream({ agent, frame: { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'max-tokens' } } } })
    stopping({ agent, turn: 7, signal: { aborted: false } })
    assert.equal(agent.steers.length, i, `第 ${i} 次同轮续写`)
  }
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'max-tokens' } } } })
  stopping({ agent, turn: 7, signal: { aborted: false } })
  assert.equal(agent.steers.length, 3, '达到单轮上限后放行 turn/end')
  assert.ok(agent.steers[0].content[0].text.includes('截断'))

  // 非 max-tokens 的 finish 不触发
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } } })
  stopping({ agent, turn: 8, signal: { aborted: false } })
  assert.equal(agent.steers.length, 3)
})

await test('apply：首次安装同时补 llm-deepseek.retryPolicy', async () => {
  const rows = [...llmRow({ mock: {} }), { ns: 'llm-deepseek', revision: 4, value: {} }]
  const { settings, calls } = makeFakeSettings(rows)
  const { ctx } = makeFakeCtx({ settings })
  await apply(ctx, { patience: 'long' })
  assert.equal(calls.mutate.length, 2, 'pi-ai 与 deepseek 各写一次')
  const deepseek = calls.mutate.find((call) => call.ns === 'llm-deepseek')
  assert.ok(deepseek, '必须覆盖 DeepSeek 官方 provider')
  assert.deepEqual(deepseek.ops, [{ op: 'set', path: ['retryPolicy'], value: PRESETS.long }])
})

await test('apply：llm-deepseek 已有 retryPolicy 时不覆盖', async () => {
  const rows = [
    ...llmRow({ mock: {} }),
    { ns: 'llm-deepseek', revision: 4, value: { retryPolicy: { mode: 'always' } } },
  ]
  const { settings, calls } = makeFakeSettings(rows)
  const { ctx } = makeFakeCtx({ settings })
  await apply(ctx, { patience: 'normal' })
  assert.equal(calls.mutate.length, 1, '只补 pi-ai，不碰手工配置的 deepseek')
  assert.equal(calls.mutate[0].ns, 'llm-pi-ai')
})

await test('历史计数：插件重载后仍按连续失败上限收手', async () => {
  const events = Array.from({ length: 6 }, () => ({
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { code: 'SERVER' } } },
  }))
  const agent = makeFakeAgent('session-1', events)
  const { emit } = await setupAutoContinue({ maxConsecutive: 5 }, agent)
  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SERVER' } } } })
  await sleep(20)
  assert.equal(agent.followups.length, 0, '历史已有 6 次连续失败，超过 5 次上限')
})

await test('历史计数：最近一次 completed 之后重新计数', async () => {
  const events = [
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SERVER' } } } },
  ]
  const agent = makeFakeAgent('session-1', events)
  const { emit } = await setupAutoContinue({ maxConsecutive: 5 }, agent)
  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SERVER' } } } })
  await sleep(20)
  assert.equal(agent.followups.length, 1, 'completed 之后应重新允许继续')
})

await test('parseFallbacks：解析 provider/model、去重并丢弃非法项', () => {
  assert.deepEqual(parseFallbacks('p1/m1, p2/m2\np1/m1'), [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2' },
  ])
  assert.deepEqual(parseFallbacks('p1:m1; p2:m2'), [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2' },
  ])
  assert.deepEqual(parseFallbacks('bad, /m, p/'), [])
  assert.deepEqual(parseFallbacks(''), [])
  assert.deepEqual(parseFallbacks('p1/m1#high, p2/m2'), [
    { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    { provider: 'p2', model: 'm2' },
  ])
})

await test('failover：失败后按顺序切备用模型，成功后重置', async () => {
  const selections = []
  const services = {
    sessionController: {
      agents: {
        selectForNextRequest(agent, selected) {
          selections.push(selected)
        },
      },
    },
  }
  const { agent, emit } = await setupAutoContinue(
    { failover: true, fallbacks: 'p2/m2,p3/m3', healthCooldownSec: 0 },
    undefined,
    services,
  )
  const errorTurn = { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } } }

  emit({ id: agent.id }, errorTurn)
  await sleep(20)
  assert.deepEqual(selections[0], { provider: 'p2', model: 'm2' })
  assert.equal(agent.followups.length, 1)

  emit({ id: agent.id }, errorTurn)
  await sleep(20)
  assert.deepEqual(selections[1], { provider: 'p3', model: 'm3' })

  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  emit({ id: agent.id }, errorTurn)
  await sleep(20)
  assert.deepEqual(selections[2], { provider: 'p2', model: 'm2' }, '成功后从第一个备用模型重新开始')
})

await test('failover：开关关闭时不切模型', async () => {
  const selections = []
  const services = {
    sessionController: { agents: { selectForNextRequest(agent, selected) { selections.push(selected) } } },
  }
  const { agent, emit } = await setupAutoContinue({ failover: false, fallbacks: 'p2/m2' }, undefined, services)
  emit({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SERVER' } } } })
  await sleep(20)
  assert.equal(selections.length, 0)
  assert.equal(agent.followups.length, 1, '不换模型也要继续')
})

await test('冷会话扫描：启动后恢复最近失败会话', async () => {
  const agent = makeFakeAgent('cold-1')
  let resolved = false
  const agents = {
    get(id) {
      return id === 'cold-1' && resolved ? agent : undefined
    },
    list() {
      return []
    },
  }
  const services = {
    sessionController: {
      async list() {
        return { items: [{ sessionId: 'cold-1', updatedAt: Date.now() }] }
      },
      async inspect() {
        return {
          events: [
            { type: 'turn/start' },
            { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SERVER' } } } },
          ],
        }
      },
      async resolveAgent() {
        resolved = true
        return { agent }
      },
    },
  }
  const { settings } = makeFakeSettings(llmRow({ mock: { retryPolicy: { mode: 'normal', maxRetries: 0 } } }))
  const { ctx, calls } = makeFakeCtx({ settings, agents, services })
  process.env.DSH_AUTO_RETRY_BOOT_DELAY_MS = '5'
  try {
    await apply(ctx, {
      patience: 'normal',
      autoContinue: true,
      continueDelaySec: 0,
      maxConsecutive: 5,
      scanOnBoot: true,
    })
    await sleep(80)
  } finally {
    delete process.env.DSH_AUTO_RETRY_BOOT_DELAY_MS
  }
  assert.equal(agent.followups.length, 1, '冷会话应被唤醒并补一条继续')
  assert.ok(calls.infos.some((line) => line.includes('boot scan recovered')))
})

await test('路由健康：失败过的备用在冷却期内跳过', async () => {
  const selections = []
  const services = {
    sessionController: { agents: { selectForNextRequest(agent, selected) { selections.push(selected) } } },
  }
  const { agent, emit } = await setupAutoContinue(
    { failover: true, fallbacks: 'p2/m2,p3/m3', healthCooldownSec: 300, maxConsecutive: 5 },
    undefined,
    services,
  )
  const errorTurn = { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SERVER' } } } }
  emit({ id: agent.id }, errorTurn)
  await sleep(20)
  emit({ id: agent.id }, errorTurn)
  await sleep(20)
  emit({ id: agent.id }, errorTurn)
  await sleep(20)
  assert.deepEqual(selections, [
    { provider: 'p2', model: 'm2' },
    { provider: 'p3', model: 'm3' },
  ], 'p2 失败后冷却，第三次没有健康候选可切')
  assert.equal(agent.followups.length, 3, '没有候选时仍继续')
})

if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed`)
  for (const { label } of failures) console.error(`  FAILED: ${label}`)
  process.exitCode = 1
} else {
  console.log(`\n${passed} passed`)
}


