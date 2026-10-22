#Requires -Version 7.0
param([ValidateSet('all','desktop','web')][string]$Profile='all',[string]$OutJson='', [ValidateRange(1,60)][int]$TimeoutSec=12,[string]$DshHome='',[string]$GuardDir='')
. (Join-Path $PSScriptRoot 'common.ps1')
$script:DryLogging=$true
$targets=if($Profile -eq 'all'){@(Get-ChildItem -LiteralPath (Join-Path $script:DshHome 'profiles') -Directory | Select-Object -ExpandProperty Name)}else{@($Profile)}
$rows=@(Get-PluginRows $targets)
$repos=@($rows | Where-Object {$_.Kind -eq 'github' -and $_.Repo} | Select-Object -ExpandProperty Repo -Unique)
$packages=@($rows | Where-Object {$_.Kind -eq 'github'} | Select-Object -ExpandProperty Package -Unique)
$requests=@(foreach($repo in $repos){
 @{key="web:$repo";url="https://github.com/$repo"}
 @{key="main:$repo";url="https://codeload.github.com/$repo/tar.gz/refs/heads/main"}
 @{key="master:$repo";url="https://codeload.github.com/$repo/tar.gz/refs/heads/master"}
};foreach($pkg in $packages){@{key="npm:$pkg";url=(Get-NpmUrl $pkg)}})
$codes=@(P-Many @($requests | ForEach-Object {$_.url}) $TimeoutSec 8);$map=@{}
for($i=0;$i -lt $requests.Count;$i++){$map[$requests[$i].key]=if($i -lt $codes.Count){$codes[$i]}else{'000'}}
$result=@(foreach($r in $rows){
 $web='-';$cod='-';$npm='-';$verdict='not-covered'
 if($r.Kind -eq 'github' -and $r.Repo){
  $p=Resolve-FromCodes $map["web:$($r.Repo)"] $map["main:$($r.Repo)"] $map["master:$($r.Repo)"]
  $web=$p.Web;$cod=$p.Codeload;$npm=$map["npm:$($r.Package)"]
  $verdict=if($p.Live -eq $true){'alive'}elseif($p.Live -eq $false -and $npm -eq '404'){'missing-needs-review'}elseif($p.Live -eq $false -and $npm -eq '200'){'npm-metadata-only'}else{'unknown'}
 }elseif($r.Kind -in @('link-local','file-local')){$verdict=if($r.Installed){'local-present-not-runtime-tested'}else{'local-missing'}}
 [pscustomobject]@{Profile=$r.Profile;Package=$r.Package;Kind=$r.Kind;Repo=$r.Repo;Web=$web;Codeload=$cod;Npm=$npm;Verdict=$verdict;Installed=$r.Installed;Spec=$r.Spec}
})
$payload=@{generatedAt=(Get-Date).ToString('o');rows=$result;probes=@($script:ProbeLedger)}
if($OutJson){Write-AtomicJson ([IO.Path]::GetFullPath($OutJson)) $payload}
$payload | ConvertTo-Json -Depth 12
