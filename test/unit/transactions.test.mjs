import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../src/store.mjs';
import { transact, undoTransaction, sessionRevert } from '../../src/transactions.mjs';
import {handle} from '../../src/handlers.mjs';
import {makeEvent} from '../../src/events.mjs';
import {Shadow} from '../../src/checkpoint.mjs';

const enc = (value) => value == null ? null : Buffer.from(value).toString('base64');
const entry = (file, base, incoming) => ({path:file, base:enc(base), incoming:enc(incoming)});
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-transaction-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root, store:new ProjectStore(root), put:(file,value)=>fs.writeFileSync(path.join(root,file),value), read:(file)=>fs.readFileSync(path.join(root,file))};
}
test('integration previews all conflicts before writing any selected file', (t) => {
  const p=project(t); p.put('a.txt','original'); p.put('b.txt','manual');
  const result=transact(p.store,'session',[entry('a.txt','original','agent'),entry('b.txt','original','agent')]);
  assert.equal(result.state,'conflict'); assert.equal(result.conflicts[0].path,'b.txt');
  assert.equal(p.read('a.txt').toString(),'original'); assert.equal(p.read('b.txt').toString(),'manual');
});
test('rename represented as delete/add preserves dirty unrelated files and supports undo/redo', (t) => {
  const p=project(t); p.put('old.txt','dirty initial contents'); p.put('manual.txt','pre-existing user work');
  const entries=[entry('old.txt','dirty initial contents',null),entry('new.txt',null,'dirty initial contents')];
  assert.equal(transact(p.store,'session',entries,{dryRun:true}).state,'preview');
  assert.equal(p.read('old.txt').toString(),'dirty initial contents');
  assert.equal(transact(p.store,'session',entries).state,'applied');
  assert.ok(!fs.existsSync(path.join(p.root,'old.txt')));
  assert.equal(p.read('new.txt').toString(),'dirty initial contents');
  assert.throws(()=>undoTransaction(p.store,{direction:'redo'}),/No successful undo/);
  undoTransaction(p.store);
  assert.equal(p.read('old.txt').toString(),'dirty initial contents');
  assert.ok(!fs.existsSync(path.join(p.root,'new.txt')));
  undoTransaction(p.store,{direction:'redo'});
  assert.equal(p.read('new.txt').toString(),'dirty initial contents');
  assert.equal(p.read('manual.txt').toString(),'pre-existing user work');
});
test('binary changes round-trip exact bytes and refuse a later overlapping binary edit', (t) => {
  const p=project(t), before=Buffer.from([0,1,255]), after=Buffer.from([0,2,254]); p.put('asset.bin',before);
  transact(p.store,'session',[entry('asset.bin',before,after)]);
  assert.deepEqual(p.read('asset.bin'),after); undoTransaction(p.store); assert.deepEqual(p.read('asset.bin'),before);
  undoTransaction(p.store); p.put('asset.bin',Buffer.from([0,9,253]));
  assert.equal(undoTransaction(p.store).state,'conflict');
  assert.deepEqual(p.read('asset.bin'),Buffer.from([0,9,253]));
});
test('path aliases, traversal and external junctions cannot authorize integration', (t) => {
  const p=project(t); p.put('a.txt','one');
  assert.throws(()=>transact(p.store,'session',[entry('a.txt','one','two'),entry('./a.txt','one','three')]),/Duplicate/);
  assert.throws(()=>transact(p.store,'session',[entry('../outside',null,'two')]),/escapes/);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'keel-external-')); t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  try { fs.symlinkSync(outside,path.join(p.root,'link'),process.platform==='win32'?'junction':'dir'); }
  catch(error) { if (['EPERM','EACCES'].includes(error.code)) return t.skip('Host cannot create link.'); throw error; }
  assert.throws(()=>transact(p.store,'session',[entry('link/outside.txt',null,'two')]),/escapes/);
  assert.ok(!fs.existsSync(path.join(outside,'outside.txt')));
});

test('observed shell writes retain evidence but require review instead of claiming ownership', (t) => {
  const p=project(t);p.put('a.txt','initial dirty work');
  const shadow=new Shadow(p.store),where={agent:'claude-code',session:'shell',turn:'one'};
  p.store.append(makeEvent('turn_start',where,{checkpoint:shadow.snapshot('shell','start')}));
  const ctx={store:p.store,transcriptPath:null,lastMessage:null,toolInput:{command:'node update.mjs'}};
  handle(makeEvent('tool_call',where,{tool:'Bash',toolUseId:'one'}),ctx);
  p.put('a.txt','unattributed change');
  handle(makeEvent('tool_result',where,{tool:'Bash',toolUseId:'one',command:'node update.mjs',ok:true}),ctx);
  const result=p.store.readSession('shell').find((event)=>event.kind==='tool_result');
  assert.match(result.ownershipReason,/Shell changes/);
  p.store.append(makeEvent('turn_end',where,{checkpoint:shadow.snapshot('shell','end')}));
  assert.throws(()=>sessionRevert(p.store,'shell'),/recovery patch/);
  assert.equal(p.read('a.txt').toString(),'unattributed change');
});
