# dsh-auto-retry 项目说明

这是 **canonical 仓库**，也是桌面端 DSH 实际加载的插件目录。
以后维护、修复、升级请直接把这个文件夹作为项目打开，不要在
`F:\AIXM\PC-GL` 里开会话；PC-GL 只是早期临时工作区。

## 这是什么

DeepSeek Harness（DSH）插件：设置里的「断线重试」卡片。
请求级重试 + 回合级自动继续 + 同轮截断续写 + 压缩吞轮恢复 +
卡住检测 + 备用模型故障转移 / 推理强度下拉。

- 仓库：https://github.com/Amer-CN/dsh-retry-panel
- 当前版本：`0.6.1`
- License：MIT
- 无构建步骤：`lib/*.js` 就是发布产物

## 目录

```text
lib/index.js        Host 侧：Config、retryPolicy 写入、自动继续/看门狗/故障转移/冷扫描
lib/client.js       浏览器侧：设置卡片（lazy-CJS + 纯内联样式）
cordis.patch.yml    bundle patch，只插入 auto-retry 一行
tests/              离线测试（服务端 36 项 + 客户端 11 项）
assets/             README 截图
.work/              本地测试/调研产物，已 gitignore，不提交
```

## 环境

- Windows，DSH `0.2.1-rc.5`（桌面端走 nightly 通道，升级频繁；升级后按「DSH 升级复检」跑一遍）
- Node.js 24（本机 `D:\Program Files\nodejs\node.exe`）
- 测试依赖 `@deepseek-ai/schemastery`，通过 junction 指向 DSH 自带包：

```powershell
New-Item -ItemType Junction `
  -Path 'F:\AIXM\dsh-auto-retry\node_modules\@deepseek-ai\schemastery' `
  -Target 'C:\Users\Admin\.dsh\profiles\node_modules\@deepseek-ai\schemastery'
```

## 测试

```powershell
node tests/server.test.mjs
node tests/client.test.mjs
# 或
npm test
```

## 本地真机测试

测试 profile：`.work/home/profiles/devtest`，已 link 到本仓库。

```powershell
$env:DSH_HOME='F:\AIXM\dsh-auto-retry\.work\home'
$env:ELECTRON_RUN_AS_NODE='1'
$env:MOCK_API_KEY='test-key'
$exe='D:\Program Files (x86)\DeepSeek Harness\DeepSeek Harness.exe'
$bin='D:\Program Files (x86)\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
$argLine = '"' + $bin + '" --profile devtest --port 18784 --no-open'
Start-Process -FilePath $exe -ArgumentList $argLine
```

Mock LLM（另一个终端）：

```powershell
$env:MOCK_PORT='18777'; $env:MOCK_FAIL='2'; $env:MOCK_LOG='F:\AIXM\dsh-auto-retry\.work\lab\requests.log'
node .work\lab\mock-server.mjs
```

浏览器自动化脚本：`.work\lab\cdp-eval.cjs`（`CDP_PORT`、`DSH_PORT` 环境变量）。

## DSH 升级复检

桌面端是 nightly 通道，客户端更新频繁。每次 DSH 升级后按这套最小核查（约 10 分钟）：

1. `npm test`：服务端 36 + 客户端 11 必须全绿。
2. 用上面的 devtest 启动 rc.X，跑 `--dump-config`：确认 `- id: auto-retry` 条目、
   config 与 `permissions` 都在，退出码 0。
3. 打开启动日志里的 `?token=` 地址 → 设置 → 断线重试：卡片能渲染、改档能保存，
   保存后 `providers.*.retryPolicy` 写入设置文档。
4. mock `MOCK_FAIL=2` 发一条消息：应产生 3 个请求（2×429 + 200）、只显示一条回答。
5. 判据：以上通过即「无需适配」；任何一步失败，先 diff 上游
   `npm pack @deepseek-ai/dsh@<新版本>` 的 `lib/*.js`，重点看插件触及的契约点：
   `settings.describe/mutate/configure`、`settings/document-updated`、
   `slots` + `configForms`（卡片注册）、`agents` 事件与 `steer/followup`、
   `webServer.register`、`connection.requestRejection`、
   `sessionController.modelCatalog / .agents.selectForNextRequest`。

rc.3 → rc.5 的复检结论：上游改动是思考内容展示、对话标签提示、MCP 资源能力判断与
日志流修补；插件触及的全部契约点（涉及 24 个上游包；306 个包做了全量运行时哈希比对）
无一变化，**无需改代码**（2026-10-30，真机全项通过）。

## 桌面端安装关系

`C:\Users\Admin\.dsh\profiles\desktop` 里：

- `package.json` 的 `dsh.profile.bundles` 含 `dsh-auto-retry`
- 依赖是 `"dsh-auto-retry": "link:F:/AIXM/dsh-auto-retry"`
- 改完 `lib/*.js` 后桌面端会热重载；客户端界面按 `F12 → Ctrl+R` 重载

## 发布

1. 改 `package.json` 版本号
2. 跑两个测试
3. `git add -A && git commit`
4. `git tag -a vX.Y.Z -m vX.Y.Z && git push origin main vX.Y.Z`
5. `gh release create vX.Y.Z --title ... --notes ...`

## 硬约束

- **不要手写裸 `- id: auto-retry` 当新条目**：裸条目只覆盖已有条目，
  新条目必须通过 bundle patch 的 `- insert:` 或 profile bundles 安装。
- 不引入构建链；客户端只 `require('react')`，样式内联，不注入全局 CSS。
- 颜色用 `--dsw-alias-*` token；控件几何对齐官方（Switch 36×20、Input 32/8）。
- `.work/`、`node_modules/` 不提交。

## DSH STORE 契约

- 运行时依赖只有 `@deepseek-ai/schemastery@3.18.4`，已用根目录 `pnpm-lock.yaml` 固定
- Bundle Patch 声明 `permissions: { network: true, storage: false }`
- 网络只用于浏览器同源 `/api/auto-retry/apply` 与 `/api/auto-retry/catalog`
- 无生命周期脚本、无文件/凭据访问、无外部服务；详见 `README.md` 和 `SECURITY.md`
- 修改依赖/权限后跑测试、`--dump-config`，再推默认分支等自动复检

## 已知限制 / 待办

- 冷会话扫描只覆盖最近 10 分钟、最多 5 个
- 路由健康表只在内存，重启清空；没有请求前预判绕行
- 没有弹窗/看板、按错误码自定义触发矩阵
- 备用模型目录依赖 `sessionController.modelCatalog()`，宿主不提供时退回手输
- 下一版可顺手加固（rc.5 审计发现，均为历史遗留、非升级回归）：
  - 工具结果关联只看 `message.content` 里的 `tool-result` 分片，而宿主把
    `toolCallId` 放在消息层（`dsh-llm` 的 `createToolResultMessage`），
    幂等护栏在当前宿主上会退化为「视为已完成」
  - `session.eventAt()` 已被宿主标记 deprecated，建议迁移到 `snapshotEvents()`
  - `maybeFirstInstall()` 读 `describe()` 时宿主可能同步 emit
    `settings/document-updated`，建议先置 `firstInstallDone` 再读，避免重复首装写入
