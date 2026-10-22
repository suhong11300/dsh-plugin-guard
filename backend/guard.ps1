#Requires -Version 7.0
# Guard with configurable takeover tiers. report/stage/review never rewrite a profile;
# auto may rewrite one, bounded by per-run budget, a rolling 24h budget and a failure breaker.
param(
  [ValidateSet("daily","login","manual")][string]$Mode = "manual",
  [ValidateSet("all","desktop","web")][string]$Profiles = "all",
  [switch]$DryRun,
  [switch]$NoTakeover,
  [switch]$NoSnapshot,
  # 确认上游死亡的门槛：连续 ConfirmRuns 次探测 dead，且距首次 dead 已过 MinHours 小时。
  # 报告可以宽，接管必须严：默认 3 次 / 24 小时，比首版的 2 次 / 12 小时更难触发。
  [ValidateRange(1, 50)][int]$ConfirmRuns = 3,
  [ValidateRange(0, 8760)][int]$MinHours = 24,
  # true = 还要求 npm registry 也无兜底包才判 dead；false = 只凭仓库 404 就判 dead。
  # 用字符串而非 [bool]：`powershell -File guard.ps1 -RequireNpmGone false` 无法把字符串绑到布尔参数。
  [ValidateSet('true', 'false')][string]$RequireNpmGone = 'true',
  # 确认死亡之后做什么（五档）：off=完全不动 / report=只报告 / stage=复制到 staging 待审 /
  # review=复制并产 pending 记录，改 profile 需人工确认 / auto=直接改 profile（受 MaxPerRun 限流）
  [ValidateSet('off', 'report', 'stage', 'review', 'auto')][string]$TakeoverMode = 'review',
  # 允许接管的 profile：all，或逗号分隔的 desktop/web
  [string]$TakeoverAllowProfiles = 'all',
  # 单次扫描最多真正改写几个 profile；只有 auto 档消耗预算
  [ValidateRange(0, 20)][int]$TakeoverMaxPerRun = 1,
  # 滚动 24 小时内 auto 档累计最多改写几个 profile；0 = 不限制（不推荐）
  [ValidateRange(0, 200)][int]$TakeoverMaxTotal = 5,
  # auto 档连续失败多少次后熔断，降级为仅报告；需要 -ResetCircuit 才恢复
  [ValidateRange(1, 50)][int]$TakeoverFailureBreaker = 3,
  # 手动清除熔断标记（不会回滚已经接管的依赖）
  [switch]$ResetCircuit,
  # 每个包保留多少份历史 vendor 副本
  [ValidateRange(1, 20)][int]$KeepVersions = 3,
  # 单请求超时；总耗时还取决于批次数及串行复核，不等于单次超时。
  [ValidateRange(1, 60)][int]$ProbeTimeout = 8,
  [string]$DshHome = "",
  [string]$GuardDir = "",
  [switch]$Snapshot,
  [switch]$JsonOnly
)

. (Join-Path $PSScriptRoot "common.ps1")
$requireGone = ($RequireNpmGone -ne 'false')
$script:DryLogging = [bool]$DryRun

# 调 takeover.ps1 执行一步。调用方已持有共享锁，所以子进程用 -NoLock。
# 子进程输出单行 JSON（-JsonOnly）；任何非 JSON 行都收进 raw 以便排错。
function Invoke-TakeoverStep([string]$pkg, [string]$profile, [string]$repo, [string]$step, [int]$TimeoutSec = 600) {
  $toScript = Join-Path $PSScriptRoot 'takeover.ps1'
  if (-not (Test-Path -LiteralPath $toScript)) { return @{ ok = $false; error = 'takeover.ps1 not found next to guard.ps1' } }
  $pwshExe = $null
  try { $pwshExe = (Get-Process -Id $PID).Path } catch { $pwshExe = $null }
  if (-not $pwshExe) { $pwshExe = 'pwsh' }
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $toScript,
    '-Package', $pkg, '-Profile', $profile, '-Repo', $repo,
    '-Reason', ('upstream confirmed dead: ' + $repo),
    '-JsonOnly', '-NoLock', '-KeepVersions', [string]$KeepVersions,
    '-DshHome', [string]$script:DshHome, '-GuardDir', [string]$script:GuardRoot)
  if ($step -eq 'apply') { $argList += '-Apply' } else { $argList += '-Stage' }
  $outText = ''
  $errText = ''
  $proc = $null
  try {
    $psi = [Diagnostics.ProcessStartInfo]::new([string]$pwshExe)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    foreach ($x in $argList) { $psi.ArgumentList.Add([string]$x) }
    $proc = [Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $so = $proc.StandardOutput.ReadToEndAsync()
    $se = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
      try { $proc.Kill($true) } catch { }
      $proc.WaitForExit()
      return @{ ok = $false; error = ('takeover timed out after ' + $TimeoutSec + 's') }
    }
    $outText = $so.GetAwaiter().GetResult()
    $errText = $se.GetAwaiter().GetResult()
  } catch {
    return @{ ok = $false; error = ('failed to run takeover: ' + $_.Exception.Message) }
  } finally { if ($proc) { $proc.Dispose() } }
  # takeover.ps1 输出的是美化过的多行 JSON，必须整段解析；逐行只能命中单行对象。
  $json = $null
  $trimmed = $outText.Trim()
  $startIdx = $trimmed.IndexOf('{')
  $endIdx = $trimmed.LastIndexOf('}')
  if ($startIdx -ge 0 -and $endIdx -gt $startIdx) {
    try { $json = $trimmed.Substring($startIdx, $endIdx - $startIdx + 1) | ConvertFrom-Json -AsHashtable } catch { $json = $null }
  }
  if ($null -eq $json) {
    foreach ($line in ($outText -split "`r?`n")) {
      $s = [string]$line
      if ($s.TrimStart().StartsWith('{')) { try { $json = $s | ConvertFrom-Json -AsHashtable } catch { } }
    }
  }
  if ($null -eq $json) {
    $raw = (($outText + ' ' + $errText).Trim() -replace '\s+', ' ')
    if ($raw.Length -gt 400) { $raw = $raw.Substring(0, 400) + '...' }
    return @{ ok = $false; error = 'takeover produced no JSON'; raw = $raw }
  }
  return $json
}
$script:QuietLog = [bool]$JsonOnly
$lock = $null
try {
if (-not $DryRun) {
  [IO.Directory]::CreateDirectory($script:DshHome) | Out-Null
  try { $lock = [IO.File]::Open((Join-Path $script:DshHome '.plugin-guard.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
  catch { throw 'A guard/staging operation is already running or the shared lock cannot be acquired.' }
}

# keep logs from growing without bound (2 MB cap per file)
foreach ($lf in @($script:LogFile, (Join-Path $script:GuardRoot "log\guard-console.log"))) {
  if (-not $DryRun -and (Test-Path $lf) -and ((Get-Item $lf).Length -gt 2MB)) { Move-Item $lf ($lf + ".1") -Force }
}

$statePath = Join-Path $script:GuardRoot "state.json"
$reportDir = Join-Path $script:GuardRoot "reports"
$snapshotRoot = Join-Path $script:GuardRoot "snapshots"
foreach ($d in @($script:GuardRoot, $reportDir, $snapshotRoot)) { if (-not $DryRun -and -not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }

$state = $null
if (Test-Path $statePath) { try { $state = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable } catch { throw "Refusing to overwrite invalid state.json: $($_.Exception.Message)" } }
if (-not $state) { $state = @{ version = 1; lastRun = $null; repos = @{}; snapshots = @{} } }
if (-not $state.ContainsKey("repos")) { $state["repos"] = @{} }
if (-not $state.ContainsKey("snapshots")) { $state["snapshots"] = @{} }

$now = Get-Date
if ($Mode -eq "login" -and $state["lastRun"]) {
  try {
    $last = [datetime]::Parse([string]$state["lastRun"])
    if (($now - $last).TotalMinutes -lt 60) {
      Write-GuardLog "login check skipped: last run was $([int]($now - $last).TotalMinutes) min ago"
      exit 0
    }
  } catch {}
}

$profileList = if ($Profiles -eq "all") { @(Get-ChildItem (Join-Path $script:DshHome "profiles") -Directory | Select-Object -ExpandProperty Name) } else { @($Profiles) }
$rows = @(Get-PluginRows $profileList)

# group github-sourced dependencies by upstream repo
$byRepo = @{}
foreach ($r in $rows) {
  if ($r.Kind -ne "github" -or -not $r.Repo) { continue }
  if (-not $byRepo.ContainsKey($r.Repo)) { $byRepo[$r.Repo] = New-Object System.Collections.ArrayList }
  [void]$byRepo[$r.Repo].Add($r)
}

$actions = New-Object System.Collections.ArrayList
$summary = [ordered]@{ repos = 0; alive = 0; dead = 0; unknown = 0; pendingDead = 0; confirmedDead = 0; upstreamMissing = 0; snapshots = 0; failed = 0; takeovers = 0 }
$takeoverApplied = 0

# auto 档的安全阀：滚动 24h 累计上限 + 连续失败熔断。两个计数都落在 state.json 里，
# 跨多次扫描生效，否则单次 MaxPerRun 可以被反复触发绕过去。
$ledger = $state['takeoverLedger']
if ($ledger -isnot [hashtable]) { $ledger = @{} }
foreach ($lk in @('windowStart', 'appliedInWindow', 'consecutiveFailures', 'circuitOpenAt', 'lastFailureAt')) {
  if (-not $ledger.ContainsKey($lk)) { $ledger[$lk] = $null }
}
if ($null -eq $ledger['appliedInWindow']) { $ledger['appliedInWindow'] = 0 }
if ($null -eq $ledger['consecutiveFailures']) { $ledger['consecutiveFailures'] = 0 }
if ($ResetCircuit) {
  $ledger['circuitOpenAt'] = $null
  $ledger['consecutiveFailures'] = 0
  Write-GuardLog 'takeover failure breaker reset by -ResetCircuit'
}
if ($null -ne $ledger['windowStart']) {
  $expired = $false
  try { $expired = (($now - [datetime]::Parse([string]$ledger['windowStart'])).TotalHours -ge 24) } catch { $expired = $true }
  if ($expired) { $ledger['windowStart'] = $null; $ledger['appliedInWindow'] = 0 }
}
if (-not $ledger['windowStart']) { $ledger['windowStart'] = $now.ToString('o') }
$state['takeoverLedger'] = $ledger
$circuitOpen = ($null -ne $ledger['circuitOpenAt'])

# 并发预取：GitHub 首页 + npm 状态各一批。判定逻辑不变，只是把串行 curl 换成并行。
$repoKeys = @($byRepo.Keys | Sort-Object)
$webProbe = @{}
$codMainProbe = @{}
$codMasterProbe = @{}
$npmProbe = @{}
if ($repoKeys.Count -gt 0) {
  # codeload 在本机比 github.com 快且稳，三批并发预取后主循环只做纯内存判定。
  $codMainCodes = @(P-Many @($repoKeys | ForEach-Object { "https://codeload.github.com/$_/tar.gz/refs/heads/main" }) $ProbeTimeout 10)
  for ($i = 0; $i -lt $repoKeys.Count; $i++) {
    $codMainProbe[$repoKeys[$i]] = if ($i -lt $codMainCodes.Count) { [string]$codMainCodes[$i] } else { "000" }
  }
  # master 只在 main 没命中时才补查，省掉绝大多数请求。
  $needMaster = @($repoKeys | Where-Object { $codMainProbe[$_] -ne "200" })
  if ($needMaster.Count -gt 0) {
    $codMasterCodes = @(P-Many @($needMaster | ForEach-Object { "https://codeload.github.com/$_/tar.gz/refs/heads/master" }) $ProbeTimeout 10)
    for ($i = 0; $i -lt $needMaster.Count; $i++) {
      $codMasterProbe[$needMaster[$i]] = if ($i -lt $codMasterCodes.Count) { [string]$codMasterCodes[$i] } else { "000" }
    }
  }
  $webCodes = @(P-Many @($repoKeys | ForEach-Object { "https://github.com/$_" }) ([math]::Min($ProbeTimeout, 4)) 10)
  for ($i = 0; $i -lt $repoKeys.Count; $i++) {
    $webProbe[$repoKeys[$i]] = if ($i -lt $webCodes.Count) { [string]$webCodes[$i] } else { "000" }
  }
}
$npmPkgs = @($rows | Where-Object { $_.Kind -eq "github" } | Select-Object -ExpandProperty Package -Unique)
if ($npmPkgs.Count -gt 0) {
  Write-GuardLog ("probing " + $repoKeys.Count + " repos + " + $npmPkgs.Count + " npm packages in parallel (timeout=" + $ProbeTimeout + "s)")
  $npmCodes = @(P-Many @($npmPkgs | ForEach-Object { Get-NpmUrl $_ }) $ProbeTimeout 8)
  for ($i = 0; $i -lt $npmPkgs.Count; $i++) {
    $npmProbe[$npmPkgs[$i]] = if ($i -lt $npmCodes.Count) { [string]$npmCodes[$i] } else { "000" }
  }
}

foreach ($repo in $repoKeys) {
  $group = $byRepo[$repo]
  $summary.repos++
  $probe = Resolve-FromCodes ([string]$webProbe[$repo]) ([string]$codMainProbe[$repo]) ([string]$codMasterProbe[$repo])
  # 非 alive 结果串行复核；这不证明此前 404 的原因是限速。
  if ($probe.Live -ne $true) {
    Write-GuardLog ("recheck " + $repo + " serially (prefetch said web=" + $probe.Web + ", codeload=" + $probe.Codeload + ")")
    $probe = Test-RepoAlive $repo $ProbeTimeout
  }

  $npmByPkg = @{}
  foreach ($r in $group) { if (-not $npmByPkg.ContainsKey($r.Package)) { $npmByPkg[$r.Package] = [string]$npmProbe[$r.Package] } }
  $npmAll = ($npmByPkg.Values | Where-Object { $_ -eq "200" }).Count
$npmMissing = @($npmByPkg.Values | Where-Object { $_ -eq '404' }).Count -eq $npmByPkg.Count -and $npmByPkg.Count -gt 0
  $npmNote = if ($npmAll -gt 0) { 'npm-ok' } elseif ($npmMissing) { 'no-npm-fallback' } else { 'unknown' }

  if (-not $state["repos"].ContainsKey($repo)) {
    $state["repos"][$repo] = @{ firstSeen = $now.ToString("o"); consecutiveDead = 0; deadSince = $null; confirmedAt = $null; packages = @(); profiles = @() }
  }
  $entry = $state["repos"][$repo]
  $entry["lastProbe"] = $now.ToString("o")
  $entry["web"] = $probe.Web
  $entry["codeload"] = $probe.Codeload
  $entry["npm"] = $npmNote
  $entry["packages"] = @($group | Select-Object -ExpandProperty Package -Unique)
  $entry["profiles"] = @($group | Select-Object -ExpandProperty Profile -Unique)

  # Keep repository availability separate from package fallback confidence.
  # npm uncertainty does not erase real repository-404 observations.
  if($entry.ContainsKey('takeover')){
    if($entry['takeover']){$entry['legacyTakeover']=$entry['takeover']}
    [void]$entry.Remove('takeover')
  }
  $entry['upstreamStatus']=if($probe.Live -eq $true){'alive'}elseif($probe.Live -eq $false){'missing'}else{'unknown'}
  if($probe.Live -eq $false){
    $summary.upstreamMissing++
    $entry['upstreamConsecutiveMissing']=[int]$entry['upstreamConsecutiveMissing']+1
    if(-not $entry['upstreamMissingSince']){$entry['upstreamMissingSince']=$now.ToString('o')}
    $elapsed=($now-[DateTimeOffset]::Parse([string]$entry['upstreamMissingSince']).LocalDateTime).TotalHours
    if($entry['upstreamConsecutiveMissing'] -ge $ConfirmRuns -and $elapsed -ge $MinHours){$entry['upstreamReviewAt']=$now.ToString('o')}
    [void]$actions.Add(@{type='upstream-unavailable';repo=$repo;npm=$npmNote;reviewAt=$entry['upstreamReviewAt'];reason='Repository endpoints return 404; fallback evidence is separate. No automatic takeover.'})
  }else{
    $entry['upstreamConsecutiveMissing']=0
    $entry['upstreamMissingSince']=$null
    $entry['upstreamReviewAt']=$null
  }

  if ($probe.Live -eq $true) {
    $entry["status"] = "alive"
    $entry["consecutiveDead"] = 0
    $entry["deadSince"] = $null
    $entry['confirmedAt'] = $null
    $summary.alive++
  } elseif ($probe.Live -eq $false -and ($npmMissing -or -not $requireGone)) {
    $entry["status"] = "dead"
    $entry["consecutiveDead"] = [int]$entry["consecutiveDead"] + 1
    if (-not $entry["deadSince"]) { $entry["deadSince"] = $now.ToString("o") }
    $summary.dead++
  } else {
    $entry['status'] = 'unknown'
    $entry['consecutiveDead'] = 0
    $entry['deadSince'] = $null
    $entry['confirmedAt'] = $null
    $summary.unknown++
  }
  Write-GuardLog ("[" + $summary.repos + "/" + $repoKeys.Count + "] " + $repo + " -> " + $entry["status"] + " (web=" + $entry["web"] + ", codeload=" + $entry["codeload"] + ", npm=" + $entry["npm"] + ")")

  $hoursDead = 0
  if ($entry["deadSince"]) { try { $hoursDead = ($now - [DateTimeOffset]::Parse([string]$entry['deadSince']).LocalDateTime).TotalHours } catch { $hoursDead = 0 } }

  if ($entry["status"] -eq "dead" -and [int]$entry["consecutiveDead"] -ge $ConfirmRuns -and $hoursDead -ge $MinHours -and -not $entry["confirmedAt"]) {
    $entry["confirmedAt"] = $now.ToString("o")
    Write-GuardLog ("upstream CONFIRMED dead: " + $repo + " (probes=" + $entry["consecutiveDead"] + ", deadFor=" + [int]$hoursDead + "h)") "WARN"
    [void]$actions.Add([pscustomobject]@{ type = "confirmed-dead"; repo = $repo; hours = [int]$hoursDead })
  }

  if ($entry["confirmedAt"]) { $summary.confirmedDead++ } elseif ($entry["status"] -eq "dead") { $summary.pendingDead++ }

  # 确认死亡之后的动作由 TakeoverMode 决定。默认 review：只复制到 staging 并产出
  # 待确认记录，绝不擅自改 profile；auto 才写 profile，且受 TakeoverMaxPerRun 限流。
  if ($entry['status'] -eq 'dead' -and $entry['confirmedAt']) {
    $tmode = $TakeoverMode
    $allowList = @($TakeoverAllowProfiles -split ',' | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
    $allowAll = ($allowList -contains 'all')
    if ($tmode -eq 'off') {
      [void]$actions.Add(@{ type = 'takeover-skipped'; repo = $repo; mode = 'off'; reason = 'Upstream confirmed dead, but takeover is disabled by configuration.' })
    } elseif ($tmode -eq 'report') {
      [void]$actions.Add(@{ type = 'review-required'; repo = $repo; mode = 'report'; reason = 'Repeated missing upstream; verify the exact pinned artifact before any manual recovery.' })
    } elseif ($DryRun) {
      [void]$actions.Add(@{ type = 'takeover-planned'; repo = $repo; mode = $tmode; reason = 'DryRun: no vendor copy and no profile write were performed.' })
    } else {
      $stepMode = if ($tmode -eq 'auto') { 'apply' } else { 'stage' }
      foreach ($tr in $group) {
        $tp = [string]$tr.Profile
        if (-not $allowAll -and -not ($allowList -contains $tp.ToLowerInvariant())) {
          [void]$actions.Add(@{ type = 'takeover-skipped'; repo = $repo; package = $tr.Package; profile = $tp; mode = $tmode; reason = 'Profile is not in TakeoverAllowProfiles.' })
          continue
        }
        if (-not $tr.Installed -or $tr.Installed -eq '?') {
          [void]$actions.Add(@{ type = 'takeover-skipped'; repo = $repo; package = $tr.Package; profile = $tp; mode = $tmode; reason = 'Package is not installed in this profile.' })
          continue
        }
        if ($stepMode -eq 'apply' -and $circuitOpen) {
          [void]$actions.Add(@{ type = 'takeover-blocked'; repo = $repo; package = $tr.Package; profile = $tp; mode = $tmode; reason = ('Failure breaker opened at ' + [string]$ledger['circuitOpenAt'] + ' after ' + [string]$ledger['consecutiveFailures'] + ' consecutive failures; run guard.ps1 -ResetCircuit to re-enable auto takeover.') })
          continue
        }
        if ($stepMode -eq 'apply' -and $TakeoverMaxTotal -gt 0 -and [int]$ledger['appliedInWindow'] -ge $TakeoverMaxTotal) {
          [void]$actions.Add(@{ type = 'takeover-deferred'; repo = $repo; package = $tr.Package; profile = $tp; mode = $tmode; reason = ('Rolling 24h budget exhausted (TakeoverMaxTotal=' + $TakeoverMaxTotal + ', applied=' + [int]$ledger['appliedInWindow'] + ').') })
          continue
        }
        if ($stepMode -eq 'apply' -and $takeoverApplied -ge $TakeoverMaxPerRun) {
          [void]$actions.Add(@{ type = 'takeover-deferred'; repo = $repo; package = $tr.Package; profile = $tp; mode = $tmode; reason = ('Per-run budget exhausted (TakeoverMaxPerRun=' + $TakeoverMaxPerRun + ').') })
          continue
        }
        Write-GuardLog ('takeover ' + $stepMode + ' ' + $tr.Package + ' (' + $tp + ') because ' + $repo + ' is confirmed dead')
        $res = Invoke-TakeoverStep ([string]$tr.Package) $tp $repo $stepMode
        $okFlag = ($res['ok'] -eq $true)
        if ($okFlag -and $stepMode -eq 'apply') {
          $takeoverApplied++
          $ledger['appliedInWindow'] = [int]$ledger['appliedInWindow'] + 1
          $ledger['consecutiveFailures'] = 0
        }
        if (-not $okFlag -and $stepMode -eq 'apply') {
          $ledger['lastFailureAt'] = $now.ToString('o')
          $failures = [int]$ledger['consecutiveFailures'] + 1
          $ledger['consecutiveFailures'] = $failures
          if ($failures -ge $TakeoverFailureBreaker -and $null -eq $ledger['circuitOpenAt']) {
            $ledger['circuitOpenAt'] = $now.ToString('o')
            $circuitOpen = $true
            Write-GuardLog ('takeover failure breaker opened after ' + $failures + ' consecutive failures')
          }
        }
        $entry['lastTakeover'] = @{
          at = $now.ToString('o'); mode = $tmode; step = $stepMode; package = [string]$tr.Package; profile = $tp
          ok = $okFlag; staged = $res['staged']; vendor = $res['vendor']; rolledBack = $res['rolledBack']
          pendingConfirm = ($okFlag -and $stepMode -eq 'stage'); error = $res['error']; raw = $res['raw']
        }
        if ($okFlag) {
          $summary.takeovers++
          [void]$actions.Add(@{ type = 'takeover-done'; repo = $repo; package = [string]$tr.Package; profile = $tp; mode = $tmode; step = $stepMode; staged = $res['staged']; vendor = $res['vendor']; pendingConfirm = ($stepMode -eq 'stage') })
        } else {
          $summary.failed++
          [void]$actions.Add(@{ type = 'takeover-failed'; repo = $repo; package = [string]$tr.Package; profile = $tp; mode = $tmode; step = $stepMode; error = $res['error']; raw = $res['raw'] })
        }
      }
    }
  }
  # Snapshots are opt-in, content-addressed, profile-separated and validated.
  if ($Snapshot -and -not $NoSnapshot -and -not $DryRun -and $probe.Live -eq $true) {
    foreach ($r in $group) {
      if($npmByPkg[$r.Package] -ne '404' -or -not $r.Installed -or $r.Installed -eq '?'){continue}
      try {
        $saved=Save-GuardSnapshot $r $snapshotRoot
        $state['snapshots'][$saved.key]=$saved
        $summary.snapshots++
        [void]$actions.Add(@{type='source-snapshot';key=$saved.key;dir=$saved.dir;dependencyClosure=$false})
      }catch{
        $summary.failed++
        [void]$actions.Add(@{type='snapshot-failed';package=$r.Package;error=$_.Exception.Message})
      }
    }
  }
}

$state["lastRun"] = $now.ToString("o")
$state["lastMode"] = $Mode
if (-not $DryRun) { Write-AtomicJson $statePath $state }

$report = [ordered]@{
  generatedAt = $now.ToString("o")
  mode = $Mode
  profiles = $profileList
  dryRun = [bool]$DryRun
  summary = $summary
  thresholds = [ordered]@{ confirmRuns = $ConfirmRuns; minHours = $MinHours; requireNpmGone = [bool]$requireGone }
  takeover = [ordered]@{
    mode = $TakeoverMode; allowProfiles = $TakeoverAllowProfiles
    maxPerRun = $TakeoverMaxPerRun; maxTotal24h = $TakeoverMaxTotal; failureBreaker = $TakeoverFailureBreaker
    keepVersions = $KeepVersions; appliedThisRun = $takeoverApplied; doneThisRun = $summary.takeovers
    circuitOpen = [bool]$circuitOpen; ledger = $ledger
  }
  policy = ("tier=" + $TakeoverMode + "; snapshots opt-in; only auto rewrites a profile, bounded by per-run/24h budgets and a failure breaker")
  probes = @($script:ProbeLedger)
  inventory = @($rows | Select-Object Profile,Package,Kind,Installed,Spec)
  actions = $actions
  repos = @($byRepo.Keys | Sort-Object | ForEach-Object {
    $e = $state["repos"][$_]
    [ordered]@{ repo = $_; status = $e["status"]; consecutiveDead = $e["consecutiveDead"]; deadSince = $e["deadSince"]; confirmedAt = $e["confirmedAt"]; npm = $e["npm"]; packages = $e["packages"]; upstreamStatus = $e['upstreamStatus']; upstreamConsecutiveMissing = $e['upstreamConsecutiveMissing']; upstreamReviewAt = $e['upstreamReviewAt']; legacyTakeover = $e['legacyTakeover']; lastTakeover = $e['lastTakeover'] }
  })
}
$reportPath = Join-Path $reportDir ("guard-" + $now.ToString("yyyyMMdd-HHmmss-fffffff") + ".json")
if (-not $DryRun) { Write-AtomicJson $reportPath $report }

if ($JsonOnly) {
  Write-Output ($report | ConvertTo-Json -Depth 30 -Compress)
} else {
  Write-Output ("guard summary [" + $Mode + "] repos=" + $summary.repos + " alive=" + $summary.alive + " dead=" + $summary.dead + " unknown=" + $summary.unknown + " upstreamMissing=" + $summary.upstreamMissing + " confirmed=" + $summary.confirmedDead + " snapshots=" + $summary.snapshots + " failed=" + $summary.failed)
  if (-not $DryRun) { Write-Output ("report: " + $reportPath) }
  if ($actions.Count -gt 0) { $actions | Format-Table -AutoSize | Out-String -Width 200 }
}
if ($summary.failed -gt 0) { exit 1 }
exit 0
} finally { if ($lock) { $lock.Dispose() } }
