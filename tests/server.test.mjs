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
  buildOps,
  inject,
  name,
  normalizePatience,
  readPatience,
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
  const { settings, serviceAvailable = true, getThrows } = options
  const calls = {
    inject: [],
    effects: 0,
    listeners: new Map(),
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
      if (serviceName !== 'settings') return undefined
      return serviceAvailable ? settings : undefined
    },
    inject(names, callback) {
      calls.inject.push(names)
      // 本测试只伪造 settings；webServer/connection 子级不模拟（真机上才有）。
      if (!names.includes('settings')) return () => {}
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
  assert.equal(calls.inject.length, 2)
  assert.deepEqual(calls.inject[0], ['settings'])
  assert.deepEqual(calls.inject[1], ['webServer', 'connection'])
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
  assert.deepEqual(calls.inject, [['settings'], ['webServer', 'connection']], '仍尝试注册可选子级')
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

if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed`)
  for (const { label } of failures) console.error(`  FAILED: ${label}`)
  process.exitCode = 1
} else {
  console.log(`\n${passed} passed`)
}
