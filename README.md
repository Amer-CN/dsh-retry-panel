# dsh-auto-retry

> DeepSeek Harness（DSH）插件：设置里多一张 **「断线重试」** 卡片。
> 模型限流（429）或网络断开时自动重试，不用再手动发「继续」。
>
> An auto-retry settings card for DeepSeek Harness: pick a patience preset, and
> transient `429` / stream failures are retried inside the same turn instead of
> ending it.

---

## 它解决什么问题

长任务跑到一半，模型服务返回：

```json
429: {"code":"capacity_exceeded","message":"model capacity exceeded: tpm_exceeded"}
```

DSH 自带的 `dsh-llm-retry` 默认只重试 **5 次、总共约 16 秒**（500ms → 10s 退避）。
而 `tpm_exceeded` 要等分钟级窗口恢复，16 秒根本不够，于是整轮失败。

本插件不改重试引擎，只把「等多久」做成一个傻瓜选项，写进每个 provider 的 `retryPolicy`：

| 选项 | 行为 | 适合 |
|---|---|---|
| 普通 | 最多重试 10 次，约 5 分钟 | 日常断流 |
| 长任务 | 最多重试 40 次，约 35 分钟 | 出门前挂任务 |
| 死磕 | `mode: always`，一直重试到成功 | 整晚挂机 |
| 关闭 | `maxRetries: 0`，不自动重试 | 想自己控制 |

退避统一为 1s 起步、60s 封顶、±20% 抖动。

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

## 使用

设置 → **断线重试** → 选一档 → 保存。保存后立即生效，无需重启。

- 只对「临时性」错误重试：`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`
- `AUTH`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED` 不会重试（重试也救不回来）
- 「死磕」档会一直重试，遇到永久性错误也会一直等，请自行停止

## 它到底改了什么

面板保存时：

1. 先把档位写进本插件自己的配置（`patience`）
2. 再 `POST /api/auto-retry/apply`
3. Host 在独立的 HTTP 任务里调用 `settings.mutate('llm-pi-ai', ops)`，给所有 provider 写入：

```yaml
retryPolicy:
  mode: normal        # 死磕档是 always
  maxRetries: 40      # 普通 10 / 长任务 40 / 关闭 0
  backoff:
    initialDelayMs: 1000
    maxDelayMs: 60000
    jitterRatio: 0.2
```

真正的重试由 DSH 自带的 `@deepseek-ai/dsh-llm-retry` 执行，本插件不重复实现重试。

首次安装时，如果所有 provider 都还没有 `retryPolicy`，Host 会自动应用一次当前档位；
只要有一个 provider 已有自定义 `retryPolicy`，插件就**不会覆盖**，尊重手工配置。

> 为什么走 `/api/auto-retry/apply` 而不是在 `settings/document-updated` 里直接写：
> 该事件发生在 settings 自己的 HMR 事务内部，再写另一个条目会报
> `HMR transactions cannot be nested`。独立 HTTP 任务不在那个事务上下文里。
> 路由是 `/api/...` 下的 exact 路由，代码里用 `connection.requestRejection(req)` 自己过认证栅栏。

## 兼容

- DSH `0.2.1-rc.3`（开发和实测版本）
- 需要 `settings` / `configEditor` 的 profile（desktop / web）；headless 下插件静默跳过
- 插件零外部运行时依赖（除 `@deepseek-ai/schemastery`）

## 开发

```sh
npm install
npm test
```

- `lib/index.js`：Host 侧。Config（`patience` 为 volatile 字段）、首次安装写入、`/api/auto-retry/apply` 路由
- `lib/client.js`：浏览器侧。lazy-CJS 模块壳，注册 `settings.section`，渲染四档卡片
- `cordis.patch.yml`：bundle patch，只插入 `auto-retry` 一行
- `tests/`：不启动 DSH 的离线测试（服务端 14 项、客户端 9 项）

没有构建步骤；`lib/*.js` 就是发布产物。

## License

MIT
