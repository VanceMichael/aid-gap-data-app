import assert from 'node:assert/strict';
import test from 'node:test';
import { computeState } from '../src/availability.mjs';
import { loadLedger } from '../src/ledger.mjs';

const ledger = await loadLedger();
const chargeOf = (state, id) => state.charges.find((c) => c.id === id);
const coverageOf = (state, id) => state.coverage.find((c) => c.charge === id);

test('学籍异动退费生效前后分开计算，且不写成现金', () => {
  const before = computeState(ledger, 15);
  assert.equal(chargeOf(before, 'C1').dueCents, 300000);
  assert.equal(chargeOf(before, 'C1').adjustments.length, 0);
  const after = computeState(ledger, 16);
  const c1 = chargeOf(after, 'C1');
  assert.equal(c1.dueCents, 250000);
  assert.equal(c1.dueBeforeAdjustments, 300000);
  assert.deepEqual(
    c1.adjustments.map((a) => ({ id: a.id, cents: a.cents, source: a.source })),
    [{ id: 'C4', cents: -50000, source: '学籍异动退费' }],
  );
  // 减免只减应缴，可用款不因减免增加
  assert.equal(after.students.S1.usableCents, 160000);
  assert.equal(before.students.S1.usableCents, 160000);
});

test('同一账单截止日以确认的延期为准，确认日前仍按原截止日', () => {
  assert.equal(chargeOf(computeState(ledger, 17), 'C2').deadline, 20);
  const c2 = chargeOf(computeState(ledger, 18), 'C2');
  assert.equal(c2.deadline, 24);
  assert.equal(c2.originalDeadline, 20);
  assert.deepEqual(c2.deadlineChange, { acceptedDay: 18, newDeadline: 24 });
  assert.equal(chargeOf(computeState(ledger, 19), 'C5').deadline, 28);
  assert.equal(chargeOf(computeState(ledger, 20), 'C5').deadline, 30);
});

test('批量汇款：已归属部分可用，未分配款不当作学生已足额', () => {
  const day9 = computeState(ledger, 9);
  assert.equal(day9.students.S1.usableCents, 160000);
  assert.equal(day9.students.S2.usableCents, 0);
  assert.deepEqual(day9.unallocated.map((u) => ({ wire: u.wire, cents: u.cents })), [
    { wire: 'W1', cents: 240000 },
  ]);
  const day12 = computeState(ledger, 12);
  assert.equal(day12.students.S2.usableCents, 150000);
  assert.deepEqual(day12.unallocated.map((u) => ({ wire: u.wire, cents: u.cents })), [
    { wire: 'W1', cents: 90000 },
  ]);
  // 未分配的 90000 不冲减任何人的缺口
  assert.equal(coverageOf(day12, 'C2').actualGapCents, 280000 - 150000 - 60000);
});

test('学生账户已到账未确认的回单与学校实收区分', () => {
  const state = computeState(ledger, 22);
  assert.equal(state.students.S2.usableCents, 150000);
  assert.deepEqual(state.students.S2.pending, [
    { wire: 'W5', cents: 50000, route: 'student', day: 12, reason: '学生账户已到账，待确认可转缴' },
  ]);
  // W2 已确认转缴 180000，其余 70000 仍待确认
  assert.equal(state.students.S3.usableCents, 180000);
  assert.deepEqual(state.students.S3.pending.map((p) => ({ wire: p.wire, cents: p.cents })), [
    { wire: 'W2', cents: 70000 },
  ]);
  assert.equal(coverageOf(state, 'C2').receivedCents, 150000);
});

test('冲正沿原流水辨明影响：可用款冲减、后续安排可追溯', () => {
  assert.equal(computeState(ledger, 16).students.S1.usableCents, 160000);
  const state = computeState(ledger, 17);
  assert.equal(state.students.S1.usableCents, 120000);
  assert.equal(state.reversals.length, 1);
  const [reversal] = state.reversals;
  assert.equal(reversal.wire, 'W3');
  assert.equal(reversal.adjusts, 'W1');
  assert.deepEqual(reversal.effects, [{ student: 'S1', cents: -40000, recognizedDay: 17 }]);
  assert.deepEqual(reversal.impactedAdvances, ['A1']);
});

test('观测日之前的记录不可见：放款日晚于观测日不计入', () => {
  const state = computeState(ledger, 11);
  assert.equal(state.students.S2.pending.length, 0);
  assert.equal(state.students.S2.usableCents, 0);
  assert.equal(state.reversals.length, 0);
});
