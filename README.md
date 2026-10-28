# dsh-auto-retry

> DeepSeek Harness（DSH）插件：设置里一张 **「断线重试」** 卡片。
> 请求级自动重试 + **回合失败后自动发「继续」** + 卡住检测，不用再手敲「继续」。
>
> An auto-retry settings card for DeepSeek Harness: request-level retries plus a
> turn-level auto-continue (with circuit breaker and an optional idle watchdog),
> so transient `429` / stream failures do not end an unattended run.

![设置页：断线重试](assets/settings-card.png)

---

## 它解决什么问题

长任务跑到一半，模型服务返回：

```json
429: {"code":"capacity_exceeded","message":"model capacity exceeded: tpm_exceeded"}
```

DSH 自带的 `dsh-llm-retry` 默认只重试 **5 次、总共约 16 秒**（500ms → 10s 退避）。
而 `tpm_exceeded` 要等分钟级窗口恢复，16 秒根本不够；重试耗尽后整轮失败，你回来只看到
一句「本轮运行失败」，还得自己发「继续」。

更糟的是流挂起：没有任何报错，界面一直转圈，其实早就死了。

本插件把恢复做成两层，并在设置里给你一组傻瓜选项。

## 两层恢复

### 第 1 层：请求级重试（沿用 DSH 自带引擎）

不重复造轮子，只把「耐心」写进每个 provider 的 `retryPolicy`：

| 选项 | 行为 | 适合 |
|---|---|---|
| 普通 | 最多重试 10 次，约 5 分钟 | 日常断流 |
| 长任务 | 最多重试 40 次，约 35 分钟 | 出门前挂任务 |
| 死磕 | `mode: always`，一直重试到成功 | 整晚挂机 |
| 关闭 | `maxRetries: 0`，不自动重试 | 想自己控制 |

退避统一为 1s 起步、60s 封顶、±20% 抖动。

### 第 2 层：回合级自动继续（v0.2 新增）

当一轮彻底失败（重试耗尽、服务端错误、输出被截断），插件会：

- 等 N 秒（默认 5 秒）
- 以用户身份自动发送一条「继续」，开新回合、保留全部上下文
- 最多连续 N 次（默认 5 次），成功一轮就清零；到上限自动停，不会无限烧 token
- **你手动发消息或点停止 → 立刻让位**，不会跟你抢
- 只对主智能体生效；子智能体是一次性任务，不自动继续
- 自己发的「继续」会被识别成回显，不会误触发人工接管

### 第 3 层：卡住检测（默认关闭，v0.2 新增）

打开后，如果一轮运行中超过 N 秒（默认 180 秒）没有任何流输出或事件：

- 主动取消当前请求（标记为 hook 取消）
- 走上面的自动继续，接着原来的上下文跑

> 注意：超长工具调用 + 模型静默可能被误判；被取消后会马上自动继续，不会丢上下文。

## 设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| 重试耐心 | 普通 | 四档：普通 / 长任务 / 死磕 / 关闭 |
| 回合失败后自动发送「继续」 | 开 | 第二层总开关 |
| 等待秒数 | 5 | 0~600 秒 |
| 最多连续 | 5 | 1~50 次，成功一轮清零 |
| 输出被截断时也继续 | 开 | `max-tokens` 截断时接着写 |
| 卡住不动时自动重来 | 关 | 第三层总开关 |
| 卡住判定秒数 | 180 | 30~600 秒 |

保存后立即生效，无需重启。

## 安装

插件按 DSH 的 bundle 方式安装（**不要**手写裸 `- id:`，那只覆盖已有条目，会报 `entry not found` 且整条被跳过）。

```sh
cd ~/.dsh/profiles/desktop        # 或 web
pnpm add github:Amer-CN/dsh-retry-panel
```

然后在同一个 `package.json` 的 `dsh.profile.bundles` 数组里加入包名：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-auto-retry"
      ]
    }
  }
}
```

或者用 DSH 自带插件命令（若你的版本支持从 GitHub 安装）：

```sh
dsh plugin --profile desktop add github:Amer-CN/dsh-retry-panel
```

装完重启 / 重载 DSH。Web 端刷新页面，桌面端重新打开应用（或 F12 → Ctrl+R）。

## 它是怎么工作的

- **重试策略**：面板保存时先写本插件配置，再 `POST /api/auto-retry/apply`；Host 在独立 HTTP 任务里
  调用 `settings.mutate('llm-pi-ai', ops)`，给所有 provider 写入 `retryPolicy`。
  走独立路由是因为在 `settings/document-updated` 里再写另一个条目会撞
  `HMR transactions cannot be nested`。
- **自动继续**：监听 `session/event` 的 `turn/end`：
  - `error` → 排定继续
  - `max-tokens` → 开关打开时排定继续
  - `aborted` 且原因是 `hook`（看门狗自己取消）→ 开关打开时排定继续
  - 用户手动停止（`reason.kind === 'user'`）→ 永不自动继续
  到期后通过 agent 的 `followup()` 注入一条 `user` 消息，开新回合。
- **看门狗**：`agent/status`、`agent/assistant-stream` 和 `session/event` 都是活动信号；
  超时用 `agent.cancel({ kind: 'hook' })` 取消，再交给自动继续层。
- **熔断**：连续继续次数按会话记录，成功回合清零；人工输入会取消待发并暂停到下一次成功回合。

首次安装时，如果所有 provider 都还没有 `retryPolicy`，Host 会自动应用一次当前档位；
只要有一个 provider 已有自定义 `retryPolicy`，插件就**不会覆盖**，尊重手工配置。

## 兼容

- DSH `0.2.1-rc.3`（开发和实测版本）
- 需要 `settings` / `configEditor` 的 profile（desktop / web）；headless 下插件静默跳过
- 插件零外部运行时依赖（除 `@deepseek-ai/schemastery`）

## 边界

- 第 1 层只对「临时性」错误重试：`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`
- `AUTH`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED` 不会重试（重试也救不回来）
- 「死磕」档会一直重试，遇到永久性错误也会一直等，请自行停止
- 自动继续是「重开一轮」，不是「续写半个回答」；已提交的工具结果和上下文都保留

## 灵感与对比

设计时参考了社区同类插件的思路（回合级自动继续、熔断、看门狗、截断续写），实现是独立的，
并且刻意保持「设置里一张卡、默认值即推荐值」：

- [zxmqq1234/dsh-auto-retry](https://github.com/zxmqq1234/dsh-auto-retry) —— 倒计时横幅、数据看板、更细的触发条件
- [Frog755/dsh-client-auto-retry](https://github.com/Frog755/dsh-client-auto-retry) —— 纯客户端自动发「继续」
- [aqiu817/dsh-plugin-auto-retry](https://github.com/aqiu817/dsh-plugin-auto-retry) —— 接管失败并展示错误
- [dat-lequoc/dsh-auto-retry](https://github.com/dat-lequoc/dsh-auto-retry) —— 按错误文本匹配的重试策略
- [QGG4588/dsh-model-failover](https://github.com/QGG4588/dsh-model-failover) —— 限流时切换下一个模型

## 开发

```sh
npm install
npm test
```

- `lib/index.js`：Host 侧。Config（8 个 volatile 字段）、首次安装写入、`/api/auto-retry/apply` 路由、
  自动继续与看门狗状态机
- `lib/client.js`：浏览器侧。lazy-CJS 模块壳，注册 `settings.section`，渲染设置卡片
- `cordis.patch.yml`：bundle patch，只插入 `auto-retry` 一行
- `tests/`：不启动 DSH 的离线测试（服务端 20 项、客户端 10 项）

没有构建步骤；`lib/*.js` 就是发布产物。

## License

MIT
