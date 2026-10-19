import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeWorld} from './harness.mjs';

const plan=`# Cart plan

**Acceptance:**
- [quantity] Quantities contribute to the total. (check: project)

## Phase 1: Cart
1. Change src/cart.mjs to handle quantities.
2. Add a test in test/cart.test.mjs for quantities.
3. Run npm test; all tests pass.
`;
function baseline(w) {
  const project=fs.readdirSync(path.join(w.home,'projects'))[0];
  const folder=path.join(w.home,'projects',project,'baselines');
  return JSON.parse(fs.readFileSync(path.join(folder,fs.readdirSync(folder)[0]),'utf8'));
}
function approve(s,event='PostToolUse') {
  return s.hook(event,{tool_name:'ExitPlanMode',tool_use_id:`toolu_${s.toolN}_${s.id.slice(0,6)}`,tool_input:{},tool_response:{}});
}
test('the host approval callback binds the displayed plan criteria through the real entry point',()=>{
  const w=makeWorld(),s=w.session();s.start();s.prompt('Fix quantities in src/cart.mjs');s.writePlan(plan);
  const staged=s.exitPlan();assert.equal(staged.json?.hookSpecificOutput?.permissionDecision,undefined);
  assert.deepEqual(baseline(w).criteria,[]);
  const approved=approve(s);assert.equal(approved.status,0,approved.stderr);
  assert.deepEqual(baseline(w).criteria,[{id:'quantity',text:'Quantities contribute to the total.',check:'project'}]);
  assert.equal(baseline(w).criteriaSource,'approved_plan');
});
test('a failed approval or a changed plan cannot create confirmed criteria',()=>{
  const w=makeWorld(),s=w.session();s.start();s.prompt('Fix quantities in src/cart.mjs');s.writePlan(plan);s.exitPlan();
  approve(s,'PostToolUseFailure');assert.deepEqual(baseline(w).criteria,[]);
  fs.writeFileSync(path.join(w.plans,'add-a-search-bar-quirky-duckling.md'),plan.replace('Quantities contribute','Prices contribute'));
  approve(s);assert.deepEqual(baseline(w).criteria,[]);
});
