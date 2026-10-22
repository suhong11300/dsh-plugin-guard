#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$script:DshHome = [IO.Path]::GetFullPath($(if ($DshHome) { $DshHome } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }))
$script:GuardRoot = [IO.Path]::GetFullPath($(if ($GuardDir) { $GuardDir } elseif ($env:DSH_GUARD_DIR) { $env:DSH_GUARD_DIR } else { Join-Path $script:DshHome 'plugin-guard' }))
$script:LogFile = Join-Path $script:GuardRoot 'log/guard.log'
$script:QuietLog = $false
$script:DryLogging = $false
$script:ProbeLedger = @()
function Write-GuardLog([string]$msg, [string]$level='INFO') {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " [$level] $msg"
  if (-not $script:DryLogging) {
    $dir=Split-Path $script:LogFile -Parent
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    Add-Content -LiteralPath $script:LogFile -Value $line -Encoding utf8
  }
  if (-not $script:QuietLog) { Write-Output $line }
}
function Write-AtomicJson([string]$path, $value) {
  $dir=Split-Path $path -Parent
  [IO.Directory]::CreateDirectory($dir) | Out-Null
  $tmp=Join-Path $dir ('.guard-'+[guid]::NewGuid().ToString('N')+'.tmp')
  try {
    [IO.File]::WriteAllText($tmp, ($value | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($tmp,$path,$true)
  } finally { if([IO.File]::Exists($tmp)){[IO.File]::Delete($tmp)} }
}
# Output remains an ordered array of status strings for existing callers.
# Each worker retains its index and URL, including on process failure.
function P-Many([string[]]$urls,[int]$timeoutSec=8,[int]$throttle=8) {
  if(-not $urls -or $urls.Count -eq 0){return @()}
  $items=@(for($i=0;$i -lt $urls.Count;$i++){[pscustomobject]@{Index=$i;Url=$urls[$i]}})
  $results=@($items | ForEach-Object -Parallel {
    $item=$_; $p=$null
    $http='000'; $code=-1; $err=''
    try {
      $psi=[Diagnostics.ProcessStartInfo]::new('curl.exe')
      $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true
      $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
      foreach($arg in @('-I','-sS','-L','--proto','=https,http','--proto-redir','=https,http','--max-time',[string]$using:timeoutSec,'--output','NUL','--write-out','%{http_code}','--user-agent','dsh-plugin-guard/0.2.1','--url',$item.Url)){$psi.ArgumentList.Add($arg)}
      $p=[Diagnostics.Process]::new(); $p.StartInfo=$psi; [void]$p.Start()
      $stdout=$p.StandardOutput.ReadToEndAsync(); $stderr=$p.StandardError.ReadToEndAsync()
      if(-not $p.WaitForExit(($using:timeoutSec+3)*1000)){$p.Kill($true);$p.WaitForExit()}
      $raw=$stdout.GetAwaiter().GetResult().Trim(); $err=$stderr.GetAwaiter().GetResult(); $code=$p.ExitCode
      if($code -eq 0 -and $raw -match '^\d{3}$'){$http=$raw}
    } catch {$err=$_.Exception.Message} finally {if($p){$p.Dispose()}}
    [pscustomobject]@{Index=$item.Index;Url=$item.Url;Http=$http;Exit=$code;Error=$err}
  } -ThrottleLimit $throttle | Sort-Object Index)
  $script:ProbeLedger += $results
  return @($results | ForEach-Object {$_.Http})
}
function P([string]$url,[int]$timeoutSec=12){ return [string](@(P-Many @($url) $timeoutSec 1)[0]) }
function Get-OwnerRepo([string]$spec) {
  $s = $spec.Trim()
  if ($s -match "^github:([^#/]+)/([^#/]+?)(#.*)?$") { return "$($Matches[1])/$($Matches[2])" }
  if ($s -match "github\.com/([^/]+)/([^/]+?)/(releases|archive|tree|blob)") { return "$($Matches[1])/$($Matches[2])" }
  if ($s -match "github\.com/([^/]+)/([^/]+?)(\.git)?(#.*)?$") { return "$($Matches[1])/$($Matches[2])" }
  return ""
}

function Get-NpmStatus([string]$name, [int]$timeoutSec = 12) {
  $enc = [uri]::EscapeDataString($name).Replace("%40", "@").Replace("%2F", "%2f")
  return (P ("https://registry.npmjs.org/" + $enc) $timeoutSec)
}

# Inventory: one row per dependency that looks like a DSH plugin across the given profiles.
function Get-PluginRows([string[]]$profiles) {
  $root = Join-Path $script:DshHome "profiles"
  $rows = New-Object System.Collections.ArrayList
  foreach ($p in $profiles) {
    $pkgPath = Join-Path $root "$p\package.json"
    if (-not (Test-Path $pkgPath)) { continue }
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    if (-not $pkg.dependencies) { continue }
    foreach ($prop in $pkg.dependencies.PSObject.Properties) {
      $name = $prop.Name
      $spec = [string]$prop.Value
      $kind = "registry"
      if ($spec -like "link:*") { $kind = "link-local" }
      elseif ($spec -like "file:*") { $kind = "file-local" }
      elseif ($spec -match "github") { $kind = "github" }
      elseif ($spec -match "^[~^]?[0-9]") { $kind = "registry" }
      else { $kind = "other" }
      $dir = Join-Path $root "$p\node_modules\$name"
      $installed = ""
      if (Test-Path (Join-Path $dir "package.json")) {
        try { $installed = [string](Get-Content (Join-Path $dir "package.json") -Raw | ConvertFrom-Json).version } catch { $installed = "?" }
      }
      $repo = ""
      if ($kind -eq "github") { $repo = Get-OwnerRepo $spec }
      [void]$rows.Add([pscustomobject]@{
        Profile = $p; Package = $name; Kind = $kind; Spec = $spec;
        Repo = $repo; Installed = $installed; Dir = $dir
      })
    }
  }
  return $rows
}


function Resolve-FromCodes([string]$web,[string]$codMain,[string]$codMaster) {
  if($web -eq '200'){return @{Live=$true;Web=$web;Codeload='skip'}}
  if($codMain -eq '200' -or $codMaster -eq '200'){return @{Live=$true;Web=$web;Codeload='200'}}
  if($web -eq '404' -and $codMain -eq '404' -and $codMaster -eq '404'){return @{Live=$false;Web=$web;Codeload='404'}}
  return @{Live=$null;Web=$web;Codeload="main=$codMain;master=$codMaster"}
}
function Resolve-RepoAlive([string]$repo,[string]$web,[int]$timeoutSec=8){
  if($web -eq '200'){return Resolve-FromCodes $web '' ''}
  $main=P "https://codeload.github.com/$repo/tar.gz/refs/heads/main" $timeoutSec
  if($main -eq '200'){return Resolve-FromCodes $web $main ''}
  $master=P "https://codeload.github.com/$repo/tar.gz/refs/heads/master" $timeoutSec
  return Resolve-FromCodes $web $main $master
}
function Test-RepoAlive([string]$repo,[int]$timeoutSec=12){return Resolve-RepoAlive $repo (P "https://github.com/$repo" $timeoutSec) $timeoutSec}
function Get-NpmUrl([string]$name){return 'https://registry.npmjs.org/'+[uri]::EscapeDataString($name).Replace('%40','@').Replace('%2F','%2f')}

# A source-only snapshot, NEVER a claim of an installable dependency closure.
# Refuse nested reparse points; never follow arbitrary links outside the package.
function Get-PayloadManifest([string]$root) {
  $stack=[Collections.Generic.Stack[string]]::new();$stack.Push($root)
  $files=[Collections.Generic.List[object]]::new()
  while($stack.Count){
    foreach($f in Get-ChildItem -LiteralPath $stack.Pop() -Force){
      if($f.Name -in @('.git','node_modules','.guard-manifest.json')){continue}
      if($f.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Snapshot refuses nested link: $($f.FullName)"}
      if($f.PSIsContainer){$stack.Push($f.FullName)}else{
        $files.Add([pscustomobject]@{path=[IO.Path]::GetRelativePath($root,$f.FullName).Replace('\','/');sha256=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower();bytes=$f.Length})
      }
    }
  }
  return @($files | Sort-Object path)
}
function Save-GuardSnapshot($row,[string]$snapshotRoot) {
  $source=Get-Item -LiteralPath $row.Dir -Force
  if($source.Attributes -band [IO.FileAttributes]::ReparsePoint){$source=$source.ResolveLinkTarget($true)}
  $files=@(Get-PayloadManifest $source.FullName)
  if(-not ($files | Where-Object path -eq 'package.json')){throw 'Snapshot missing package.json'}
  $json=ConvertTo-Json -InputObject $files -Depth 6 -Compress
  $digest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($json))).ToLower()
  $safe=[uri]::EscapeDataString($row.Package)
  $version=$row.Installed -replace '[^a-zA-Z0-9._-]','_'
  $parent=Join-Path $snapshotRoot "$safe/$($row.Profile)"
  $dest=Join-Path $parent "$version-$digest"
  if(Test-Path -LiteralPath $dest){
    $existing=ConvertTo-Json -InputObject @(Get-PayloadManifest $dest) -Depth 6 -Compress
    if($existing -ne $json){throw "Existing snapshot has been modified: $dest"}
    $metadata=Get-Content -LiteralPath (Join-Path $dest '.guard-manifest.json') -Raw | ConvertFrom-Json
    if($metadata.digest -ne $digest -or $metadata.package -ne $row.Package -or $metadata.profile -ne $row.Profile){throw 'Incomplete or mismatched snapshot manifest'}
  }else{
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $tmp=Join-Path $parent ('.staging-'+[guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($tmp) | Out-Null
    foreach($f in $files){
      $target=Join-Path $tmp $f.path
      [IO.Directory]::CreateDirectory((Split-Path $target -Parent)) | Out-Null
      [IO.File]::Copy((Join-Path $source.FullName $f.path),$target,$false)
    }
    if((ConvertTo-Json -InputObject @(Get-PayloadManifest $tmp) -Depth 6 -Compress) -ne $json){throw "Snapshot verification failed; incomplete staging retained: $tmp"}
    Write-AtomicJson (Join-Path $tmp '.guard-manifest.json') @{schema=1;package=$row.Package;profile=$row.Profile;version=$row.Installed;digest=$digest;files=$files;dependencyClosure=$false}
    [IO.Directory]::Move($tmp,$dest)
  }
  return @{key="$($row.Profile):$($row.Package)@$($row.Installed):$digest";dir=$dest;digest=$digest;dependencyClosure=$false;at=(Get-Date).ToString('o')}
}
