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
      const [draft, setDraft] = react.useState(() => readPatience(snapshot === null ? null : snapshot.value))
      const [saved, setSaved] = react.useState(() => readPatience(snapshot === null ? null : snapshot.value))
      const [saving, setSaving] = react.useState(false)
      const [notice, setNotice] = react.useState(null)

      // 订阅宿主的表单快照：别处改设置、外部编辑配置文件都会推新快照过来。
      react.useEffect(() => {
        if (scope === null) return undefined
        setSnapshot(snapshotOf(scope))
        if (typeof scope.subscribe !== 'function') return undefined
        return scope.subscribe(() => setSnapshot(snapshotOf(scope)))
      }, [scope])

      // 快照一到就刷新基准值。用户没动过选择时草稿跟着走；动过了就保留草稿。
      react.useEffect(() => {
        if (snapshot === null) return
        const next = readPatience(snapshot.value)
        setSaved(next)
        setDraft((previous) => (previous === saved ? next : previous))
      }, [snapshot])

      const readOnly = snapshot === null || snapshot.status !== 'ready'
      const dirty = draft !== saved

      const save = async () => {
        if (scope === null || readOnly || saving || !dirty) return
        setSaving(true)
        setNotice(null)
        try {
          // 先保存本插件档位，再调 Host 路由应用到 provider（两步是两次独立写入，
          // 不会落进 settings 的 HMR 事务里）。
          const accepted = await scope.mutate(
            [{ op: 'set', path: ['patience'], value: draft }],
            snapshot === null ? undefined : snapshot.revision,
          )
          if (accepted !== true) {
            setNotice({ kind: 'error', text: FAILED_TEXT })
            return
          }
          const applied =
            typeof source.applyPreset === 'function' ? await source.applyPreset(draft) : false
          if (applied !== true) {
            // 档位已保存，只差 provider 应用；保持 dirty，用户可以再点一次保存重试。
            setNotice({ kind: 'error', text: APPLY_FAILED_TEXT })
            return
          }
          setSaved(draft)
          setNotice({ kind: 'ok', text: SAVED_TEXT })
        } catch {
          setNotice({ kind: 'error', text: FAILED_TEXT })
        } finally {
          setSaving(false)
        }
      }

      const pick = (id) => {
        if (readOnly || saving || id === draft) return
        setDraft(id)
        setNotice(null)
      }

      const optionButtons = OPTIONS.map((option) =>
        h(
          'button',
          {
            key: option.id,
            type: 'button',
            role: 'radio',
            'aria-checked': draft === option.id,
            disabled: readOnly || saving,
            onClick: () => pick(option.id),
            style: optionStyle(draft === option.id, readOnly || saving),
          },
          radioDot(draft === option.id),
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
