import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkManifest} from '../../src/workspace.mjs';
import {isSensitivePath,relativeFile} from '../../src/policy.mjs';
import {sandboxExecutable} from '../../src/supervisor.mjs';
import {checkPath} from '../../src/guard/paths.mjs';

test('sensitive path policy covers nested credentials and Windows stream aliases', () => {
  for(const file of ['nested/credentials.yaml','credentials/token','config/secrets/api-token','secret.txt','.azure/accessTokens.json','.config/gcloud/token','.envrc','.env:stream','.env. ','.aws/.env.example']) assert.equal(isSensitivePath(file),true,file);
  assert.equal(isSensitivePath('.env.example'),false);
  if(process.platform==='win32') for(const file of ['file:stream','CON.txt','file. ']) assert.throws(()=>relativeFile(process.cwd(),file),/Ambiguous/);
});
test('host sandbox preflight never resolves a project executable or a relative PATH entry', (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'keel-host-executable-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,process.platform==='win32'?'sbx.exe':'sbx'),'not a host runtime');
  assert.equal(sandboxExecutable(root,{PATH:root+path.delimiter+'.'}),null);
  for(const file of ['.gemini/config/hooks.json','.config/opencode/plugins/keel.js']) assert.equal(checkPath(file,'edit',{root}).severity,'refuse');
});
test('declared outputs may contain artifacts but cannot hide sensitive files or links', (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'keel-output-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'dist'));fs.writeFileSync(path.join(root,'dist','app.js'),'generated');
  assert.deepEqual(checkManifest(root,['dist']),{});
  fs.writeFileSync(path.join(root,'dist','.env'),'dummy');
  assert.throws(()=>checkManifest(root,['dist']),/sensitive path/);
  fs.unlinkSync(path.join(root,'dist','.env'));
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'keel-output-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  try{fs.symlinkSync(outside,path.join(root,'dist','link'),process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code))return t.skip('Host cannot create link.');throw error;}
  assert.throws(()=>checkManifest(root,['dist']),/escapes|link/);
});
