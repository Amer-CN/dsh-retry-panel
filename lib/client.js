/**
 * dsh-auto-retry —— 浏览器半侧：设置里的一张「断线自动重试」卡片。
 *
 * 模块形态照设置卡先例（lazy-CJS factory）：
 *   window.__ModuleLoader__.load({ id, factory }) → module.exports
 * 宿主组合条目 id `auto-retry` 既是 Cordis 条目 id，也是客户端设置表单的 entryId。
 *
 * 数据通道只有一个：`ctx.configForms.get('auto-retry')` 取本条目表单，三件套
 * `getSnapshot()` / `subscribe()` / `mutate(ops, revision)`。读写字段也只有
 * `patience` 一个，四档取值与宿主侧一致：normal / long / always / off。
 * 真正的重试由宿主自带的重试机制执行，本卡片只负责把「耐心程度」写进设置，
 * 所以不需要碰对话循环，也不发任何额外请求。
 *
 * `slots` 与 `configForms` 是模块级硬依赖：服务名写错不会抛错，而是客户端条目
 * 永久 pending（网页端只显示一行 did not activate）。卡片自己的降级态另由
 * `snapshot.status !== 'ready'` 分支给出：一行只读提示 + 禁用保存。
 *
 * 样式全部内联，颜色取 DSH 主题变量，不往 document 里塞全局样式表。
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-retry',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement

    /**
     * 宿主的组合条目 id（cordis.patch.yml 里 `- id: auto-retry`），
     * 同时就是客户端设置表单的 entryId。
     */
    const NS = 'auto-retry'

    const CARD_TITLE = '断线自动重试'
    const CARD_NAV_LABEL = '断线重试'
    const CARD_INTRO = '模型限流或网络断开时，DSH 会自动重试，不用你手动发“继续”。'
    const SAVED_TEXT = '已保存，立即生效'
    const FAILED_TEXT = '没保存成功，请重试'
    const APPLY_FAILED_TEXT = '已保存，但应用失败，请重试'
    const READONLY_TEXT = '当前连接不能修改设置（只读模式）'
    const TIP_TEXT = '改完不用重启。'

    /** 四档耐心程度：顺序即卡片里的顺序，id 与宿主侧配置的取值一一对应。 */
    const OPTIONS = [
      { id: 'normal', title: '普通', desc: '最多等 5 分钟，日常断流够用' },
      { id: 'long', title: '长任务', desc: '最多等 35 分钟，出门前选这个' },
      { id: 'always', title: '死磕', desc: '一直等到成功，整晚挂机选这个' },
      { id: 'off', title: '关闭', desc: '不自动重试，断了你自己重发' },
    ]

    const DEFAULT_PATIENCE = 'normal'
    const PATIENCE_IDS = OPTIONS.map((option) => option.id)

    /**
     * 保存档位之后，让 Host 把档位应用到 `llm-pi-ai` 的每个 provider。
     * 走专用路由而不是 settings 事件：Host 在 settings 的 HMR 事务里再写
     * 另一个条目会撞 "HMR transactions cannot be nested"，而路由处理函数
     * 是全新的 HTTP 请求任务，不在那个事务上下文里。
     */
    async function applyViaRoute() {
      try {
        const response = await fetch('/api/auto-retry/apply', {
          method: 'POST',
          credentials: 'same-origin',
        })
        if (!response.ok) return false
        const body = await response.json()
        return body !== null && typeof body === 'object' && body.ok === true
      } catch {
        return false
      }
    }

    /** DSH 主题变量：边框 / 卡片底色 / 三级文字；状态色只用于保存反馈。 */
    const COLOR = {
      border: 'var(--dsw-alias-border-l2)',
      cardBg: 'var(--dsw-alias-bg-layer-3)',
      optionBg: 'var(--dsw-alias-bg-layer-2)',
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      buttonFill: 'var(--dsw-alias-button-info-fill)',
      buttonText: 'var(--dsw-alias-label-primary-foreground)',
    }

    /** 读当前档位：只认四个合法值，别的一律按「普通」算。 */
    function readPatience(value) {
      const raw = value !== null && typeof value === 'object' ? value.patience : undefined
      return PATIENCE_IDS.includes(raw) ? raw : DEFAULT_PATIENCE
    }

    /** 数字字段在草稿里保持字符串，便于编辑中途为空；保存时再 clamp。 */
    function numText(value, fallback) {
      const number = Number(value)
      return Number.isFinite(number) ? String(Math.round(number)) : String(fallback)
    }

    /** 整数 clamp：非有限数回默认，越界夹到边界。 */
    function clampNumber(value, min, max, fallback) {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(max, Math.max(min, Math.round(number)))
    }

    /** 空草稿 = 插件默认值。 */
    function emptyDraft() {
      return {
        patience: DEFAULT_PATIENCE,
        autoContinue: true,
        continueDelaySec: '5',
        maxConsecutive: '5',
        continueText: '继续',
        failover: false,
        fallbacks: '',
        continueOnMaxTokens: true,
        idleWatchdog: false,
        idleTimeoutSec: '180',
      }
    }

    /** 快照值 → 草稿；缺项/非法值都回默认。 */
    function draftFromValue(value) {
      const v = value !== null && typeof value === 'object' ? value : {}
      return {
        patience: PATIENCE_IDS.includes(v.patience) ? v.patience : DEFAULT_PATIENCE,
        autoContinue: v.autoContinue !== false,
        continueDelaySec: numText(v.continueDelaySec, 5),
        maxConsecutive: numText(v.maxConsecutive, 5),
        continueText:
          typeof v.continueText === 'string' && v.continueText.trim() !== '' ? v.continueText : '继续',
        failover: v.failover === true,
        fallbacks: typeof v.fallbacks === 'string' ? v.fallbacks : '',
        continueOnMaxTokens: v.continueOnMaxTokens !== false,
        idleWatchdog: v.idleWatchdog === true,
        idleTimeoutSec: numText(v.idleTimeoutSec, 180),
      }
    }

    /** 归一化后再比较，避免 "5" 与 5 被当成改动。 */
    function sameDraft(left, right) {
      return (
        left.patience === right.patience &&
        left.autoContinue === right.autoContinue &&
        left.continueOnMaxTokens === right.continueOnMaxTokens &&
        left.idleWatchdog === right.idleWatchdog &&
        left.continueText.trim() === right.continueText.trim() &&
        left.failover === right.failover &&
        left.fallbacks.trim() === right.fallbacks.trim() &&
        Number(left.continueDelaySec) === Number(right.continueDelaySec) &&
        Number(left.maxConsecutive) === Number(right.maxConsecutive) &&
        Number(left.idleTimeoutSec) === Number(right.idleTimeoutSec)
      )
    }

    /** 草稿 → settings.mutate 的 8 条 ops。 */
    function opsFromDraft(draft) {
      return [
        { op: 'set', path: ['patience'], value: draft.patience },
        { op: 'set', path: ['autoContinue'], value: draft.autoContinue === true },
        {
          op: 'set',
          path: ['continueDelaySec'],
          value: clampNumber(draft.continueDelaySec, 0, 600, 5),
        },
        {
          op: 'set',
          path: ['maxConsecutive'],
          value: clampNumber(draft.maxConsecutive, 1, 50, 5),
        },
        { op: 'set', path: ['continueText'], value: draft.continueText.trim() === '' ? '继续' : draft.continueText.trim() },
        { op: 'set', path: ['failover'], value: draft.failover === true },
        { op: 'set', path: ['fallbacks'], value: draft.fallbacks.trim() },
        { op: 'set', path: ['continueOnMaxTokens'], value: draft.continueOnMaxTokens === true },
        { op: 'set', path: ['idleWatchdog'], value: draft.idleWatchdog === true },
        {
          op: 'set',
          path: ['idleTimeoutSec'],
          value: clampNumber(draft.idleTimeoutSec, 30, 600, 180),
        },
      ]
    }

    /** 安全取快照：宿主要么没服务这个条目，要么快照还没到，两种情况都按只读走。 */
    function snapshotOf(scope) {
      if (scope === null || scope === undefined) return null
      if (typeof scope.getSnapshot !== 'function') return null
      const snapshot = scope.getSnapshot()
      return snapshot === undefined ? null : snapshot
    }

    /** 单选圆点。纯装饰，语义由外层按钮的 role / aria-checked 承担。 */
    function radioDot(selected) {
      return h(
        'span',
        {
          'aria-hidden': true,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
            width: 14,
            height: 14,
            marginTop: 2,
            boxSizing: 'border-box',
            borderRadius: '50%',
            border: '1px solid ' + (selected ? COLOR.primary : COLOR.border),
          },
        },
        selected
          ? h('span', {
              style: {
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: COLOR.primary,
              },
            })
          : null,
      )
    }

    /** 选项按钮：选中时边框变主文字色，底色加深一点。 */
    function optionStyle(selected, disabled) {
      return {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        width: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        padding: '9px 11px',
        textAlign: 'left',
        font: 'inherit',
        fontFamily: 'inherit',
        color: COLOR.primary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        borderRadius: 10,
        border: '1px solid ' + (selected ? COLOR.primary : COLOR.border),
        background: selected ? COLOR.optionBg : 'transparent',
        transition: 'border-color 120ms ease, background-color 120ms ease',
      }
    }

    /** 保存按钮：可点时是主按钮，不可点时退回透明描边。 */
    function saveStyle(disabled) {
      return {
        flex: '0 0 auto',
        boxSizing: 'border-box',
        padding: '5px 16px',
        font: 'inherit',
        fontFamily: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
        borderRadius: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? COLOR.tertiary : COLOR.buttonText,
        border: '1px solid ' + (disabled ? COLOR.border : COLOR.buttonFill),
        background: disabled ? 'transparent' : COLOR.buttonFill,
        transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease',
      }
    }

    /**
     * 卡片本体。
     *
     * 点选项只改本地草稿（`draft`），不写设置；点「保存」才把
     * `{ op: 'set', path: ['patience'], value: 选中档位 }` 交给宿主。
     * 默认值 `normal`：第一次装插件、快照还没到时也是它。
     */
    function AutoRetryCard(props) {
      const source = props === null || props === undefined ? {} : props
      const scope = source.scope === undefined ? null : source.scope

      const [snapshot, setSnapshot] = react.useState(() => snapshotOf(scope))
      const [draft, setDraft] = react.useState(() => draftFromValue(snapshot === null ? null : snapshot.value))
      const [saved, setSaved] = react.useState(() => draftFromValue(snapshot === null ? null : snapshot.value))
      const [saving, setSaving] = react.useState(false)
      const [notice, setNotice] = react.useState(null)

      // 订阅宿主的表单快照：别处改设置、外部编辑配置文件都会推新快照过来。
      react.useEffect(() => {
        if (scope === null) return undefined
        setSnapshot(snapshotOf(scope))
        if (typeof scope.subscribe !== 'function') return undefined
        return scope.subscribe(() => setSnapshot(snapshotOf(scope)))
      }, [scope])

      // 快照一到就刷新基准值。用户没动过时草稿跟着走；动过了就保留草稿。
      react.useEffect(() => {
        if (snapshot === null) return
        const next = draftFromValue(snapshot.value)
        setSaved(next)
        setDraft((previous) => (sameDraft(previous, saved) ? next : previous))
      }, [snapshot])

      const readOnly = snapshot === null || snapshot.status !== 'ready'
      const dirty = !sameDraft(draft, saved)

      const save = async () => {
        if (scope === null || readOnly || saving || !dirty) return
        setSaving(true)
        setNotice(null)
        try {
          // 先保存本插件配置，再调 Host 路由应用到 provider（两步是两次独立写入，
          // 不会落进 settings 的 HMR 事务里）。
          const accepted = await scope.mutate(opsFromDraft(draft), snapshot === null ? undefined : snapshot.revision)
          if (accepted !== true) {
            setNotice({ kind: 'error', text: FAILED_TEXT })
            return
          }
          const applied =
            typeof source.applyPreset === 'function' ? await source.applyPreset(draft.patience) : false
          if (applied !== true) {
            // 配置已保存，只差 provider 应用；保持 dirty，用户可以再点一次保存重试。
            setNotice({ kind: 'error', text: APPLY_FAILED_TEXT })
            return
          }
          const normalized = draftFromValue({
            ...draft,
            continueDelaySec: clampNumber(draft.continueDelaySec, 0, 600, 5),
            maxConsecutive: clampNumber(draft.maxConsecutive, 1, 50, 5),
            idleTimeoutSec: clampNumber(draft.idleTimeoutSec, 30, 600, 180),
          })
          setSaved(normalized)
          setDraft(normalized)
          setNotice({ kind: 'ok', text: SAVED_TEXT })
        } catch {
          setNotice({ kind: 'error', text: FAILED_TEXT })
        } finally {
          setSaving(false)
        }
      }

      const pick = (id) => {
        if (readOnly || saving || id === draft.patience) return
        setDraft((previous) => ({ ...previous, patience: id }))
        setNotice(null)
      }

      const update = (patch) => {
        if (readOnly || saving) return
        setDraft((previous) => ({ ...previous, ...patch }))
        setNotice(null)
      }

      const optionButtons = OPTIONS.map((option) =>
        h(
          'button',
          {
            key: option.id,
            type: 'button',
            role: 'radio',
            'aria-checked': draft.patience === option.id,
            disabled: readOnly || saving,
            onClick: () => pick(option.id),
            style: optionStyle(draft.patience === option.id, readOnly || saving),
          },
          radioDot(draft.patience === option.id),
          h(
            'span',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            h(
              'span',
              { style: { fontSize: 13, fontWeight: 600, lineHeight: 1.5, color: COLOR.primary } },
              option.title,
            ),
            h('span', { style: { fontSize: 12, lineHeight: 1.5, color: COLOR.tertiary } }, option.desc),
          ),
        ),
      )

      let feedbackText = ''
      if (readOnly) feedbackText = READONLY_TEXT
      else if (notice !== null) feedbackText = notice.text
      else if (dirty) feedbackText = '有改动，还没保存'

      let feedbackColor = COLOR.tertiary
      if (notice !== null && notice.kind === 'ok') feedbackColor = COLOR.ok
      else if (notice !== null && notice.kind === 'error') feedbackColor = COLOR.bad

      const saveDisabled = readOnly || !dirty || saving
      const controlsDisabled = readOnly || saving
      const inputStyle = {
        width: 62,
        padding: '3px 6px',
        font: 'inherit',
        fontFamily: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        color: COLOR.primary,
        background: 'transparent',
        border: '1px solid ' + COLOR.border,
        borderRadius: 6,
        textAlign: 'center',
      }
      const rowStyle = { display: 'inline-flex', alignItems: 'center', gap: 8, cursor: readOnly ? 'default' : 'pointer' }
      const hintStyle = { fontSize: 12, lineHeight: 1.5, color: COLOR.tertiary, marginTop: -2 }

      const continueSection = h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            paddingTop: 12,
            borderTop: '1px solid ' + COLOR.border,
          },
        },
        h('div', { style: { fontSize: 13, fontWeight: 600, lineHeight: 1.5, color: COLOR.primary } }, '断线后自动继续'),
        h(
          'label',
          { style: rowStyle },
          h('input', {
            type: 'checkbox',
            'aria-label': '回合失败后自动发送继续',
            checked: draft.autoContinue,
            disabled: controlsDisabled,
            onChange: (event) => update({ autoContinue: event.target.checked }),
          }),
          h('span', { style: { fontSize: 13, color: COLOR.primary } }, '回合失败后自动发送「继续」'),
        ),
        h('div', { style: hintStyle }, '重试用尽后自动开新回合，不用手动发“继续”。'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' } },
          h(
            'label',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLOR.secondary } },
            '等待',
            h('input', {
              type: 'text',
              inputMode: 'numeric',
              'aria-label': '自动继续等待秒数',
              value: draft.continueDelaySec,
              disabled: controlsDisabled,
              onChange: (event) => update({ continueDelaySec: event.target.value }),
              style: inputStyle,
            }),
            '秒后再发',
          ),
          h(
            'label',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLOR.secondary } },
            '最多连续',
            h('input', {
              type: 'text',
              inputMode: 'numeric',
              'aria-label': '最多连续自动继续次数',
              value: draft.maxConsecutive,
              disabled: controlsDisabled,
              onChange: (event) => update({ maxConsecutive: event.target.value }),
              style: inputStyle,
            }),
            '次',
          ),
        ),
        h(
          'label',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLOR.secondary } },
          '继续时发送',
          h('input', {
            type: 'text',
            'aria-label': '继续时发送的文本',
            value: draft.continueText,
            disabled: controlsDisabled,
            onChange: (event) => update({ continueText: event.target.value }),
            style: { ...inputStyle, width: 200, textAlign: 'left' },
          }),
        ),
        h(
          'div',
          { style: hintStyle },
          '可留空用默认「继续」；支持 {code} / {kind} / {attempt} / {tool}。连续失败会逐步加长等待（最长 10 分钟）。',
        ),
        h(
          'label',
          { style: rowStyle },
          h('input', {
            type: 'checkbox',
            'aria-label': '主模型失败时切换备用模型',
            checked: draft.failover,
            disabled: controlsDisabled,
            onChange: (event) => update({ failover: event.target.checked }),
          }),
          h('span', { style: { fontSize: 13, color: COLOR.primary } }, '主模型失败时切换备用模型'),
        ),
        h('div', { style: hintStyle }, '按顺序尝试下面的备用模型；留空则只继续、不换模型。'),
        h(
          'label',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLOR.secondary } },
          '备用模型',
          h('input', {
            type: 'text',
            'aria-label': '备用模型列表',
            value: draft.fallbacks,
            disabled: controlsDisabled || !draft.failover,
            placeholder: '例如 deepseek/deepseek-v4.1-flash，逗号分隔',
            onChange: (event) => update({ fallbacks: event.target.value }),
            style: { ...inputStyle, width: 300, textAlign: 'left' },
          }),
        ),
        h('div', { style: hintStyle }, '格式：服务商/模型名，逗号或换行分隔。'),
        h(
          'label',
          { style: rowStyle },
          h('input', {
            type: 'checkbox',
            'aria-label': '输出被截断时也继续',
            checked: draft.continueOnMaxTokens,
            disabled: controlsDisabled,
            onChange: (event) => update({ continueOnMaxTokens: event.target.checked }),
          }),
          h('span', { style: { fontSize: 13, color: COLOR.primary } }, '输出被截断时也继续'),
        ),
        h('div', { style: hintStyle }, '被 max-tokens 截断时接着写。'),
        h(
          'label',
          { style: rowStyle },
          h('input', {
            type: 'checkbox',
            'aria-label': '卡住时自动重来',
            checked: draft.idleWatchdog,
            disabled: controlsDisabled,
            onChange: (event) => update({ idleWatchdog: event.target.checked }),
          }),
          h('span', { style: { fontSize: 13, color: COLOR.primary } }, '卡住不动时自动重来'),
        ),
        h(
          'div',
          { style: { ...hintStyle, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          '超过',
          h('input', {
            type: 'text',
            inputMode: 'numeric',
            'aria-label': '卡住判定秒数',
            value: draft.idleTimeoutSec,
            disabled: controlsDisabled || !draft.idleWatchdog,
            onChange: (event) => update({ idleTimeoutSec: event.target.value }),
            style: { ...inputStyle, opacity: draft.idleWatchdog ? 1 : 0.5 },
          }),
          '秒没有任何动静，就取消当前请求并自动继续。',
        ),
        h('div', { style: hintStyle }, '你手动发消息或点停止后，自动继续会立刻让位。'),
      )

      const footer = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 12,
              flexWrap: 'wrap',
            },
          },
          feedbackText === ''
            ? null
            : h(
                'span',
                { style: { marginRight: 'auto', fontSize: 12, lineHeight: 1.5, color: feedbackColor } },
                feedbackText,
              ),
          h(
            'button',
            { type: 'button', disabled: saveDisabled, onClick: () => save(), style: saveStyle(saveDisabled) },
            saving ? '保存中…' : '保存',
          ),
        ),
        h('div', { style: { fontSize: 11, lineHeight: 1.5, color: COLOR.tertiary } }, TIP_TEXT),
      )

      return h(
        'div',
        {
          'data-dsh-auto-retry': 'card',
          style: {
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            minWidth: 0,
            padding: '14px 16px 12px',
            borderRadius: 12,
            border: '1px solid ' + COLOR.border,
            background: COLOR.cardBg,
            color: COLOR.primary,
          },
        },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h(
            'h3',
            { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: COLOR.primary } },
            CARD_TITLE,
          ),
          h('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.6, color: COLOR.secondary } }, CARD_INTRO),
        ),
        h(
          'div',
          {
            role: 'radiogroup',
            'aria-label': CARD_TITLE,
            style: {
              display: 'grid',
              gap: 8,
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            },
          },
          optionButtons,
        ),
        continueSection,
        footer,
      )
    }

    /**
     * 客户端条目的硬依赖。名字必须是新版服务键，写错一个客户端条目就会永久
     * pending（网页端只显示一行 did not activate），所以这里不做动态取值。
     */
    const inject = ['slots', 'configForms']

    /**
     * 只在宿主确实服务 auto-retry 条目时才挂设置卡：
     * `whileServed` 等条目出现在设置镜像里才跑注册，条目消失时自动撤掉；
     * 外层 `ctx.effect` 拿回 disposer，插件卸载时不留残影。
     */
    function apply(ctx) {
      const scope = ctx.configForms.get(NS)

      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: NS,
                  order: 78,
                  label: CARD_NAV_LABEL,
                  inject: () => ({
                    scope,
                    asSection: true,
                    applyPreset: () => applyViaRoute(),
                  }),
                },
                AutoRetryCard,
              ),
            ),
          ),
        'auto-retry: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
