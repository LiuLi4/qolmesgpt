import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('installed i18n checkers support default and relative docs paths across multiple languages',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qolmes-i18n-'));
 try {
  for(const lang of ['en','zh','fr']) {await mkdir(join(root,'docs',lang),{recursive:true});await writeFile(join(root,'docs',lang,'one.md'),'123\n');}
  for(const checker of ['structure','completeness']) for(const args of [[],['docs'],['docs','zh','fr']]) {
   const result=spawnSync('bash',[resolve('.codexspec/scripts/check-i18n-'+checker+'.sh'),...args],{cwd:root,encoding:'utf8'});
   assert.equal(result.status,0,result.stdout+result.stderr);
   assert.doesNotMatch(result.stdout,/Directory not found/);
  }
 } finally {await rm(root,{recursive:true,force:true});}
});
