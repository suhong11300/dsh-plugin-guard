#Requires -Version 7.0
# Transactional package takeover.
#
# Modes (at most one; default = stage):
#   -Stage   copy the installed package into a digest-addressed staging tree.
#            No profile file is touched.
#   -Apply   stage, materialize a VERSIONED vendor directory, rewrite the
#            profile dependency to link:<vendor>, run pnpm install, verify
#            three acceptance gates, roll back everything on failure.
#   -Revert  restore the newest backup for this package/profile and reinstall.
#            The vendor directory is never deleted.
#
# Invariants:
#   * Nothing is removed recursively; existing versions are never overwritten.
#   * Directories appear via Directory.Move only after a manifest comparison.
#   * Every profile write is preceded by a timestamped backup.
#   * The shared guard lock is honoured; -BreakLock is explicit and audited.
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^(@[a-zA-Z0-9._-]+/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$')][string]$Package,
  [Parameter(Mandatory=$true)][ValidateSet('desktop','web')][string]$Profile,
  [string]$Repo = '',
  [string]$Reason = 'manual takeover',
  [switch]$Stage,
  [switch]$Apply,
  [switch]$Revert,
  [switch]$JsonOnly,
  [switch]$SkipDumpConfig,
  [switch]$BreakLock,
  # caller (guard.ps1) already holds the shared lock; do not reopen it
  [switch]$NoLock,
  [ValidateRange(1,20)][int]$KeepVersions = 3,
  [string]$DshHome = '',
  [string]$GuardDir = ''
)

. (Join-Path $PSScriptRoot 'common.ps1')
$script:QuietLog = [bool]$JsonOnly

$modes = @()
if ($Stage)  { $modes += 'stage' }
if ($Apply)  { $modes += 'apply' }
if ($Revert) { $modes += 'revert' }
if ($modes.Count -gt 1) {
  @{ ok = $false; error = 'Choose at most one of -Stage, -Apply, -Revert.' } | ConvertTo-Json -Compress
  exit 64
}
$mode = if ($modes.Count -eq 1) { $modes[0] } else { 'stage' }

function Get-SafeName([string]$name) { return [uri]::EscapeDataString($name) }

function Get-ManifestDigest($files) {
  $s = ((@($files) | ForEach-Object { $_.path + ':' + $_.sha256 + ':' + $_.bytes }) -join '|')
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($s))).ToLower()
}

function Get-PackageRow {
  $rows = @(Get-PluginRows @($Profile) | Where-Object { $_.Package -eq $Package })
  if ($rows.Count -ne 1) { throw "Installed package not found in profile '$Profile': $Package" }
  return $rows[0]
}

# Returns a vendor directory whose content matches the staged payload.
# Prefers <version>, then <version>-<digest8>, then <version>-<digest8>-N.
# Never reuses a directory with different content and never deletes one.
function Resolve-VendorDir($row, $saved, [string]$vendorRoot) {
  $safe = Get-SafeName $row.Package
  $ver = ([string]$row.Installed) -replace '[^a-zA-Z0-9._-]', '_'
  if (-not $ver) { $ver = '0.0.0' }
  $base = Join-Path $vendorRoot $safe
  [IO.Directory]::CreateDirectory($base) | Out-Null
  $short = $saved.digest.Substring(0, 8)
  $candidates = @((Join-Path $base $ver), (Join-Path $base ($ver + '-' + $short)))
  for ($i = 2; $i -le 9; $i++) { $candidates += (Join-Path $base ($ver + '-' + $short + '-' + $i)) }
  $want = Get-ManifestDigest (Get-PayloadManifest $saved.dir)
  foreach ($c in $candidates) {
    if (-not (Test-Path -LiteralPath $c)) { return @{ dir = $c; exists = $false; reused = $false } }
    $got = $null
    try { $got = Get-ManifestDigest (Get-PayloadManifest $c) } catch { $got = $null }
    if ($got -eq $want) { return @{ dir = $c; exists = $true; reused = $true } }
  }
  throw "No safe vendor slot left for $($row.Package): nine candidates all hold unexpected content."
}

function Copy-VendorPayload($saved, [string]$target) {
  $files = @(Get-PayloadManifest $saved.dir)
  $parent = Split-Path $target -Parent
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $tmp = Join-Path $parent ('.staging-' + [guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($tmp) | Out-Null
  foreach ($f in $files) {
    $rel = ([string]$f.path).Replace('/', '\')
    $dst = Join-Path $tmp $rel
    [IO.Directory]::CreateDirectory((Split-Path $dst -Parent)) | Out-Null
    [IO.File]::Copy((Join-Path $saved.dir $rel), $dst, $false)
  }
  $got = Get-ManifestDigest (Get-PayloadManifest $tmp)
  if ($got -ne (Get-ManifestDigest $files)) { throw "Vendor copy verification failed; staging retained at $tmp" }
  [IO.Directory]::Move($tmp, $target)
}

function Backup-ProfileFiles([string]$pkgDir, [string]$tag) {
  $dest = Join-Path $script:GuardRoot ('backups\takeover\' + (Get-SafeName $Package) + '\' + $tag)
  [IO.Directory]::CreateDirectory($dest) | Out-Null
  $hadLock = Test-Path -LiteralPath (Join-Path $pkgDir 'pnpm-lock.yaml')
  $hadModules = Test-Path -LiteralPath (Join-Path $pkgDir 'node_modules')
  foreach ($n in @('package.json', 'pnpm-lock.yaml')) {
    $src = Join-Path $pkgDir $n
    if (Test-Path -LiteralPath $src) { [IO.File]::Copy($src, (Join-Path $dest $n), $true) }
  }
  Write-AtomicJson (Join-Path $dest '.backup-manifest.json') ([ordered]@{
    schema = 1; package = $Package; profile = $Profile
    hadLockfile = $hadLock; hadNodeModules = $hadModules; at = (Get-Date).ToString('o')
  })
  return $dest
}

# Restores the two profile files. A lockfile that did not exist before the
# takeover is removed again so the rollback is byte-identical, not partial.
function Restore-ProfileFiles([string]$backupDir, [string]$pkgDir) {
  $hadLock = $true
  $mf = Join-Path $backupDir '.backup-manifest.json'
  if (Test-Path -LiteralPath $mf) {
    try { $hadLock = [bool](([IO.File]::ReadAllText($mf) | ConvertFrom-Json).hadLockfile) } catch { $hadLock = $true }
  }
  foreach ($n in @('package.json', 'pnpm-lock.yaml')) {
    $src = Join-Path $backupDir $n
    if (Test-Path -LiteralPath $src) { [IO.File]::Copy($src, (Join-Path $pkgDir $n), $true) }
  }
  if (-not $hadLock) {
    $lock = Join-Path $pkgDir 'pnpm-lock.yaml'
    if (Test-Path -LiteralPath $lock) { [IO.File]::Delete($lock) }
  }
}
# Rewrites one dependency value in place, preserving every other byte.
function Set-DependencySpec([string]$pkgPath, [string]$name, [string]$spec) {
  $raw = [IO.File]::ReadAllText($pkgPath)
  $pat = [regex]::new('("' + [regex]::Escape($name) + '"\s*:\s*")[^"]*(")')
  if (-not $pat.IsMatch($raw)) { throw "Dependency '$name' not found in $pkgPath" }
  $script:newSpec = $spec
  $ev = [System.Text.RegularExpressions.MatchEvaluator] { param($m) $m.Groups[1].Value + $script:newSpec + $m.Groups[2].Value }
  $updated = $pat.Replace($raw, $ev)
  [IO.File]::WriteAllText($pkgPath, $updated, [Text.UTF8Encoding]::new($false))
  $check = [IO.File]::ReadAllText($pkgPath) | ConvertFrom-Json
  if ([string]$check.dependencies.$name -ne $spec) { throw 'Dependency rewrite verification failed' }
}

function Get-PnpmExe {
  $cands = @()
  $c = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if ($c) { $cands += $c.Source }
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'pnpm\bin\pnpm.cmd') }
  $cands += (Join-Path $env:USERPROFILE 'AppData\Local\pnpm\bin\pnpm.cmd')
  foreach ($x in $cands) { if ($x -and (Test-Path -LiteralPath $x)) { return $x } }
  return $null
}

# pnpm treats node_modules/.pnpm/lock.yaml as its own fast-path state. When a
# dependency spec is rewritten, that file makes install report 'Already up to
# date' and silently keep the old link, so it is cleared before any rewrite.
function Clear-PnpmFastPath([string]$pkgDir) {
  $v = Join-Path $pkgDir 'node_modules\.pnpm\lock.yaml'
  if (Test-Path -LiteralPath $v) { [IO.File]::Delete($v) }
}

function Invoke-PnpmInstall([string]$pkgDir, [int]$timeoutSec = 600, [switch]$Force) {
  $pnpm = Get-PnpmExe
  if (-not $pnpm) { throw 'pnpm executable not found' }
  $psi = [Diagnostics.ProcessStartInfo]::new($pnpm)
  $psi.WorkingDirectory = $pkgDir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  foreach ($a in @('install', '--prefer-offline')) { $psi.ArgumentList.Add($a) }
  if ($Force) { $psi.ArgumentList.Add('--force') }
  $proc = [Diagnostics.Process]::new()
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $so = $proc.StandardOutput.ReadToEndAsync()
  $se = $proc.StandardError.ReadToEndAsync()
  if (-not $proc.WaitForExit($timeoutSec * 1000)) {
    try { $proc.Kill($true) } catch { }
    throw "pnpm install timed out after ${timeoutSec}s"
  }
  $out = $so.GetAwaiter().GetResult()
  $err = $se.GetAwaiter().GetResult()
  if ($proc.ExitCode -ne 0) {
    $msg = ([string]$err + ' ' + [string]$out).Trim()
    if ($msg.Length -gt 600) { $msg = $msg.Substring(0, 600) }
    throw ('pnpm install failed (exit ' + $proc.ExitCode + '): ' + $msg)
  }
  return @{ exit = $proc.ExitCode; tail = ([string]$out + [string]$err).Trim() }
}

# Gate 1+2: node_modules entry is a link that resolves to the vendor dir,
# and the vendor package.json carries the expected name/version.
function Test-Acceptance([string]$target, $row) {
  $pkgDir = Join-Path $script:DshHome ('profiles\' + $Profile)
  $nm = Join-Path $pkgDir ('node_modules\' + $Package)
  if (-not (Test-Path -LiteralPath $nm)) { return @{ ok = $false; why = 'node_modules entry missing after install' } }
  $item = Get-Item -LiteralPath $nm -Force
  $real = $null
  try {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $real = $item.ResolveLinkTarget($true).FullName }
    else { $real = $item.FullName }
  } catch { return @{ ok = $false; why = ('cannot resolve node_modules entry: ' + $_.Exception.Message) } }
  $a = [IO.Path]::GetFullPath($real).TrimEnd('\')
  $b = [IO.Path]::GetFullPath($target).TrimEnd('\')
  if ($a -ne $b) { return @{ ok = $false; why = ('node_modules resolves to ' + $a + ' instead of ' + $b) } }
  $pj = Join-Path $real 'package.json'
  if (-not (Test-Path -LiteralPath $pj)) { return @{ ok = $false; why = 'vendor package.json missing' } }
  $meta = [IO.File]::ReadAllText($pj) | ConvertFrom-Json
  if ([string]$meta.name -ne $Package) { return @{ ok = $false; why = ('package name mismatch: ' + [string]$meta.name) } }
  if ([string]$meta.version -ne [string]$row.Installed) { return @{ ok = $false; why = ('version mismatch: ' + [string]$meta.version + ' expected ' + [string]$row.Installed) } }
  return @{ ok = $true; why = '' }
}

# Gate 3: the profile still composes with the new dependency spec.
function Test-DumpConfig([string]$profileName, [int]$timeoutSec = 180) {
  $psi = [Diagnostics.ProcessStartInfo]::new($env:ComSpec)
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  foreach ($a in @('/c', 'dsh', '--profile', $profileName, '--dump-config')) { $psi.ArgumentList.Add($a) }
  $proc = [Diagnostics.Process]::new()
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $so = $proc.StandardOutput.ReadToEndAsync()
  $se = $proc.StandardError.ReadToEndAsync()
  if (-not $proc.WaitForExit($timeoutSec * 1000)) {
    try { $proc.Kill($true) } catch { }
    return @{ ok = $false; why = 'dump-config timed out' }
  }
  $err = ([string]$se.GetAwaiter().GetResult()).Trim()
  if ($proc.ExitCode -ne 0) {
    if ($err.Length -gt 300) { $err = $err.Substring(0, 300) }
    return @{ ok = $false; why = ('dump-config exit ' + $proc.ExitCode + ': ' + $err) }
  }
  return @{ ok = $true; why = '' }
}

# A rollback is only real when node_modules actually left the vendor tree.
function Test-RevertAcceptance([string]$expectSpec) {
  $pkgDir = Join-Path $script:DshHome ('profiles\' + $Profile)
  $nm = Join-Path $pkgDir ('node_modules\' + $Package)
  if (-not (Test-Path -LiteralPath $nm)) { return @{ ok = $false; why = 'node_modules entry missing after revert' } }
  $item = Get-Item -LiteralPath $nm -Force
  $real = $null
  try {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $real = $item.ResolveLinkTarget($true).FullName }
    else { $real = $item.FullName }
  } catch { return @{ ok = $false; why = ('cannot resolve node_modules entry: ' + $_.Exception.Message) } }
  $vendorRoot = [IO.Path]::GetFullPath((Join-Path $script:DshHome 'vendor')).TrimEnd('\')
  $rr = [IO.Path]::GetFullPath($real).TrimEnd('\')
  if ($rr.StartsWith($vendorRoot, [StringComparison]::OrdinalIgnoreCase)) {
    return @{ ok = $false; why = ('node_modules still resolves into vendor: ' + $rr) }
  }
  if ($expectSpec -and $expectSpec.StartsWith('link:')) {
    $want = [IO.Path]::GetFullPath($expectSpec.Substring(5)).TrimEnd('\')
    if (-not $rr.Equals($want, [StringComparison]::OrdinalIgnoreCase)) { return @{ ok = $false; why = ('node_modules resolves to ' + $rr + ' instead of ' + $want) } }
  }
  return @{ ok = $true; why = '' }
}

function Save-Audit($payload) {
  $dir = Join-Path $script:GuardRoot 'audit'
  [IO.Directory]::CreateDirectory($dir) | Out-Null
  $name = 'takeover-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + (Get-SafeName $Package) + '.json'
  $path = Join-Path $dir $name
  Write-AtomicJson $path $payload
  return $path
}

function Update-VendorIndex($entry) {
  $path = Join-Path $script:GuardRoot 'vendor-index.json'
  $idx = @{}
  if (Test-Path -LiteralPath $path) {
    try { $idx = [IO.File]::ReadAllText($path) | ConvertFrom-Json -AsHashtable } catch { $idx = @{} }
  }
  if ($null -eq $idx) { $idx = @{} }
  $idx[([string]$entry.package + '@' + [string]$entry.version)] = $entry
  Write-AtomicJson $path $idx
}

$result = [ordered]@{ ok = $false; mode = $mode; package = $Package; profile = $Profile; applied = $false; reason = $Reason; repo = $Repo }
$lock = $null
try {
  [IO.Directory]::CreateDirectory($script:DshHome) | Out-Null
  $lockPath = Join-Path $script:DshHome '.plugin-guard.lock'
  # -NoLock is only meaningful for an in-process caller that already owns the
  # same file lock (guard.ps1); opening it twice would throw a sharing error.
  if (-not $NoLock) {
    try {
      $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
    } catch {
      if (-not $BreakLock) { throw 'Another guard or takeover operation holds the shared lock. Re-run with -BreakLock only after confirming no other guard process is alive.' }
      $probe = $null
      try { $probe = [IO.File]::Open($lockPath, 'Open', 'ReadWrite', 'ReadWrite') } catch { $probe = $null }
      if ($null -eq $probe) { throw 'The guard lock is held by a live process. -BreakLock refuses to steal it; let that operation finish instead.' }
      $probe.Dispose()
      $stale = $lockPath + '.stale-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
      Move-Item -LiteralPath $lockPath -Destination $stale -Force
      Write-GuardLog ('broke stale guard lock -> ' + $stale) 'WARN'
      $result['lockBroken'] = $stale
      $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
    }
  }

  $pkgDir = Join-Path $script:DshHome ('profiles\' + $Profile)
  if (-not (Test-Path -LiteralPath (Join-Path $pkgDir 'package.json'))) { throw "Profile directory not found: $pkgDir" }

  if ($mode -eq 'revert') {
    $bkRoot = Join-Path $script:GuardRoot ('backups\takeover\' + (Get-SafeName $Package))
    if (-not (Test-Path -LiteralPath $bkRoot)) { throw "No takeover backup recorded for $Package in profile $Profile." }
    $cands = @(Get-ChildItem -LiteralPath $bkRoot -Directory | Sort-Object Name -Descending)
    $vendorPrefix = ([IO.Path]::GetFullPath((Join-Path $script:DshHome 'vendor'))).Replace('\', '/').ToLower()
    $latest = $null
    foreach ($c in $cands) {
      $pj = Join-Path $c.FullName 'package.json'
      if (-not (Test-Path -LiteralPath $pj)) { continue }
      $sp = ''
      try { $sp = [string](([IO.File]::ReadAllText($pj) | ConvertFrom-Json).dependencies.$Package) } catch { $sp = '' }
      $spn = $sp.Replace('\', '/').ToLower()
      if ($spn.StartsWith('link:') -and $spn.Contains($vendorPrefix)) { continue }
      $latest = $c
      break
    }
    if (-not $latest) { throw "No clean takeover backup recorded for $Package in profile $Profile." }
    Restore-ProfileFiles $latest.FullName $pkgDir
    # pnpm reuses its old resolution when a lockfile is present, so the lock is
    # dropped first and the install is verified against the restored spec.
    $lockFile = Join-Path $pkgDir 'pnpm-lock.yaml'
    if (Test-Path -LiteralPath $lockFile) { [IO.File]::Delete($lockFile) }
    Clear-PnpmFastPath $pkgDir
    $inst = Invoke-PnpmInstall $pkgDir
    $specNow = ''
    try { $specNow = [string](([IO.File]::ReadAllText((Join-Path $pkgDir 'package.json')) | ConvertFrom-Json).dependencies.$Package) } catch { $specNow = '' }
    $acc = Test-RevertAcceptance $specNow
    if (-not $acc.ok) {
      $inst = Invoke-PnpmInstall $pkgDir 600 -Force
      $acc = Test-RevertAcceptance $specNow
    }
    if (-not $acc.ok) { throw ('revert acceptance failed: ' + $acc.why) }
    $result['ok'] = $true
    $result['reverted'] = $true
    $result['backup'] = $latest.FullName
    $result['restoredSpec'] = $specNow
    $result['installTail'] = $inst.tail
  } else {
    $row = Get-PackageRow
    $stagingRoot = Join-Path $script:GuardRoot 'staging'
    $saved = Save-GuardSnapshot $row $stagingRoot
    $result['staged'] = $saved
    if ($mode -eq 'stage') {
      $result['ok'] = $true
      $result['note'] = 'Source-only copy; no profile file changed.'
    } else {
      $vendorRoot = Join-Path $script:DshHome 'vendor'
      $slot = Resolve-VendorDir $row $saved $vendorRoot
      if (-not $slot.exists) { Copy-VendorPayload $saved $slot.dir }
      $result['vendor'] = $slot.dir
      $result['vendorReused'] = [bool]$slot.reused
      $result['vendorCreated'] = -not [bool]$slot.exists

      $metaDir = Join-Path (Join-Path $vendorRoot (Get-SafeName $Package)) '.guard-sources'
      [IO.Directory]::CreateDirectory($metaDir) | Out-Null
      $metaPath = Join-Path $metaDir ((Split-Path $slot.dir -Leaf) + '.json')
      Write-AtomicJson $metaPath ([ordered]@{
        schema = 1; package = $Package; version = [string]$row.Installed; digest = $saved.digest
        sourceSpec = [string]$row.Spec; repo = $Repo; profiles = @($Profile)
        stagedAt = $saved.at; takenOverAt = (Get-Date).ToString('o')
      })
      $result['sourceMeta'] = $metaPath

      $linkSpec = 'link:' + ([IO.Path]::GetFullPath($slot.dir)).Replace('\', '/')
      $result['link'] = $linkSpec
      $curSpec = ''
      try { $curSpec = [string](([IO.File]::ReadAllText((Join-Path $pkgDir 'package.json')) | ConvertFrom-Json).dependencies.$Package) } catch { $curSpec = '' }
      $alreadyTaken = $false
      if ($curSpec -eq $linkSpec) {
        $pre = Test-Acceptance $slot.dir $row
        if ($pre.ok) { $alreadyTaken = $true }
      }
      if ($alreadyTaken) {
        $result['ok'] = $true
        $result['applied'] = $true
        $result['alreadyTakenOver'] = $true
        $result['note'] = 'Dependency already targets this vendor slot and acceptance passed; nothing was rewritten.'
      } else {
      $backupDir = Backup-ProfileFiles $pkgDir ((Get-Date -Format 'yyyyMMdd-HHmmss'))
      $result['backup'] = $backupDir
      try {
        Clear-PnpmFastPath $pkgDir
        Set-DependencySpec (Join-Path $pkgDir 'package.json') $Package $linkSpec
        $inst = Invoke-PnpmInstall $pkgDir
        $acc = Test-Acceptance $slot.dir $row
        if (-not $acc.ok) { throw ('acceptance failed: ' + $acc.why) }
        $result['installTail'] = $inst.tail
        if (-not $SkipDumpConfig) {
          $dc = Test-DumpConfig $Profile
          if (-not $dc.ok) { throw ('dump-config failed: ' + $dc.why) }
          $result['dumpConfig'] = 'ok'
        }
        $result['ok'] = $true
        $result['applied'] = $true
      } catch {
        $failure = $_.Exception.Message
        Restore-ProfileFiles $backupDir $pkgDir
        Clear-PnpmFastPath $pkgDir
        $rollback = 'ok'
        try { [void](Invoke-PnpmInstall $pkgDir 300) } catch { $rollback = ('failed: ' + $_.Exception.Message) }
        $result['rolledBack'] = $true
        $result['rollbackInstall'] = $rollback
        throw $failure
      }
      }
    }
  }

  $result['at'] = (Get-Date).ToString('o')
  $result['audit'] = Save-Audit $result
  if ($result['applied']) {
    Update-VendorIndex ([ordered]@{
      package = $Package; version = [string]$row.Installed; dir = $slot.dir; link = $linkSpec
      sourceSpec = [string]$row.Spec; repo = $Repo; profiles = @($Profile); takenOverAt = $result['at']
      keepVersions = $KeepVersions
    })
  }
  Write-GuardLog ('takeover ' + $mode + ' ' + $Package + ' (' + $Profile + ') ok=' + $result['ok']) 'INFO'
  $result | ConvertTo-Json -Depth 10
  exit 0
} catch {
  $result['ok'] = $false
  $result['error'] = $_.Exception.Message
  $result['at'] = (Get-Date).ToString('o')
  try { $result['audit'] = Save-Audit $result } catch { }
  $result | ConvertTo-Json -Depth 10
  exit 1
} finally {
  if ($lock) { $lock.Dispose() }
}