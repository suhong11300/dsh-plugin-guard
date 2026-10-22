import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]), pwsh=process.argv[3], ledger=process.argv[4];
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'guard-regression-'));
const records=[],checks=[];
async function run(file,args,env={}) {return new Promise(resolve=>{const c=spawn(file,args,{env:{...process.env,...env},windowsHide:true});let stdout='',stderr='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);c.on('error',e=>stderr+=e);c.on('close',exit=>{const r={command:[file,...args],stdout,stderr,exit};records.push(r);resolve(r);});});}
function check(name,ok,actual){checks.push({name,ok:Boolean(ok),actual});console.log(`${ok?'PASS':'FAIL'} ${name}`);}
function psq(s){return "'"+s.replaceAll("'","''")+"'";}
const common=path.join(root,'backend/common.ps1');
const server=http.createServer((req,res)=>{const [ms,status]=req.url.slice(1).split('/').map(Number);setTimeout(()=>{res.writeHead(status);res.end('fixture');},ms);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
 const port=server.address().port;
 const urls=[`http://127.0.0.1:${port}/1800/200`,`http://127.0.0.1:${port}/100/404`,`http://127.0.0.1:${port}/700/503`];
 const r=await run(pwsh,['-NoProfile','-Command',`. ${psq(common)}; $x=@(P-Many @(${urls.map(psq).join(',')}) 6 3); ConvertTo-Json -InputObject $x -Compress`],{NO_PROXY:'127.0.0.1,localhost'});
 check('parallel responses retain input identity',r.exit===0&&r.stdout.trim()==='["200","404","503"]',r.stdout.trim());
}finally{await new Promise(r=>server.close(r));}
let r=await run(pwsh,['-NoProfile','-Command',`. ${psq(common)}; Resolve-FromCodes '404' '000' '404' | ConvertTo-Json -Compress`]);
check('timeout plus 404 remains unknown',r.exit===0&&JSON.parse(r.stdout).Live===null,r.stdout.trim());
const mocks=`
function P-Many([string[]]$urls,[int]$timeoutSec=8,[int]$throttle=8) {
 foreach($u in $urls) {
  if($u -like '*registry.npmjs.org*') { if($env:CASE -eq 'npm-alive'){'200'}elseif($env:CASE -eq 'npm-unknown'){'000'}else{'404'} }
  elseif($env:CASE -eq 'recovered') {'200'} elseif($env:CASE -eq 'unknown') {'000'} else {'404'}
 }
}
function Test-RepoAlive([string]$repo,[int]$timeoutSec=12) {
 if($env:CASE -eq 'unknown'){return @{Live=$null;Web='000';Codeload='000'}}
 return @{Live=$false;Web='404';Codeload='404'}
}
`;
async function fixture(name,kinds,{confirmed=false,dry=false}={}){
 const home=path.join(scratch,name), grd=path.join(home,'.dsh/plugin-guard'),prof=path.join(home,'.dsh/profiles/web');
 fs.mkdirSync(grd,{recursive:true});fs.mkdirSync(prof,{recursive:true});
 fs.copyFileSync(path.join(root,'backend/guard.ps1'),path.join(grd,'guard.ps1'));
 fs.writeFileSync(path.join(grd,'common.ps1'),fs.readFileSync(common,'utf8')+mocks);
 const old=new Date(Date.now()-48*3600000).toISOString();
 const pkg={name:'fixture',dependencies:{'fixture-plugin':'github:fixture/repo'}};
 fs.writeFileSync(path.join(prof,'package.json'),JSON.stringify(pkg));
 const statePath=path.join(grd,'state.json');
 fs.writeFileSync(statePath,JSON.stringify({version:1,snapshots:{},repos:{'fixture/repo':{firstSeen:old,deadSince:old,consecutiveDead:1,confirmedAt:confirmed?old:null,takeover:null}}}));
 const before=fs.readFileSync(statePath,'utf8');let last,report;
 for(const kind of kinds){
  last=await run(pwsh,['-NoProfile','-File',path.join(grd,'guard.ps1'),'-Mode','manual','-Profiles','web','-NoTakeover','-NoSnapshot',...(dry?['-DryRun']:[]),...(fs.readFileSync(path.join(grd,'guard.ps1'),'utf8').includes('[switch]$JsonOnly')?['-JsonOnly']:[])],{USERPROFILE:home,DSH_HOME:'',DSH_GUARD_DIR:'',CASE:kind});
  const marker=last.stdout.split(/\r?\n/).find(x=>x.startsWith('GUARD_RESULT_JSON='));
  if(marker) report=JSON.parse(marker.slice('GUARD_RESULT_JSON='.length));
  else if(last.stdout.trim().startsWith('{')) report=JSON.parse(last.stdout);
  else {const dir=path.join(grd,'reports');const files=fs.existsSync(dir)?fs.readdirSync(dir).sort():[];if(files.length)report=JSON.parse(fs.readFileSync(path.join(dir,files.at(-1)),'utf8'));}
 }
 const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
 const entry=dry?report?.repos?.[0]:state.repos['fixture/repo'];
 const files=fs.readdirSync(grd,{recursive:true});
 return {last,entry,report,stateUnchanged:before===fs.readFileSync(statePath,'utf8'),persistentWrites:files.filter(p=>String(p).endsWith('.log')||String(p).startsWith('reports'))};
}
let f=await fixture('npm-alive',['npm-alive']);
check('npm 200 cannot confirm dead',f.last.exit===0&&!f.entry.confirmedAt&&f.report.summary.confirmedDead===0,f.entry);
f=await fixture('npm-unknown',['npm-unknown']);
check('npm timeout cannot confirm dead',f.last.exit===0&&!f.entry.confirmedAt&&f.entry.status==='unknown',f.entry);
f=await fixture('recovered',['recovered'],{confirmed:true});
check('recovery revokes confirmedAt',f.last.exit===0&&f.entry.status==='alive'&&!f.entry.confirmedAt,f.entry);
f=await fixture('interrupted',['unknown','dead']);
check('unknown breaks consecutive-dead streak',f.last.exit===0&&f.entry.consecutiveDead===1&&!f.entry.confirmedAt,f.entry);
f=await fixture('dry-run',['dead'],{dry:true});
check('DryRun leaves state and report/log untouched',f.last.exit===0&&f.stateUnchanged&&f.persistentWrites.length===0,{stateUnchanged:f.stateUnchanged,writes:f.persistentWrites});
const envHome=path.join(scratch,'configured-home');
r=await run(pwsh,['-NoProfile','-Command',`. ${psq(common)}; Write-Output $script:DshHome`],{DSH_HOME:envHome});
check('DSH_HOME is honored',r.exit===0&&path.resolve(r.stdout.trim())===envHome,r.stdout.trim());
const mod=await import(pathToFileURL(path.join(root,'lib/index.js')).href);
const routes=[];mod.apply({webServer:{register(x){routes.push(x);return()=>{};}},effect(){}},{guardDir:path.join(scratch,'missing')});
async function call(suffix,method,headers,body='{}'){
 const result={};const response={writeHead(code){result.code=code;},end(b){result.body=b?JSON.parse(String(b)):null;}};
 await routes.find(x=>x.path.endsWith(suffix)).handler({method,url:'/api/plugin-guard'+suffix,headers,socket:{remoteAddress:'::1'},async *[Symbol.asyncIterator](){yield Buffer.from(body);}},response);return result;
}
r=await call('/state','GET',{});
check('panel defaults to read-only',r.body?.config.allowActions===false,r.body?.config);
r=await call('/run','POST',{'host':'[::1]:19387','origin':'http://[::1]:19387','sec-fetch-site':'same-origin','x-plugin-guard':'1'});
check('IPv6 loopback passes origin gate but actions remain disabled',r.code===403&&r.body?.reason==='actions-disabled',r);
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
check('package ships required backend',pkg.files.includes('backend'),pkg.files);
const guard=fs.readFileSync(path.join(root,'backend/guard.ps1'),'utf8');
check('scanner has no automatic Apply call',!/-Apply\s+-Force/.test(guard),null);
const summary={checks,records,fixtureRoot:scratch,pass:checks.filter(c=>c.ok).length,fail:checks.filter(c=>!c.ok).length};
fs.writeFileSync(ledger,JSON.stringify(summary,null,2));
console.log(`SUMMARY pass=${summary.pass} fail=${summary.fail}`);
process.exitCode=summary.fail?1:0;
