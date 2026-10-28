/**
 * dsh-auto-retry 浏览器侧自测（node:vm，不启动 DSH，不碰桌面 profile）。
 *
 * 跑法：node tests/client.test.mjs
 *
 * 做法：在 vm 里造一个只暴露 `window.__ModuleLoader__.load` 的沙箱，桩掉
 * `require('react')`，加载 lib/client.js。除了规格要求的「导出 / 注册」断言，
 * 还用一个很小的 hooks 运行时把组件真渲染出来，检查文案、点选只改草稿、
 * 保存成功/失败的提示和只读分支。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(HERE, '..', 'lib', 'client.js')
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

/** 规格要求的四档文案（顺序即面板顺序）。 */
const OPTION_TITLES = ['普通', '长任务', '死磕', '关闭']
const OPTION_DESCS = [
  '最多等 5 分钟，日常断流够用',
  '最多等 35 分钟，出门前选这个',
  '一直等到成功，整晚挂机选这个',
  '不自动重试，断了你自己重发',
]
const CARD_INTRO = '模型限流或网络断开时，DSH 会自动重试，不用你手动发“继续”。'

/**
 * 加载 lib/client.js。
 * @param {object} react 桩 react，必须提供 createElement / useState / useEffect。
 * @returns {object} factory 返回的 exports（应有 apply / inject）。
 */
function loadClient(react) {
  let exportsValue
  const loaded = []
  const window = {
    __ModuleLoader__: {
      load(entry) {
        loaded.push(entry)
        exportsValue = entry.factory((name) => {
          assert.equal(name, 'react', 'factory 只应该 require("react")')
          return react
        })
      },
    },
  }
  const context = vm.createContext({ window, console })
  vm.runInContext(SOURCE, context, { filename: CLIENT_PATH })

  assert.equal(loaded.length, 1, '__ModuleLoader__.load 应被调用一次')
  assert.equal(loaded[0].id, 'dsh-auto-retry', '客户端条目 id')
  assert.ok(exportsValue !== null && typeof exportsValue === 'object', 'factory 应返回 exports')
  return exportsValue
}

/** 假配置表单 scope：可读快照、可订阅、可记录写入、可模拟拒绝/抛错。 */
function makeScope(initialSnapshot, options = {}) {
  let snapshot = initialSnapshot
  const listeners = new Set()
  const mutateCalls = []
  return {
    mutateCalls,
    getSnapshot() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async mutate(ops, revision) {
      mutateCalls.push({ ops, revision })
      if (options.mutateThrows === true) throw new Error('模拟传输失败')
      return options.mutateResult === undefined ? true : options.mutateResult
    },
    /** 模拟宿主推送一份新快照。 */
    push(next) {
      snapshot = next
      for (const listener of Array.from(listeners)) listener()
    },
    listenerCount() {
      return listeners.size
    },
  }
}

/** 假 ctx：`effect(fn)` 直接执行 fn；slots / configForms 记录调用。 */
function makeCtx(scope) {
  const calls = { gets: [], whileServed: [], slotInjects: [], registers: [], effects: 0 }
  const configForms = {
    get(namespace) {
      calls.gets.push(namespace)
      return scope
    },
    whileServed(namespaces, register) {
      calls.whileServed.push(namespaces)
      return register()
    },
  }
  const slots = {
    inject(name, register) {
      calls.slotInjects.push(name)
      return register()
    },
    register(spec, component) {
      calls.registers.push({ spec, component })
      return () => {}
    },
  }
  const ctx = {
    configForms,
    slots,
    effect(register) {
      calls.effects += 1
      return register()
    },
  }
  return { ctx, calls }
}

/**
 * 极简 hooks 运行时：够把本卡片真渲染出来即可。
 * - useState 按 hook 槽位存值，setState 标记需要重渲染；
 * - useEffect 按 deps 浅比较决定是否重跑，并保存 cleanup。
 */
function createRenderer() {
  const runtime = {
    component: null,
    props: null,
    states: [],
    effects: [],
    cursor: 0,
    pending: [],
    dirty: false,
    tree: null,
  }

  function sameDeps(left, right) {
    if (left === undefined || right === undefined) return false
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!Object.is(left[index], right[index])) return false
    }
    return true
  }

  const react = {
    createElement(type, props, ...children) {
      const childrenValue =
        children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      const merged = props === null || props === undefined ? {} : props
      return { type, props: { ...merged, children: childrenValue } }
    },
    useState(initial) {
      const slot = runtime.cursor
      runtime.cursor += 1
      if (!Object.prototype.hasOwnProperty.call(runtime.states, slot)) {
        runtime.states[slot] = typeof initial === 'function' ? initial() : initial
      }
      const setState = (next) => {
        const previous = runtime.states[slot]
        const value = typeof next === 'function' ? next(previous) : next
        if (Object.is(previous, value)) return
        runtime.states[slot] = value
        runtime.dirty = true
      }
      return [runtime.states[slot], setState]
    },
    useEffect(effect, deps) {
      const slot = runtime.cursor
      runtime.cursor += 1
      runtime.pending.push({ slot, effect, deps })
    },
  }

  function render() {
    let guard = 0
    do {
      runtime.dirty = false
      runtime.cursor = 0
      runtime.pending = []
      runtime.tree = runtime.component(runtime.props)

      for (const entry of runtime.pending) {
        const previous = runtime.effects[entry.slot]
        if (previous !== undefined && sameDeps(previous.deps, entry.deps)) continue
        if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
        runtime.effects[entry.slot] = { deps: entry.deps, cleanup: undefined }
        const cleanup = entry.effect()
        runtime.effects[entry.slot] = {
          deps: entry.deps,
          cleanup: typeof cleanup === 'function' ? cleanup : undefined,
        }
        if (runtime.dirty) break
      }

      guard += 1
      assert.ok(guard <= 50, '卡片渲染没有收敛（可能是 effect 在反复改 state）')
    } while (runtime.dirty)

    return runtime.tree
  }

  return {
    react,
    mount(component, props) {
      runtime.component = component
      runtime.props = props
      runtime.states = []
      runtime.effects = []
      runtime.cursor = 0
      runtime.pending = []
      runtime.dirty = false
      runtime.tree = null
      return render()
    },
    render,
    unmount() {
      for (const record of runtime.effects) {
        if (record !== undefined && typeof record.cleanup === 'function') record.cleanup()
      }
    },
  }
}

/** 深度优先遍历元素节点。 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  walk(node.props === undefined ? undefined : node.props.children, visit)
}

/** 取出子树里的所有文字，按出现顺序用换行拼起来。 */
function textOf(node) {
  const parts = []
  const visit = (current) => {
    if (current === null || current === undefined || typeof current === 'boolean') return
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    if (typeof current === 'string' || typeof current === 'number') {
      parts.push(String(current))
      return
    }
    visit(current.props === undefined ? undefined : current.props.children)
  }
  visit(node)
  return parts.join('\n')
}

function findAll(node, predicate) {
  const found = []
  walk(node, (element) => {
    if (predicate(element)) found.push(element)
  })
  return found
}

const radioButtons = (tree) =>
  findAll(tree, (element) => element.type === 'button' && element.props.role === 'radio')

const saveButton = (tree) => {
  const buttons = findAll(tree, (element) => element.type === 'button' && element.props.role !== 'radio')
  assert.equal(buttons.length, 1, '卡片底部应只有一个保存按钮')
  return buttons[0]
}

/** 按 aria-label 找某个输入控件。 */
const inputByLabel = (tree, label) => {
  const inputs = findAll(tree, (element) => element.type === 'input' && element.props['aria-label'] === label)
  assert.equal(inputs.length, 1, `应有一个输入控件：${label}`)
  return inputs[0]
}

/** 注册 + 挂载一次卡片，返回渲染树和卸载用的 renderer。 */
function setup(scope, options = {}) {
  const renderer = createRenderer()
  const client = loadClient(renderer.react)
  const { ctx, calls } = makeCtx(scope)
  client.apply(ctx)
  assert.equal(calls.registers.length, 1, '应注册一个设置区块')
  const { spec, component } = calls.registers[0]
  const applied = []
  const applyPreset =
    options.applyPreset ??
    (async (patience) => {
      applied.push(patience)
      return options.applyResult === undefined ? true : options.applyResult
    })
  const injected = spec.inject()
  const tree = renderer.mount(component, { ...injected, applyPreset })
  return { renderer, client, ctx, calls, spec, component, tree, applied, applyPreset }
}

const READY = (patience, revision) => ({ status: 'ready', value: { patience }, revision })

test('导出与注册：apply / inject 齐全，卡片挂到 settings.section', () => {
  const renderer = createRenderer()
  const client = loadClient(renderer.react)

  assert.equal(typeof client.apply, 'function', '应导出 apply')
  assert.ok(Array.isArray(client.inject), 'inject 应是数组')
  assert.deepEqual(Array.from(client.inject), ['slots', 'configForms'])
  assert.ok(client.inject.includes('slots'))
  assert.ok(client.inject.includes('configForms'))

  const scope = makeScope(READY('normal', 1))
  const { ctx, calls } = makeCtx(scope)
  client.apply(ctx)

  assert.deepEqual(calls.gets, ['auto-retry'], 'configForms.get 应取 auto-retry')
  assert.equal(calls.effects, 1, '应通过 ctx.effect 包住注册')
  assert.equal(calls.whileServed.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.whileServed)), [['auto-retry']])
  assert.ok(calls.slotInjects.includes('settings.section'))
  assert.equal(calls.registers.length, 1)

  const { spec, component } = calls.registers[0]
  assert.equal(spec.name, 'settings.section')
  assert.equal(spec.id, 'auto-retry')
  assert.equal(spec.label, '断线重试')
  assert.equal(spec.order, 78)
  assert.equal(typeof component, 'function', '注册的应是组件函数')

  const injected = spec.inject()
  assert.equal(injected.scope, scope, '组件通过 inject 拿到 scope')
  assert.equal(injected.asSection, true, '卡片是 section')
})

test('卡片文案：标题、一行说明、四档顺序与底部小字', () => {
  const { renderer, tree } = setup(makeScope(READY('normal', 3)))
  const text = textOf(tree)

  assert.ok(text.includes('断线自动重试'), '卡片标题')
  assert.ok(text.includes(CARD_INTRO), '一行说明')
  assert.ok(text.includes('改完不用重启。'), '底部小字')

  const options = radioButtons(tree)
  assert.equal(options.length, 4, '应有四个选项')
  assert.deepEqual(
    options.map((button) => textOf(button).split('\n')[0]),
    OPTION_TITLES,
  )
  options.forEach((button, index) => {
    assert.ok(textOf(button).includes(OPTION_DESCS[index]), `第 ${index + 1} 档说明`)
  })
  assert.deepEqual(
    options.map((button) => button.props['aria-checked']),
    [true, false, false, false],
    '默认选中「普通」',
  )

  assert.equal(textOf(saveButton(tree)), '保存')
  assert.equal(saveButton(tree).props.disabled, true, '没有改动时保存不可点')
  renderer.unmount()
})

test('点选项只改草稿；保存成功提示「已保存，立即生效」', async () => {
  const scope = makeScope(READY('normal', 7))
  const { renderer, tree, applied } = setup(scope)

  radioButtons(tree)[1].props.onClick()
  let next = renderer.render()

  assert.equal(radioButtons(next)[1].props['aria-checked'], true)
  assert.equal(radioButtons(next)[0].props['aria-checked'], false)
  assert.equal(scope.mutateCalls.length, 0, '点选项不应直接写设置')
  assert.equal(saveButton(next).props.disabled, false, '有改动后保存可点')
  assert.ok(textOf(next).includes('有改动，还没保存'))

  await saveButton(next).props.onClick()
  next = renderer.render()

  assert.equal(scope.mutateCalls.length, 1)
  assert.deepEqual(applied, ['long'], '先写 provider retryPolicy，再保存档位')
  const ops = JSON.parse(JSON.stringify(scope.mutateCalls[0].ops))
  assert.deepEqual(
    ops.map((op) => op.path[0]),
    [
      'patience',
      'autoContinue',
      'continueDelaySec',
      'maxConsecutive',
      'continueText',
      'failover',
      'fallbacks',
      'continueOnMaxTokens',
      'idleWatchdog',
      'idleTimeoutSec',
    ],
    '保存一次写全部 10 个字段',
  )
  assert.equal(ops[0].value, 'long')
  assert.equal(ops[1].value, true)
  assert.equal(ops[2].value, 5)
  assert.equal(ops[3].value, 5)
  assert.equal(ops[4].value, '继续')
  assert.equal(ops[5].value, false)
  assert.equal(ops[6].value, '')
  assert.equal(ops[7].value, true)
  assert.equal(ops[8].value, false)
  assert.equal(ops[9].value, 180)
  assert.equal(scope.mutateCalls[0].revision, 7, '带上当前快照的 revision')
  assert.ok(textOf(next).includes('已保存，立即生效'))
  assert.equal(saveButton(next).props.disabled, true, '保存成功后按钮回到禁用')
  renderer.unmount()
})

test('自动继续控件：保存 10 个字段并 clamp 数字', async () => {
  const scope = makeScope(READY('normal', 3))
  const { renderer, tree } = setup(scope)

  assert.equal(inputByLabel(tree, '卡住判定秒数').props.disabled, true, '未开卡住检测时秒数禁用')

  inputByLabel(tree, '回合失败后自动发送继续').props.onChange({ target: { checked: false } })
  let next = renderer.render()
  inputByLabel(next, '自动继续等待秒数').props.onChange({ target: { value: '9999' } })
  next = renderer.render()
  inputByLabel(next, '最多连续自动继续次数').props.onChange({ target: { value: '0' } })
  next = renderer.render()
  inputByLabel(next, '输出被截断时也继续').props.onChange({ target: { checked: false } })
  next = renderer.render()
  inputByLabel(next, '卡住时自动重来').props.onChange({ target: { checked: true } })
  next = renderer.render()
  assert.equal(inputByLabel(next, '卡住判定秒数').props.disabled, false, '勾选后秒数可编辑')
  inputByLabel(next, '卡住判定秒数').props.onChange({ target: { value: '9999' } })
  next = renderer.render()

  await saveButton(next).props.onClick()
  const ops = scope.mutateCalls[0].ops
  const by = Object.fromEntries(ops.map((op) => [op.path[0], op.value]))
  assert.equal(by.autoContinue, false)
  assert.equal(by.continueDelaySec, 600, '等待秒数上限 600')
  assert.equal(by.maxConsecutive, 1, '连续次数下限 1')
  assert.equal(by.continueOnMaxTokens, false)
  assert.equal(by.idleWatchdog, true)
  assert.equal(by.idleTimeoutSec, 600, '卡住秒数上限 600')
  assert.ok(textOf(renderer.render()).includes('已保存，立即生效'))
  renderer.unmount()
})

test('备用模型：开关与列表写入，未开启时输入禁用', async () => {
  const scope = makeScope(READY('normal', 5))
  const { renderer, tree } = setup(scope)

  assert.equal(inputByLabel(tree, '备用模型列表').props.disabled, true, '未开启 failover 时输入禁用')
  inputByLabel(tree, '主模型失败时切换备用模型').props.onChange({ target: { checked: true } })
  let next = renderer.render()
  assert.equal(inputByLabel(next, '备用模型列表').props.disabled, false, '开启后可编辑')
  inputByLabel(next, '备用模型列表').props.onChange({ target: { value: 'p2/m2, p3/m3' } })
  next = renderer.render()

  await saveButton(next).props.onClick()
  const by = Object.fromEntries(scope.mutateCalls[0].ops.map((op) => [op.path[0], op.value]))
  assert.equal(by.failover, true)
  assert.equal(by.fallbacks, 'p2/m2, p3/m3')
  renderer.unmount()
})

test('宿主拒绝（返回 false）时提示「没保存成功，请重试」', async () => {
  const scope = makeScope(READY('normal', 2), { mutateResult: false })
  const { renderer, tree } = setup(scope)

  radioButtons(tree)[2].props.onClick()
  const dirtyTree = renderer.render()
  await saveButton(dirtyTree).props.onClick()
  const after = renderer.render()

  assert.ok(textOf(after).includes('没保存成功，请重试'))
  assert.equal(saveButton(after).props.disabled, false, '失败后草稿还在，可以再试')
  assert.equal(scope.mutateCalls.length, 1)
  renderer.unmount()
})

test('写入抛异常时同样提示「没保存成功，请重试」', async () => {
  const scope = makeScope(READY('normal', 4), { mutateThrows: true })
  const { renderer, tree } = setup(scope)

  radioButtons(tree)[3].props.onClick()
  const dirtyTree = renderer.render()
  await saveButton(dirtyTree).props.onClick()
  const after = renderer.render()

  assert.ok(textOf(after).includes('没保存成功，请重试'))
  assert.ok(textOf(after).includes('保存'), '异常后按钮恢复为「保存」')
  renderer.unmount()
})

test('provider 应用失败时提示「已保存，但应用失败，请重试」并保留重试机会', async () => {
  const scope = makeScope(READY('normal', 1))
  const { renderer, tree } = setup(scope, { applyResult: false })

  radioButtons(tree)[1].props.onClick()
  await saveButton(renderer.render()).props.onClick()
  const after = renderer.render()

  assert.ok(textOf(after).includes('已保存，但应用失败，请重试'))
  assert.equal(scope.mutateCalls.length, 1, '档位本身先保存成功')
  assert.equal(saveButton(after).props.disabled, false, '还能再点保存重试')
  renderer.unmount()
})

test('只读：status 不是 ready 时显示只读提示，选项与保存都禁用', () => {
  const scope = makeScope({ status: 'unavailable', value: undefined, revision: undefined })
  const { renderer, tree } = setup(scope)
  const text = textOf(tree)

  assert.ok(text.includes('当前连接不能修改设置（只读模式）'))
  const options = radioButtons(tree)
  assert.equal(options.length, 4)
  for (const button of options) assert.equal(button.props.disabled, true, '只读时选项禁用')
  assert.equal(saveButton(tree).props.disabled, true, '只读时保存禁用')
  assert.ok(!text.includes('没保存成功，请重试'))
  renderer.unmount()
})

test('订阅：宿主推送新快照后卡片跟着刷新', () => {
  const scope = makeScope(READY('normal', 1))
  const { renderer, tree } = setup(scope)

  assert.equal(radioButtons(tree)[0].props['aria-checked'], true)
  assert.equal(scope.listenerCount(), 1, '挂载时应订阅 scope')

  scope.push(READY('off', 2))
  const next = renderer.render()

  assert.equal(radioButtons(next)[3].props['aria-checked'], true, '新快照选中「关闭」')
  assert.equal(radioButtons(next)[0].props['aria-checked'], false)
  assert.equal(saveButton(next).props.disabled, true)
  renderer.unmount()
  assert.equal(scope.listenerCount(), 0, '卸载时应退订')
})

test('源码体检：无禁用字符串、无 JSX、无全局样式、只依赖 react', () => {
  const forbidden = ['settingsScope', '@deepseek-ai/dsh-client-runtime']
  for (const word of forbidden) {
    assert.ok(!SOURCE.includes(word), `源码不应出现「${word}」`)
  }
  assert.ok(!/<[A-Za-z/]/.test(SOURCE), '源码不应出现 JSX 标签')
  assert.ok(!SOURCE.includes('<style'), '不应注入全局样式表')
  assert.ok(!SOURCE.includes('document.head'), '不应直接操作 document.head')

  // 面向用户的卡片文案里不能出现术语（代码标识符里出现是允许的）。
  const { tree } = setup(makeScope(READY('normal', 1)))
  const cardText = textOf(tree)
  for (const word of ['RATE_LIMIT', 'TPM', 'retryPolicy', 'provider']) {
    assert.ok(!cardText.includes(word), `卡片文案不应出现「${word}」`)
  }

  const requires = Array.from(SOURCE.matchAll(/require\(\s*'([^']+)'\s*\)/g), (match) => match[1])
  assert.deepEqual(requires, ['react'], '只允许 require("react")')

  assert.ok(SOURCE.includes('window.__ModuleLoader__.load'), '保留模块壳')
  assert.ok(SOURCE.includes("const inject = ['slots', 'configForms']"), '保留硬依赖声明')
  assert.ok(SOURCE.includes('exports.apply = apply'), '导出 apply')
  assert.ok(SOURCE.includes('exports.inject = inject'), '导出 inject')
  assert.ok(SOURCE.includes('return module.exports'), 'factory 返回 module.exports')
})
