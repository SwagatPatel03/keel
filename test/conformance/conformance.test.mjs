// The conformance suite: the same scenarios for every agent Keel supports.
// What an agent's hooks can do (its capability flags) decides which form the
// expected behaviour takes, for example "ask" versus "refuse and tell the
// agent to ask", or a stop between tool batches versus refusing further tools.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DRIVERS } from './drivers.mjs';
import { FIXED_CART, BUGGY_CART } from '../replay/harness.mjs';

const FAIL = 'not ok 1 - total adds price times quantity';

/** Guidance arrives with the prompt, or (for agents that cannot add text then) with the first tool result. */
async function guidanceFor(d, prompt) {
  const p = await d.prompt(prompt);
  if (d.caps.promptContext) return p.guidance;
  assert.equal(p.guidance, null, 'no text at prompt time for this agent');
  return (await d.ran('ls', { exit: 0, output: 'src test package.json' })).guidance;
}

for (const [name, make] of Object.entries(DRIVERS)) {
  test(`${name}: a clear, passing turn adds nothing at any hook`, async () => {
    const d = await make();
    for (const r of [
      await d.start(),
      await d.prompt('Rename total to cartTotal in src/cart.mjs'),
      await d.preShell('npm test'),
      await d.edited('src/cart.mjs', FIXED_CART.replace('// A tiny', '// A small')),
      await d.ran('npm test', { exit: 0, output: '# pass 3' }),
      await d.stop('Renamed it, and all tests pass.'),
    ]) {
      assert.equal(r.silent, true, `expected silence, got ${JSON.stringify(r.raw)}`);
    }
  });

  test(`${name}: a catastrophic command is refused with a plain reason`, async () => {
    const d = await make();
    await d.start();
    await d.prompt('Clean up the project folder');
    const r = await d.preShell('rm -rf ~');
    assert.equal(r.denied, true);
    assert.match(String(r.reason), /Keel refused this command: rm -r ~ would permanently delete your whole home folder/);
  });

  test(`${name}: a dangerous command is asked about, or paused with an instruction to ask`, async () => {
    const d = await make();
    await d.start();
    await d.prompt('Clean up the cart code in src/cart.mjs');
    const r = await d.preShell('git reset --hard');
    if (d.caps.ask) assert.equal(r.asked, true, JSON.stringify(r.raw));
    else {
      assert.equal(r.denied, true);
      assert.match(String(r.reason), /Keel paused this command: git reset --hard[\s\S]*ask whether they want to run it themselves/);
    }
  });

  test(`${name}: reading a secret file needs the user's say-so`, async (t) => {
    const d = await make();
    if (!d.preRead) return t.skip('this agent has no read hook');
    await d.start();
    await d.prompt('Check the config in src/cart.mjs');
    const r = await d.preRead('.env');
    assert.ok(r.asked || r.denied, JSON.stringify(r.raw));
    assert.match(String(r.reason), /secret|\.env/i);
  });

  test(`${name}: a false "done" claim sends the agent back once`, async () => {
    const d = await make();
    await d.start();
    await d.prompt('The cart total is wrong, fix src/cart.mjs so the tests pass');
    await d.edited('src/cart.mjs', BUGGY_CART);
    const first = await d.stop('Fixed it. All tests pass.');
    assert.ok(first.sentBack, `expected a send-back, got ${JSON.stringify(first.raw)}`);
    assert.match(first.sentBack, /Keel ran `npm test` and it failed/);
    const second = await d.stop('Sorry, the tests still fail.', { again: true });
    assert.equal(second.sentBack, null, 'never sent back twice');
  });

  test(`${name}: three identical failures stop the loop`, async () => {
    const d = await make();
    await d.start();
    await d.prompt('The cart total is wrong, fix src/cart.mjs so the tests pass');
    await d.ran('npm test', { exit: 1, output: `${FAIL}\n# at line 1` });
    await d.ran('npm test', { exit: 1, output: `${FAIL}\n# at line 2` });
    const third = await d.ran('npm test', { exit: 1, output: `${FAIL}\n# at line 9` });
    if (d.caps.batchHook && d.batch) {
      assert.equal((await d.batch()).halted, true);
    } else {
      const next = await d.preShell('npm test');
      assert.equal(next.denied, true, `tools are refused after the loop, got ${JSON.stringify(next.raw)}`);
      assert.match(String(next.reason), /paused until the user's next message/);
      void third;
    }
  });

  test(`${name}: a debugging prompt gets the learning note`, async () => {
    const d = await make();
    await d.start();
    const g = await guidanceFor(d, 'The cart total shows NaN when an item has no quantity, fix it in src/cart.mjs');
    assert.match(String(g), /\[Keel\] Learning note: this looks like a debugging task\./);
  });

  test(`${name}: a feature prompt is told to plan first`, async () => {
    const d = await make();
    await d.start();
    const g = await guidanceFor(d, 'Add a search bar to the products page that filters by name');
    assert.match(String(g), /sized as a feature/);
    assert.match(String(g), d.caps.planTool ? /enter plan mode/ : /post a short plan/);
  });
}
