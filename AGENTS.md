# dsh-auto-retry 项目说明

这是 **canonical 仓库**，也是桌面端 DSH 实际加载的插件目录。
以后维护、修复、升级请直接把这个文件夹作为项目打开，不要在
`F:\AIXM\PC-GL` 里开会话；PC-GL 只是早期临时工作区。

## 这是什么

DeepSeek Harness（DSH）插件：设置里的「断线重试」卡片。
请求级重试 + 回合级自动继续 + 同轮截断续写 + 压缩吞轮恢复 +
卡住检测 + 备用模型故障转移 / 推理强度下拉。

- 仓库：https://github.com/Amer-CN/dsh-retry-panel
- 当前版本：`0.6.0`
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

- Windows，DSH `0.2.1-rc.3`
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

## 已知限制 / 待办

- 冷会话扫描只覆盖最近 10 分钟、最多 5 个
- 路由健康表只在内存，重启清空；没有请求前预判绕行
- 没有弹窗/看板、按错误码自定义触发矩阵
- 备用模型目录依赖 `sessionController.modelCatalog()`，宿主不提供时退回手输
