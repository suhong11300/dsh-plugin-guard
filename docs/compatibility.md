# 兼容性与验证边界（0.3.0）

## DSH 版本门禁依据

本机 DSH 0.2.0-rc.2 的 @deepseek-ai/dsh-app-boot/lib/index.js 中 evaluatePluginCompatibility（286–313 行）已检查；源码节选与哈希保存在交付目录。以下只适用于该已检查实现，不推断所有未来版本：

1. 没有 peerDependencies 时此门禁返回无不匹配；这并不证明运行 API 兼容。
2. 只检查 @deepseek-ai/dsh 及 @deepseek-ai/dsh- 前缀 peerDependencies；其他 peer 不属于此版本门禁。
3. workspace:^、workspace:~、workspace:* 被换算为当前 runtimeVersion；其他范围用 semver.satisfies(runtimeVersion, requirement, { includePrerelease: true }) 判断。
4. 空范围或不满足范围会记录 peers。无效类型会抛错；不要为了通过门禁随意删除声明。
5. engines.dsh 不参与这个门禁函数；dsh.compatibility 是描述信息，不是这里的放行依据。Node engines/os 的安装约束仍需单独满足。
6. exemption 是 packageName@packageVersion 与 runtimeVersion 的精确记录，不等于 API 兼容证明。不要照搬旧版豁免给新包。

宿主契约仍为 webServer.register、ModuleLoader、settings.section；schemastery 软导入失败回退默认配置。必须区分导入、路由可用、界面操作、后端执行、真实插件功能五个层级。

## 当前与历史证据矩阵

| 项目 | 已观察/支持范围 | 未证明的部分 |
|---|---|---|
| Windows / PS7 / Node>=20 | 当前隔离测试使用 PS7.6.5、Node24.21.0 | 未遍历全部 PS7/Node20 小版本 |
| 原 0.2.0 + DSH 0.2.0-rc.2 | 前轮已记录旧版状态接口可用 | 不可转记成 safety.2 已安装验收 |
| safety.2 host/backend | 本地 HTTP、子进程、快照、配置及回归 fixture | 新版 DSH 实机安装、视觉、卸载未验 |
| Linux/macOS | 不支持；os 限 win32，使用 curl.exe/taskkill/cmd | 不声称跨平台 |
| 后端打包 | backend 随包，host 从包内调用 | 只改版本号的旧 vendor 会缺脚本 |
| 数据根 | guardDir/DSH_HOME 显式传给子进程 | 不能据此自动迁移计划任务入口 |
| IPv6/同源 | 回环 IPv6 URL 与请求保护纳入测试 | 非回环远程操作未开放 |
| 执行策略 | 子进程传 -ExecutionPolicy Bypass；不改持久策略 | 不能覆盖 MachinePolicy/UserPolicy；未制造真实 MOTW 安装场景 |
| 停止 | running=false、stopping=true；5 秒有限清理，活进程阻止重开 | 主进程退出不保证所有后代已消失 |
| 快照 | 显式配置可达；创建时逐文件校验，旧布局单独标记 | 不具备完整离线依赖闭包；面板轮询非完整重新验哈希 |
| 计划任务 | runner 参数已改善 | 原两条任务失败没有修复/重新触发 |
| 回滚 | 自包含脚本恢复交付副本原字节 | 不是生产 profile/package-manager 事务回滚 |

## 中国大陆判定与降级

GitHub/codeload/npm 超时、429、5xx、传输错误属于 unknown，不把网络不可达判作删除。HEAD 可以降低流量，不能保证所有 CDN 对 HEAD/GET 一致，也不能替代下载完整性和实际调用。

严格包失效 consecutiveDead 在未知时清零，保持“连续”含义；独立 upstreamConsecutiveMissing 只累计仓库端点明确 404，即使 npm 未知也产生 upstream-unavailable 提示，达到 `-ConfirmRuns`（默认 3）且距首次 missing 超过 `-MinHours`（默认 24）才设置 upstreamReviewAt。仓库恢复或证据未知会中断该仓库连续计数。这里只提示人工复核，不触发自动接管。

旧报告 npm 标记反转可能含并行结果身份错配，不能未经控制实验就当作新探测器网络不稳定的量化证据。同名 npm 包存在不等于可信同源/同版本可替代。

不自动设代理、换 registry、禁用 TLS，也不把“未配置显式代理”称为大陆裸直连：TUN/透明代理仍可能存在。正式验收需在用户真实网络下分别测试元数据、制品下载校验、安装加载与功能调用。

## 配置、数据与升级路径

- allowActions=false 默认只读；显式开启才可扫描。enableSnapshots=false 默认不生成快照；开启后仍受 -DryRun/-NoSnapshot 禁止项约束。
- runner 的 `DSH_GUARD_ENABLE_SNAPSHOTS=true` 为显式快照开关；`DSH_GUARD_TAKEOVER_MODE` 覆盖档位（默认 `review`）。只有 `auto` 档会自动改写 profile。
- 默认 stdout 为简短进度，-JsonOnly 为独立机器模式，避免挤掉面板 tail。
- takeover 历史保留为 legacyTakeover；新统计区分 upstreamMissing/legacyTakeovers。0.3.0 起 `-Stage`/`-Apply`/`-Revert` 是互斥的真实事务（同时给两个即 exit 64），自动化改写只由 `-TakeoverMode auto` 触发，并受单次/24 小时预算与失败熔断约束。
- 旧快照只读展示、逐版本标记未验证，不自动转换成新清单；新清单存在不等于轮询时重验通过。
- scan-upstream 使用去重并发批次；tests 以参数绝对根目录定位，不要求切换 cwd。
- 整包部署并统一计划任务与 vendor 后端入口是后续独立事务。本交付未改安装状态、现有调度、网络或持久执行策略。

MOTW 说明：本次本地 safety.1 tarball 仅观察到 :$DATA 流，没有 Zone.Identifier；不能由此断言所有来源都无 MOTW，也不能断言 registry 包必有 MOTW。
