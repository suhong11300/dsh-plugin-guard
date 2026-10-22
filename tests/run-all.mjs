// Cross-platform test entry: node tests/run-all.mjs
// Locates PowerShell 7 (DSH_GUARD_PWSH > PATH > default install), then runs every suite.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const suites=['safety','regression','review-regression'];

function findPwsh(){
  const candidates=[process.env.DSH_GUARD_PWSH,'pwsh','C:/Program Files/PowerShell/7/pwsh.exe','C:/Program Files/PowerShell/7-preview/pwsh.exe'].filter(Boolean);
  for(const exe of candidates){
    const r=spawnSync(exe,['-NoProfile','-Command','$PSVersionTable.PSVersion.Major'],{encoding:'utf8'});
    if(r.status===0&&Number(String(r.stdout).trim())>=7)return exe;
  }
  return null;
}

const pwsh=findPwsh();
if(!pwsh){
  console.error('PowerShell 7 not found. Set DSH_GUARD_PWSH to a pwsh.exe path, or install PowerShell 7.');
  process.exit(1);
}
console.log('pwsh: '+pwsh);

const ledger=os.tmpdir();
let failed=0;
for(const name of suites){
  const out=path.join(ledger,'guard-'+name+'-'+process.pid+'.json');
  console.log('\n== '+name+' ==');
  const r=spawnSync(process.execPath,[path.join(root,'tests',name+'.mjs'),root,pwsh,out],{stdio:'inherit'});
  if(r.status!==0)failed++;
}
console.log(failed?`\n${failed} suite(s) failed`:'\nall suites passed');
process.exit(failed?1:0);