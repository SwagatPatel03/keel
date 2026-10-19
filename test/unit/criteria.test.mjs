import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parsePlanCriteria} from '../../src/criteria.mjs';
import {captureBaseline,stagePlanCriteria,bindApprovedPlanCriteria,confirmedCriteria,verify} from '../../src/verification.mjs';
import {ProjectStore} from '../../src/store.mjs';
import {Shadow} from '../../src/checkpoint.mjs';

const plan='# Plan\n\n**Acceptance:**\n- [number] The requested number is returned. (check: project)\n- [review] The output is clear. (manual: inspect the terminal output)\n\n## Phase 1\n1. Implement and test.\n';
function project(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'keel-criteria-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{test:'node --test'}}));
  fs.writeFileSync(path.join(root,'number.test.mjs'),"import test from 'node:test';test('number',()=>{});");
  const store=new ProjectStore(root),shadow=new Shadow(store);captureBaseline(store,'task',shadow.snapshot('session','start'));
  return {store,root};
}
test('acceptance sections parse explicit automated checks and named manual reviews',()=>{
  assert.deepEqual(parsePlanCriteria(plan),[{id:'number',text:'The requested number is returned.',check:'project'},{id:'review',text:'The output is clear.',manual:true,review:'inspect the terminal output'}]);
  assert.equal(parsePlanCriteria('# Plan\n1. Test the change.'),null);
  assert.throws(()=>parsePlanCriteria('## Acceptance criteria\n- Something vague'),/observable text/);
  assert.throws(()=>parsePlanCriteria(plan.replace('[review]','[number]')),/unique/);
});
test('a staged plan stores only hashes; matching approval binds criteria without approving test changes',t=>{
  const {store,root}=project(t);stagePlanCriteria(store,'task',plan,'call-1');
  const pending=fs.readFileSync(path.join(store.dir,'plan-criteria',fs.readdirSync(path.join(store.dir,'plan-criteria'))[0]),'utf8');
  assert.ok(!pending.includes('requested number'));assert.throws(()=>confirmedCriteria(store,'task'),/await/);
  fs.appendFileSync(path.join(root,'number.test.mjs'),'// proposed test edit');
  assert.equal(bindApprovedPlanCriteria(store,'task',plan,'call-1'),true);
  assert.equal(confirmedCriteria(store,'task').length,2);
  const evidence=verify(store,{session:'session',task:'task'});
  assert.equal(evidence.verdict,'not_verified');assert.match(evidence.reasons.join(' '),/baseline approval/);
});
test('changed plans, unmatched callbacks and unknown check ids never bind acceptance',t=>{
  const {store}=project(t);
  for(const [staged,approved,id] of [[plan,plan+'changed','call-1'],[plan,plan,'other-call'],[plan.replace('check: project','check: nonexistent'),plan.replace('check: project','check: nonexistent'),'call-1']]) {
    stagePlanCriteria(store,'task',staged,'call-1');
    assert.equal(bindApprovedPlanCriteria(store,'task',approved,id),false);
    assert.throws(()=>confirmedCriteria(store,'task'));
  }
});
