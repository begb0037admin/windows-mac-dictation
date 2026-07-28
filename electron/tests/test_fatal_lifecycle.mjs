import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FatalGate } from '../fatal-gate.js';

// This is the exact mechanism SS13 step 1 and SS12.2 step 3 rely on to close
// the BACKEND_TIMEOUT-vs-BACKEND_EXIT race: whichever call reaches
// claim() first runs its action; every other call (concurrent or later)
// gets that same result without its own action ever running.

test('first claim runs its action', async () => {
  const gate = new FatalGate();
  let ran = 0;
  const result = await gate.claim(() => { ran += 1; return 'BACKEND_TIMEOUT'; });
  assert.equal(ran, 1);
  assert.equal(result, 'BACKEND_TIMEOUT');
});

test('a later claim never runs its own action - returns the first result', async () => {
  const gate = new FatalGate();
  await gate.claim(() => 'BACKEND_TIMEOUT');
  let secondRan = false;
  const second = await gate.claim(() => { secondRan = true; return 'BACKEND_EXIT'; });
  assert.equal(secondRan, false, 'the delayed BACKEND_EXIT path must not run once BACKEND_TIMEOUT already claimed the gate');
  assert.equal(second, 'BACKEND_TIMEOUT', 'both callers observe the same (first) outcome');
});

test('concurrent claims (simulating the real race) - only one action runs', async () => {
  const gate = new FatalGate();
  let timeoutRan = 0;
  let exitRan = 0;
  // Simulates SS12.2 calling fatalNative('BACKEND_TIMEOUT', ...) and a
  // near-simultaneous delayed backend exit event calling
  // fatalNative('BACKEND_EXIT', ...) - both synchronous claim() calls in
  // the same tick, exactly how two 'immediate' event handlers would race.
  const p1 = gate.claim(() => { timeoutRan += 1; return 'BACKEND_TIMEOUT'; });
  const p2 = gate.claim(() => { exitRan += 1; return 'BACKEND_EXIT'; });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(timeoutRan + exitRan, 1, 'exactly one action must run, never both, never zero');
  assert.equal(r1, r2, 'every caller observes the same single outcome');
});

test('claimed reflects whether the gate has been used', () => {
  const gate = new FatalGate();
  assert.equal(gate.claimed, false);
  gate.claim(() => {});
  assert.equal(gate.claimed, true);
});
