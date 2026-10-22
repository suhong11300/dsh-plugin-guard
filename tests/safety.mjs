import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]),pwsh=process.argv[3],ledger=process.argv[4];
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'guard-safety-')),checks=[],records=[];
const home=path.join(temp,'home'),data=path.join(temp,'data');
function check(name,ok,actual){checks.push({name,ok:Boolean(ok),actual});console.log(`${ok?'PASS':'FAIL'} ${name}`);}
function q(s){return "'"+s.replaceAll("'","''")+"'";}
async function run(args,env={}){return new Promise(resolve=>{const c=spawn(pwsh,args,{env:{...process.env,USERPROFILE:temp,DSH_HOME:home,DSH_GUARD_DIR:data,...env},windowsHide:true});let stdout='',stderr='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);c.on('error',e=>stderr+=e);c.on('close',exit=>{const r={command:[pwsh,...args],stdout,stderr,exit};records.push(r);resolve(r);});});}
const backend=path.join(root,'backend'),common=path.join(backend,'common.ps1'),guard=path.join(backend,'guard.ps1'),stage=path.join(backend,'takeover.ps1');
for(const profile of ['desktop','web']){
 const dir=path.join(home,'profiles',profile),pkg=path.join(dir,'node_modules/fixture-plugin');fs.mkdirSync(pkg,{recursive:true});
 fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'fixture',dependencies:{'fixture-plugin':'github:fixture/repo'}}));
 fs.writeFileSync(path.join(dir,'pnpm-lock.yaml'),'sentinel lockfile\n');fs.writeFileSync(path.join(dir,'package.json.lock'),'active-lock-owner\n');
 fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'fixture-plugin',version:'1.0.0'}));fs.writeFileSync(path.join(pkg,'index.js'),'export const answer = 1;\n');
}
fs.mkdirSync(data,{recursive:true});
const before=fs.readFileSync(path.join(home,'profiles/web/package.json'),'utf8');
let r=await run(['-NoProfile','-Command',`$errs=@(); Get-ChildItem -LiteralPath ${q(backend)} -Filter '*.ps1' | ForEach-Object { $t=$null; $e=$null; [void][Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$t,[ref]$e); $errs+=@($e) }; if($errs.Count){$errs | Out-String | Write-Error; exit 1}; 'syntax-ok'`]);
check('all PowerShell files parse',r.exit===0,r);
for(const flags of [['-Stage','-Apply'],['-Stage','-Revert'],['-Apply','-Revert']]){
 r=await run(['-NoProfile','-File',stage,'-Profile','web','-Package','fixture-plugin',...flags]);
 check(`${flags.join(' + ')} is rejected as ambiguous before touching the profile`,r.exit===64&&/Choose at most one of -Stage, -Apply, -Revert/.test(r.stdout)&&fs.readFileSync(path.join(home,'profiles/web/package.json'),'utf8')===before,r.stdout);
}
async function stagePkg(profile){const r=await run(['-NoProfile','-File',stage,'-Profile',profile,'-Package','fixture-plugin','-JsonOnly']);return{r,result:r.exit===0?JSON.parse(r.stdout):null};}
let first=await stagePkg('web');
check('manual staging produces hash-verified source-only copy',first.r.exit===0&&first.result?.ok&&first.result?.applied===false&&first.result?.staged.dependencyClosure===false,first);
let again=await stagePkg('web');
check('identical payload reuses immutable snapshot',again.r.exit===0&&first.result?.staged.dir===again.result?.staged.dir,again);
let other=await stagePkg('desktop');
check('profiles never share staging destination',other.r.exit===0&&first.result?.staged.dir!==other.result?.staged.dir,other);
fs.writeFileSync(path.join(home,'profiles/web/node_modules/fixture-plugin/index.js'),'export const answer = 2;\n');
let changed=await stagePkg('web');
check('same version with new bytes gets a new digest',changed.r.exit===0&&changed.result?.staged.digest!==first.result?.staged.digest,changed);
if(changed.result){fs.writeFileSync(path.join(changed.result.staged.dir,'index.js'),'corrupt');}
let corrupt=await stagePkg('web');
check('corrupt existing snapshot is not silently accepted or replaced',corrupt.r.exit!==0&&/modified/.test(corrupt.r.stdout),corrupt);
check('staging never removes writer lock or changes lockfile',fs.readFileSync(path.join(home,'profiles/web/package.json.lock'),'utf8')==='active-lock-owner\n'&&fs.readFileSync(path.join(home,'profiles/web/pnpm-lock.yaml'),'utf8')==='sentinel lockfile\n',null);
// 0.3.0: manual Apply is a full transaction and Revert restores the original spec.
// Point the original spec at a local fixture so Revert's install can resolve offline.
const origPkg=path.join(temp,'orig/fixture-plugin');fs.mkdirSync(origPkg,{recursive:true});
fs.writeFileSync(path.join(origPkg,'package.json'),JSON.stringify({name:'fixture-plugin',version:'1.0.0'}));
fs.writeFileSync(path.join(origPkg,'index.js'),'export const answer = 1;\n');
fs.writeFileSync(path.join(home,'profiles/desktop/package.json'),JSON.stringify({name:'fixture',dependencies:{'fixture-plugin':'link:'+origPkg.split(path.sep).join('/')}}));
const beforeApply=fs.readFileSync(path.join(home,'profiles/desktop/package.json'),'utf8');
let ap=await run(['-NoProfile','-File',stage,'-Profile','desktop','-Package','fixture-plugin','-Apply','-JsonOnly','-SkipDumpConfig']);
let apJson=null;{const s=ap.stdout.slice(ap.stdout.indexOf('{'));try{apJson=JSON.parse(s);}catch{}}
check('manual Apply rewrites the dependency to a verified vendor link',ap.exit===0&&apJson?.applied===true&&JSON.parse(fs.readFileSync(path.join(home,'profiles/desktop/package.json'),'utf8')).dependencies['fixture-plugin'].startsWith('link:'),ap.stdout.slice(-600));
let rv=await run(['-NoProfile','-File',stage,'-Profile','desktop','-Package','fixture-plugin','-Revert','-JsonOnly','-SkipDumpConfig']);
check('Revert restores the original dependency spec',rv.exit===0&&fs.readFileSync(path.join(home,'profiles/desktop/package.json'),'utf8')===beforeApply,rv.stdout.slice(-600));
fs.writeFileSync(path.join(data,'state.json'),'{broken');
r=await run(['-NoProfile','-File',guard,'-NoSnapshot','-NoTakeover']);
check('corrupt state errors without resetting history',r.exit!==0&&fs.readFileSync(path.join(data,'state.json'),'utf8')==='{broken',r);
// Hold the real file lock across a child invocation; the child must fail before probes.
r=await run(['-NoProfile','-Command',`$l=[IO.File]::Open(${q(path.join(home,'.plugin-guard.lock'))},'OpenOrCreate','ReadWrite','None'); try { & ${q(pwsh)} -NoProfile -File ${q(guard)} -NoTakeover -NoSnapshot; $c=$LASTEXITCODE; Write-Output "child-exit=$c"; if($c -eq 0){exit 2} } finally {$l.Dispose()}`]);
check('shared lock rejects overlapping scanner',r.exit===0&&/child-exit=1/.test(r.stdout)&&/already running/.test(r.stderr),r);

// Exercise the unchanged host control logic with a stub child, not production profiles.
const host=path.join(temp,'host'),out=path.join(temp,'host-data');fs.mkdirSync(path.join(host,'lib'),{recursive:true});fs.mkdirSync(path.join(host,'backend'),{recursive:true});
fs.writeFileSync(path.join(host,'package.json'),'{}');
fs.copyFileSync(path.join(root,'lib/index.js'),path.join(host,'lib/index.mjs'));
const stub=path.join(host,'backend/guard.ps1');
const stubBody=`param([string]$Mode,[string]$Profiles,[string]$DshHome,[string]$GuardDir,[int]$ProbeTimeout,[switch]$NoTakeover,[switch]$NoSnapshot,[switch]$DryRun,[string]$TakeoverMode='review',[string]$TakeoverAllowProfiles='all',[int]$TakeoverMaxPerRun=1,[int]$TakeoverMaxTotal=5,[int]$TakeoverFailureBreaker=3,[int]$KeepVersions=3,[int]$ConfirmRuns=3,[int]$MinHours=24,[string]$RequireNpmGone='true',[switch]$Snapshot)\n[IO.Directory]::CreateDirectory($GuardDir) | Out-Null\n@{home=$DshHome;dir=$GuardDir;timeout=$ProbeTimeout;takeoverMode=$TakeoverMode;noSnapshot=[bool]$NoSnapshot} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $GuardDir 'arguments.json')\n`;
fs.writeFileSync(stub,stubBody);
const oldEnv={DSH_HOME:process.env.DSH_HOME,DSH_GUARD_PWSH:process.env.DSH_GUARD_PWSH};process.env.DSH_HOME=home;process.env.DSH_GUARD_PWSH=pwsh;
const mod=await import(pathToFileURL(path.join(host,'lib/index.mjs')).href),routes=[],disposals=[];
mod.apply({webServer:{register(x){routes.push(x);return()=>{};}},effect(f){disposals.push(f());}},{allowActions:true,guardDir:out,probeTimeoutSec:6,extraArgs:'-Apply -Force -DshHome C:/untrusted'});
async function call(suffix,method='POST',body='{}'){
 const result={};const response={writeHead(c){result.code=c;},end(b){result.body=b?JSON.parse(String(b)):null;}};
 await routes.find(x=>x.path.endsWith(suffix)).handler({method,url:'/api/plugin-guard'+suffix,headers:{host:'127.0.0.1:19387','x-plugin-guard':'1','sec-fetch-site':'same-origin'},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){yield Buffer.from(body);}},response);return result;
}
async function waitClosed(){for(let i=0;i<100;i++){const s=await call('/state','GET');if(!s.body.running&&!s.body.stopping)return s;await new Promise(r=>setTimeout(r,100));}throw Error('stub child did not exit');}
try{
 const start=await call('/run','POST','{"probeTimeoutSec":5}');const end=await waitClosed();let args=null;try{args=JSON.parse(fs.readFileSync(path.join(out,'arguments.json'),'utf8'));}catch(e){console.log('DEBUG start='+JSON.stringify(start).slice(0,300));console.log('DEBUG lastRun='+JSON.stringify(end.body.lastRunResult).slice(0,1500));console.log('DEBUG outFiles='+JSON.stringify(fs.existsSync(out)?fs.readdirSync(out):'missing'));console.log('DEBUG stub='+fs.readFileSync(stub,'utf8').slice(0,400));throw e;}
 check('host passes one timeout and consistent home/data paths',start.code===200&&end.body.lastRunResult.exitCode===0&&args.timeout===5&&args.home===home&&args.dir===out,args);
 check('extraArgs cannot enable Apply or override safe arguments',args.takeoverMode==='review'&&args.noSnapshot===true&&args.home===home,args);
 fs.writeFileSync(stub,stubBody+'Start-Sleep -Seconds 15\n');
 await call('/run');await new Promise(r=>setTimeout(r,700));
 const stop=await call('/stop');const during=await call('/run');await waitClosed();
 check('stop keeps busy until old child closes',stop.code===200&&during.code===409,{stop,during});
}finally{for(const f of disposals)f();for(const [k,v]of Object.entries(oldEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
const report={checks,records,temp,pass:checks.filter(x=>x.ok).length,fail:checks.filter(x=>!x.ok).length};fs.writeFileSync(ledger,JSON.stringify(report,null,2));console.log(`SUMMARY pass=${report.pass} fail=${report.fail}`);process.exitCode=report.fail?1:0;
