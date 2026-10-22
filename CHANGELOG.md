# 0.3.0 — 2026-10-22

- 新增五档接管（off / report / stage / review / auto，默认 review），取代原先只能报告的行为。
- 判定门槛参数化：`-ConfirmRuns` 3 / `-MinHours` 24 / `-RequireNpmGone` true（原硬编码 2 次 / 12 小时）。
- takeover.ps1 事务化：版本化 vendor 目录（`<version>-<digest8>`）、内容哈希校验、临时目录 + 原子移动、回滚清单（含 lockfile 原本是否存在）、pnpm fast-path 清理、三道验收门禁与失败自动回滚。
- 面板新增「接管」列与「确认接管」按钮；新增 `POST /api/plugin-guard/takeover`（同源 + `allowActions` + 非法包名/profile 校验）。
- 新增滚动 24 小时累计上限 `-TakeoverMaxTotal` 5 与连续失败熔断 `-TakeoverFailureBreaker` 3，`-ResetCircuit` 复位。
- 新增 `-NoLock`：guard 已持共享锁时嵌套调用 takeover 不再自锁。
- `run-guard.cmd` 改传 `-TakeoverMode`（默认 review，可用 `DSH_GUARD_TAKEOVER_MODE` 覆盖），移除无效果的 `-NoTakeover`。
- 报告新增 `thresholds`、`takeover`（mode/预算/熔断/ledger）与每条 repo 的 `lastTakeover`。
- 计划任务改指随包 `backend/run-guard.cmd`；profile patch 显式 `allowActions: true`。
- `tests/` 同步到 0.3.0 语义（模式互斥、Apply/Revert 事务、`extraArgs` 白名单、N3 门槛），新增 `tests/run-all.mjs` 与 `npm test`。
- `docs/compatibility.md` 更新档位与门槛描述。

# 0.2.1-safety.2 — 2026-10-22

- N1：默认进度与 -JsonOnly 分离，避免 JSON 挤占面板输出。
- N2：面板 enableSnapshots 与 runner 环境变量显式启用快照，保持安全默认。
- N3：保留严格连续失效语义，新增独立上游缺失人工复核证据。
- N4/N5：恢复子进程级执行策略参数和有源码依据的版本门禁说明。
- N6：显式 stopping 状态、有限管道清理、禁止旧任务未退出时重开。
- N7/N8：保存旧接管历史，旧快照逐版本标记未验证，不破坏旧数据。
- N9/N10：独立扫描去重并行，记录测试绝对路径契约。
- 完整部署及现有计划任务修复不在本次已完成范围。

# 0.2.1-safety.1 — 2026-10-22

- 修正探测错配、超时/npm 分类、恢复与连续计数。
- 后端随包、统一根路径、共享锁、原子写入、真正只读 DryRun。
- 默认只读面板，移除危险自动改依赖；Apply/Force 失败关闭，保留校验源码暂存。
- 快照按 profile/版本/内容哈希隔离；不修改 vendor 或包管理器锁。
- 修复参数重复、extraArgs 注入与进程停止竞态；纠正文案。
- 本版仅交付修复副本，未部署。

# Changelog

## 0.2.0

- 新增 `Config` schema（12 个可配置项：guardDir / defaultMode / probeTimeoutSec / runTimeoutMs /
  reportLimit / tailLimit / repoLimit / allowActions / pollIntervalMs / runningPollIntervalMs /
  guardProfiles / extraArgs），全部可从 profile 的 `cordis.patch.yml` 覆盖。
- schema 采用软导入：解析不到 `@deepseek-ai/schemastery` 时退化为内置默认值，插件不会因此整体加载失败。
- 面板顶部显示当前生效配置；轮询间隔、默认扫描模式、探测超时均由配置驱动。
- 新增「停止」按钮与 20 分钟硬超时（可配），Windows 下整树 kill，避免扫描卡死无法中断。
- `/run` 支持 body `{ mode, probeTimeoutSec }`；`allowActions: false` 时接口返回 403、面板按钮置灰。
- 非 Windows 平台显式返回 `unsupported-platform`，不再静默失败。
- 补齐发布元数据：repository / homepage / bugs / keywords / engines / dsh.compatibility / LICENSE。

## 0.1.0

- 首个可用版本：设置页「上游守护」分区，4 张统计卡、仓库健康矩阵、仓库明细表、运行输出、
  历史报告展开、本地快照清单。
- host 侧 4 条同源路由：`/api/plugin-guard/state`、`/run`、`/stop`、`/report`，写操作校验同源请求头。
