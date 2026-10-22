# DSH Plugin Guard 0.3.0

Windows / PowerShell 7 的**上游巡检 + 可配置接管**插件。面板、backend 与测试随包交付。

## 它做什么

1. 定期探测每个 git 源插件的上游是否还活着：`github.com/<o>/<r>`、`codeload.github.com/<o>/<r>/tar.gz`（main 再 master）与 `registry.npmjs.org/<pkg>` 三源交叉，避免未认证 API 的 60 次/小时配额。
2. 连续多次确认上游消失后，按**档位**决定动作：只报告、只暂存源码、暂存待确认、或直接本地化接管。
3. 接管 = 把已安装副本冻结进 `~/.dsh/vendor/<pkg>/<version>-<digest>`，把依赖改成 `link:`，跑 `pnpm install`，再用三道门禁验收（realpath 命中 vendor / name+version 匹配 / `dsh --dump-config` 通过）；任一失败自动回滚。
4. 可选源码快照，按包名 + profile + 版本 + 内容哈希隔离，逐文件校验。

## 五档

| 档 | 写 vendor | 改 profile 依赖 | 需要人工 |
|---|---|---|---|
| `off` | 否 | 否 | — |
| `report` | 否 | 否 | — |
| `stage` | 仅 staging | 否 | — |
| `review`（默认） | 是 | 是，面板点「确认接管」才执行 | 是 |
| `auto` | 是 | 是，自动 | 否 |

## 判定门槛（报告可以宽，接管必须严）

- `-ConfirmRuns` 默认 **3**：连续 3 次探测都判 dead。
- `-MinHours` 默认 **24**：距首次判 dead 已过 24 小时。
- `-RequireNpmGone` 默认 **true**：还要求 npm registry 也查不到同名包。

## auto 档安全阀

- `-TakeoverMaxPerRun` 默认 **1**：单次扫描最多真正改写几个 profile。
- `-TakeoverMaxTotal` 默认 **5**：滚动 24 小时累计上限，0 表示不限。计数落在 `state.json` 的 `takeoverLedger`，跨扫描生效。
- `-TakeoverFailureBreaker` 默认 **3**：连续失败 3 次熔断，降级为仅报告；需要 `-ResetCircuit` 复位，或人工改 state。
- `-KeepVersions` 默认 **3**：每个包保留几份历史 vendor 副本，从不删旧目录。

## 路径与功能

- `backend/common.ps1`：带 URL/索引的保序探测结果、错误记录、原子 JSON、内容校验快照。
- `backend/guard.ps1`：跨进程共享锁、状态机、档位分派与报告。
- `backend/takeover.ps1`：单包事务，`-Stage` / `-Apply` / `-Revert` 三模式。
- `backend/scan-upstream.ps1`：同一分类器的只读清单。
- `backend/run-guard.cmd`：找 PowerShell 7、调用随包脚本，档位可由 `DSH_GUARD_TAKEOVER_MODE` 覆盖（默认 review）。
- `lib/index.js` / `lib/client.js`：面板、HTTP 路由与进程生命周期。
- `tests/`：回归与安全测试。

数据根优先级：显式 `-DshHome` > `DSH_HOME` > `~/.dsh`。
报告根优先级：显式 `-GuardDir` > `DSH_GUARD_DIR` > `<DshHome>/plugin-guard`。
共享排他锁是 `<DshHome>/.plugin-guard.lock`；文件保持存在，靠操作系统句柄互斥。

## 手动使用（PowerShell 7）

    $PackageRoot = Join-Path $env:USERPROFILE '.dsh\vendor\dsh-plugin-guard'

    # 只读预演：不改 state，不写 report/log，不建快照
    & "$PackageRoot/backend/guard.ps1" -Profiles all -DryRun

    # review 档（默认）：确认死亡后只做 staging + pending 记录
    & "$PackageRoot/backend/guard.ps1" -Profiles all -NoSnapshot

    # 只暂存源码，绝不改 profile
    & "$PackageRoot/backend/guard.ps1" -Profiles all -TakeoverMode stage

    # auto：自动接管，受单次/24h 预算与熔断约束
    & "$PackageRoot/backend/guard.ps1" -Profiles all -TakeoverMode auto -TakeoverMaxPerRun 1 -TakeoverMaxTotal 5 -TakeoverFailureBreaker 3

    # 熔断复位
    & "$PackageRoot/backend/guard.ps1" -Profiles all -ResetCircuit -NoSnapshot

单个包的直接操作：

    & "$PackageRoot/backend/takeover.ps1" -Package <pkg> -Profile web -Stage
    & "$PackageRoot/backend/takeover.ps1" -Package <pkg> -Profile web -Apply
    & "$PackageRoot/backend/takeover.ps1" -Package <pkg> -Profile web -Revert

`-JsonOnly` 只输出一段 JSON（非 JSON 日志走 stderr），给 host 侧解析用。

## 安装

包内 `lib/` 是已提交的构建产物，没有 prepare 钩子，可以直接从 git 源安装：

    dsh plugin --profile web add github:<owner>/dsh-plugin-guard

如果计划任务需要稳定入口，改用固定目录 + `link:`（升级时替换目录内容即可，不需要重装依赖）：

    $PackageRoot = Join-Path $env:USERPROFILE '.dsh\vendor\dsh-plugin-guard'
    # profile 的 dependencies 写 "dsh-plugin-guard": "link:<该目录>"

无论哪种方式，都要在该 profile 的 `cordis.patch.yml` 里显式开面板操作（默认只读）：

    - id: plugin-guard
      config:
        allowActions: true

计划任务指向随包 runner：`<包目录>\backend\run-guard.cmd daily` / `login`；
`DSH_GUARD_TAKEOVER_MODE` 可覆盖档位（默认 `review`）。

## 测试

    $env:DSH_GUARD_PWSH = 'C:\path\to\pwsh.exe'   # 可选：默认按 PATH 与 Program Files 查找
    npm test

三套用例（`safety` / `regression` / `review-regression`）都在系统临时目录里建假 profile 运行，
不会读写真实 profile、state 或 reports。总入口是 `tests/run-all.mjs`，逐套汇总 pass/fail。

## 已知限制

- `link:` 安装时 Node 按 realpath 解析模块，vendor 目录内的包若 require 外部依赖，需要 `~/.dsh/vendor/node_modules` 是指向某个 profile 的 junction（否则 `@deepseek-ai/schemastery` 之类解析失败）。
- `dsh --profile X --dump-config` 只证明配置能组合，不证明运行时行为。
- 源码快照不含 `node_modules`，不是可离线安装的完整依赖闭包。
- desktop profile 由 Electron 独占，CLI 无法安装；需在该 profile 目录手工 `pnpm add` 并手写 `dsh.profile.bundles`。
- 面板的「确认接管」只对本机同源请求开放：需要 `x-plugin-guard: 1` 头、loopback 来源与 `allowActions: true`。
