import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {install, installPreview, settingsFile, doctor} from '../../src/install.mjs';

function installation(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'keel-install-reliability-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const keelRoot=path.join(home,'package');fs.mkdirSync(path.join(keelRoot,'src'),{recursive:true});fs.mkdirSync(path.join(keelRoot,'bin'));
  fs.writeFileSync(path.join(keelRoot,'package.json'),JSON.stringify({version:'0.6.1'}));
  fs.writeFileSync(path.join(keelRoot,'src','policy.mjs'),'export const policy = 1;');
  fs.writeFileSync(path.join(keelRoot,'bin','keel.mjs'),'// test launcher');
  return {home,keelRoot,env:{...process.env,COPILOT_HOME:'',XDG_CONFIG_HOME:''}};
}
test('installer previews and immutable version checks change no host settings', (t) => {
  const o=installation(t), file=settingsFile('cursor',o);
  const preview=JSON.parse(install('cursor',{...o,preview:true}));
  assert.equal(preview.path,file);assert.equal(preview.version,'0.6.1');assert.ok(preview.hash);
  assert.ok(!fs.existsSync(path.dirname(file)));
  assert.throws(()=>install('cursor',{...o,version:'0.0.1'}),/immutable version/);
  assert.ok(!fs.existsSync(path.dirname(file)));
});
test('changed source or launcher capabilities need a fresh exact displayed approval', (t) => {
  const o=installation(t), file=settingsFile('cursor',o);
  install('cursor',o);const original=fs.readFileSync(file,'utf8');
  fs.appendFileSync(path.join(o.keelRoot,'bin','keel.mjs'),'\n// changed launcher capability');
  assert.match(install('cursor',o),/Capabilities changed/);assert.equal(fs.readFileSync(file,'utf8'),original);
  const proposal=installPreview('cursor',o);
  fs.appendFileSync(path.join(o.keelRoot,'src','policy.mjs'),'\n// changed policy');
  assert.match(install('cursor',{...o,acceptHash:proposal.hash}),/Capabilities changed/);
  assert.match(install('cursor',{...o,acceptHash:installPreview('cursor',o).hash}),/now installed/);
  const current=JSON.parse(fs.readFileSync(file,'utf8'));current.userSetting='manual';fs.writeFileSync(file,JSON.stringify(current));
  assert.match(doctor(o),/Version\/configuration drift/);
});
