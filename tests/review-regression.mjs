import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]),pwsh=process.argv[3],ledger=process.argv[4];
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'guard-review-')),checks=[],records=[];
const source=f=>fs.readFileSync(path.join(root,f),'utf8');
function check(name,ok,actual){checks.push({name,ok:Boolean(ok),actual});console.log(`${ok?'PASS':'FAIL'} ${name}`);}
async function run(file,args,env={}){return new Promise(resolve=>{const c=spawn(file,args,{env:{...process.env,...env},windowsHide:true});let stdout='',stderr='';c.stdout.on('data',x=>stdout+=x);c.stderr.on('data',x=>stderr+=x);c.on('error',x=>stderr+=x);c.on('close',exit=>{const r={command:[file,...args],environmentOverrides:env,stdout,stderr,exit};records.push(r);resolve(r);});});}
const mocks=`
function P-Many([string[]]$urls,[int]$timeoutSec=8,[int]$throttle=8){
 foreach($u in $urls){
  $script:ProbeLedger+=@(1..120 | ForEach-Object {@{Url="https://fixture.invalid/$($_)";Http='200';Exit=0;Error='';Index=$_}})
  if($u -like '*registry*'){if($env:REVIEW_CASE -eq 'npm-unknown'){'000'}else{'404'}}elseif($env:REVIEW_CASE -eq 'npm-unknown'){'404'}else{'200'}
 }
}
function Test-RepoAlive([string]$repo,[int]$timeoutSec=8){return @{Live=$false;Web='404';Codeload='404'}}
`;
function setup(name){
 const dir=path.join(temp,name),backend=path.join(dir,'backend'),home=path.join(dir,'home'),data=path.join(dir,'data'),pkg=path.join(home,'profiles/web/node_modules/fixture-plugin');
 fs.mkdirSync(backend,{recursive:true});fs.mkdirSync(pkg,{recursive:true});fs.mkdirSync(data,{recursive:true});
 for(const f of fs.readdirSync(path.join(root,'backend')))fs.copyFileSync(path.join(root,'backend',f),path.join(backend,f));
 fs.appendFileSync(path.join(backend,'common.ps1'),mocks);
 fs.writeFileSync(path.join(home,'profiles/web/package.json'),JSON.stringify({name:'fixture',dependencies:{'fixture-plugin':'github:fixture/repo'}}));
 fs.writeFileSync(path.join(pkg,'package.json'),'{"name":"fixture-plugin","version":"1.0.0"}');fs.writeFileSync(path.join(pkg,'index.js'),'export const answer=42;\n');
 const old=new Date(Date.now()-48*3600000).toISOString();fs.writeFileSync(path.join(data,'state.json'),JSON.stringify({repos:{'fixture/repo':{status:'unknown',consecutiveDead:0,deadSince:null,confirmedAt:null,upstreamConsecutiveMissing:1,upstreamMissingSince:old,takeover:{ok:true,at:old}}},snapshots:{}}));
 return {dir,backend,home,data,env:{DSH_HOME:home,DSH_GUARD_DIR:data,USERPROFILE:dir}};
}
let fixture=setup('stdout');
let r=await run(pwsh,['-NoProfile','-File',path.join(fixture.backend,'guard.ps1'),'-Profiles','web','-DryRun'],fixture.env);
check('N1 default output keeps progress without giant machine JSON',r.exit===0&&!r.stdout.includes('GUARD_RESULT_JSON=')&&r.stdout.length<8000&&r.stdout.includes('guard summary'),{length:r.stdout.length,exit:r.exit});
r=await run(pwsh,['-NoProfile','-File',path.join(fixture.backend,'guard.ps1'),'-Profiles','web','-DryRun','-JsonOnly'],fixture.env);
let parsed;try{parsed=JSON.parse(r.stdout);}catch{}
check('N1 explicit JsonOnly returns complete parseable report',r.exit===0&&parsed?.repos.length===1&&parsed.probes.length>120,{exit:r.exit,probes:parsed?.probes?.length});
fixture=setup('upstream');r=await run(pwsh,['-NoProfile','-File',path.join(fixture.backend,'guard.ps1'),'-Profiles','web','-NoSnapshot'],{...fixture.env,REVIEW_CASE:'npm-unknown'});
let state=JSON.parse(fs.readFileSync(path.join(fixture.data,'state.json'),'utf8')).repos['fixture/repo'];
check('N3 repo missing evidence survives npm uncertainty without confirming package dead',r.exit===0&&state.upstreamConsecutiveMissing===2&&state.upstreamStatus==='missing'&&!state.confirmedAt&&state.status==='unknown',state);
check('N7 historical takeover is preserved but active dead field removed',state.takeover===undefined&&state.legacyTakeover?.ok===true,state);
fixture=setup('standalone');
fs.mkdirSync(path.join(fixture.home,'profiles/desktop'),{recursive:true});
fs.copyFileSync(path.join(fixture.home,'profiles/web/package.json'),path.join(fixture.home,'profiles/desktop/package.json'));
fs.writeFileSync(path.join(fixture.backend,'common.ps1'),source('backend/common.ps1')+`
function P-Many([string[]]$urls,[int]$timeoutSec=8,[int]$throttle=8){foreach($u in $urls){$script:ProbeLedger+=@{Url=$u;Http='200';Exit=0};'200'}}
function Test-RepoAlive([string]$repo,[int]$timeoutSec=8){$w=P "https://github.com/$repo" $timeoutSec; return @{Live=$true;Web=$w;Codeload='skip'}}
`);
r=await run(pwsh,['-NoProfile','-File',path.join(fixture.backend,'scan-upstream.ps1'),'-Profile','all'],fixture.env);
let scan;try{scan=JSON.parse(r.stdout);}catch{}
check('N9 standalone scan deduplicates and batches repository endpoints',r.exit===0&&scan?.rows.length===2&&scan.probes.length===4&&new Set(scan.probes.map(p=>p.Url)).size===4,{exit:r.exit,probes:scan?.probes});

async function hostFixture(name,config={},fake=false){
 const f=setup(name);fs.mkdirSync(path.join(f.dir,'lib'),{recursive:true});
 let hostCode=source('lib/index.js');if(fake)hostCode=hostCode.replace('from "node:child_process"','from "./fake-spawn.mjs"');
 fs.writeFileSync(path.join(f.dir,'lib/index.mjs'),hostCode);
 if(fake)fs.writeFileSync(path.join(f.dir,'lib/fake-spawn.mjs'),`import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';export let latest;export function spawn(cmd,args){const c=new EventEmitter();c.pid=424242;c.exitCode=null;c.signalCode=null;c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>true;if(cmd==='taskkill'){queueMicrotask(()=>c.emit('exit',0));}else{latest=c;}return c;}`);
 process.env.DSH_HOME=f.home;process.env.DSH_GUARD_PWSH=pwsh;
 const mod=await import(pathToFileURL(path.join(f.dir,'lib/index.mjs')).href),routes=[],dispose=[];
 mod.apply({webServer:{register(x){routes.push(x);return()=>{};}},effect(fn){dispose.push(fn());}},{guardDir:f.data,allowActions:true,guardProfiles:'web',...config});
 async function call(suffix,method='POST',body='{}'){
  const result={};await routes.find(x=>x.path.endsWith(suffix)).handler({method,url:'/api/plugin-guard'+suffix,headers:{host:'127.0.0.1:19387','x-plugin-guard':'1','sec-fetch-site':'same-origin'},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){yield Buffer.from(body);}},{writeHead(c){result.code=c;},end(b){result.body=b?JSON.parse(String(b)):null;}});return result;
 }
 async function wait(){for(let i=0;i<150;i++){const s=await call('/state','GET');if(!s.body.running&&!s.body.stopping)return s;await new Promise(r=>setTimeout(r,100));}throw Error('child timeout');}
 return {...f,call,wait,dispose};
}
const envBefore={DSH_HOME:process.env.DSH_HOME,DSH_GUARD_PWSH:process.env.DSH_GUARD_PWSH};
try{
 let h=await hostFixture('snapshots',{enableSnapshots:true});let start=await h.call('/run');let end=await h.wait();
 const snapshots=fs.existsSync(path.join(h.data,'snapshots'))?fs.readdirSync(path.join(h.data,'snapshots'),{recursive:true}):[];
 check('N2 panel opt-in creates a verified snapshot',start.code===200&&end.body.lastRunResult.exitCode===0&&snapshots.some(x=>String(x).endsWith('.guard-manifest.json')),{start,end:end.body.lastRunResult,files:snapshots});
 check('N1 real panel tail retains progress and summary',end.body.lastRunResult.tail.includes('[1/1]')&&end.body.lastRunResult.tail.includes('guard summary')&&!end.body.lastRunResult.tail.includes('GUARD_RESULT_JSON='),end.body.lastRunResult.tail);
 for(const f of h.dispose)f();
 h=await hostFixture('default-off');await h.call('/run');end=await h.wait();
 const defaultFiles=fs.existsSync(path.join(h.data,'snapshots'))?fs.readdirSync(path.join(h.data,'snapshots'),{recursive:true}):[];
 check('N2 snapshot remains off by default',end.body.lastRunResult.exitCode===0&&!defaultFiles.some(x=>String(x).endsWith('.guard-manifest.json')),{config:end.body.config,files:defaultFiles});for(const f of h.dispose)f();
 h=await hostFixture('legacy');
 fs.mkdirSync(path.join(h.data,'snapshots/pkg/1.0.0'),{recursive:true});fs.writeFileSync(path.join(h.data,'snapshots/pkg/1.0.0/package.json'),'{}');fs.mkdirSync(path.join(h.data,'snapshots/pkg/2.0.0'),{recursive:true});
 const s=await h.call('/state','GET');
 check('N8 legacy versions are separate and explicitly unverified',s.body.snapshots.length===2&&s.body.snapshots.every(x=>x.layout==='legacy'&&x.verified===false)&&s.body.snapshots.some(x=>x.empty),s.body.snapshots);for(const f of h.dispose)f();
 h=await hostFixture('stop',{},true);await h.call('/run');const fake=await import(pathToFileURL(path.join(h.dir,'lib/fake-spawn.mjs')).href);const old=fake.latest;
 await h.call('/stop');const stopping=await h.call('/state','GET'),blocked=await h.call('/run');
 check('N6 stopping is explicit and rejects overlapping start',stopping.body.running===false&&stopping.body.stopping===true&&blocked.code===409,{stopping:stopping.body.stopping,running:stopping.body.running,blocked:blocked.code});
 old.exitCode=0;old.emit('exit',0);await new Promise(r=>setTimeout(r,5600));const drained=await h.call('/state','GET');
 check('N6 exited child with hung pipes has bounded cleanup',drained.body.running===false&&drained.body.stopping===false,drained.body.lastRunResult);
 // Unconditionally finish fake child in old implementations so the test runner never leaks timers.
 old.emit('close',0);for(const f of h.dispose)f();
}finally{for(const[k,v]of Object.entries(envBefore)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
check('N4 process-scoped execution policy on host and runner',/"-ExecutionPolicy", "Bypass"/.test(source('lib/index.js'))&&/-ExecutionPolicy Bypass/.test(source('backend/run-guard.cmd')),null);
check('N2 scheduled runner exposes explicit snapshot opt-in',source('backend/run-guard.cmd').includes('DSH_GUARD_ENABLE_SNAPSHOTS'),null);
check('N5 version gate rationale is documented',source('docs/compatibility.md').includes('peerDependencies')&&source('docs/compatibility.md').includes('engines.dsh'),null);
const report={checks,records,temp,pass:checks.filter(x=>x.ok).length,fail:checks.filter(x=>!x.ok).length};fs.writeFileSync(ledger,JSON.stringify(report,null,2));console.log(`SUMMARY pass=${report.pass} fail=${report.fail}`);process.exitCode=report.fail?1:0;
