import assert from 'node:assert/strict';
import test from 'node:test';
import { computeState } from '../src/availability.mjs';
import { forecastPending } from '../src/forecast.mjs';
import { loadLedger } from '../src/ledger.mjs';
import { computePlan } from '../src/plan.mjs';

const ledger = await loadLedger();

function makeLedger(tables) {
  return {
    tables: {
      charges: [],
      transfers: [],
      allocations: [],
      advances: [],
      budgets: [],
      history: [],
      enrolments: [],
      'deadline-changes': [],
      ...tables,
    },
  };
}

function planOf(ledgerLike, asOf) {
  const state = computeState(ledgerLike, asOf);
  const forecast = forecastPending(ledgerLike, state);
  return { state, forecast, plan: computePlan(ledgerLike, state, forecast) };
}

const BASE = {
  enrolments: [{ student: 'S9', department: 'office', program: 'UG', fromDay: 1, toDay: 40, knownDay: 1 }],
  charges: [{ charge: 'C9', student: 'S9', period: 1, deadline: 30, cents: 100000, knownDay: 1, amends: null }],
  budgets: [{ period: 1, department: 'office', totalCents: 100000 }],
};

test('额度占用：paid 与 committed 占额，proposed 待审，缺口分实际与预计两列', () => {
  const { plan } = planOf(ledger, 22);
  const [b1, b2] = plan.budgets;
  assert.equal(b1.paidCents, 80000);
  assert.equal(b1.committedCents, 60000);
  assert.equal(b1.remainingCents, 30000);
  assert.equal(b1.actualGapCents, 120000);
  assert.equal(b2.remainingCents, 160000);
  assert.equal(b2.actualGapCents, 460000);
  assert.equal(b2.projectedGapCents, 390000);
  assert.equal(b2.proposed.length, 1);
  assert.equal(b2.proposed[0].overQuota, false);
  assert.equal(b2.proposed[0].basis.chargeProjectedGapCents, 170000);
  assert.deepEqual(b2.proposed[0].basis.forecastWires, ['W2']);
});

test('承诺到期未付可以释放，释放额度可见但预测不自动收走承诺', () => {
  const day18 = planOf(ledger, 18);
  const a2at18 = day18.plan.decisions.find((d) => d.advance === 'A2');
  assert.equal(a2at18.action, '继续');
  const day22 = planOf(ledger, 22);
  const a2 = day22.plan.decisions.find((d) => d.advance === 'A2');
  assert.equal(a2.action, '释放');
  assert.ok(a2.reasons[0].includes('到期未付'));
  const b1 = day22.plan.budgets[0];
  assert.equal(b1.releasableCents, 60000);
});

test('有到账待确认时承诺暂缓而非释放，额度仍占用', () => {
  const synthetic = makeLedger({
    ...BASE,
    transfers: [
      { wire: 'W8', student: 'S9', route: 'school', day: 3, cents: 60000, confirmationDay: 5, adjusts: null },
      { wire: 'W9', student: 'S9', route: 'student', day: 4, cents: 50000, confirmationDay: null, adjusts: null },
    ],
    allocations: [{ wire: 'W8', student: 'S9', cents: 60000, recognizedDay: 5, confirmType: 'school' }],
    advances: [{ advance: 'A9', student: 'S9', charge: 'C9', amount: 40000, fromDay: 1, toDay: 25, status: 'committed' }],
    history: [{ case: 'H1', route: 'student', period: -1, releaseDay: 1, lastSeenDay: 30, availableDay: 10 }],
  });
  const { forecast, plan } = planOf(synthetic, 10);
  // 历史预测认为 W9 可及时到账，但承诺只能暂缓，不能被收走
  assert.equal(forecast.inTimeByCharge.get('C9'), 50000);
  const decision = plan.decisions.find((d) => d.advance === 'A9');
  assert.equal(decision.action, '暂缓');
  assert.equal(plan.budgets[0].committedCents, 40000);
  assert.equal(plan.budgets[0].releasableCents, 0);
});

test('仅有预测、没有真实到账时承诺继续有效', () => {
  const synthetic = makeLedger({
    ...BASE,
    transfers: [{ wire: 'W8', student: 'S9', route: 'school', day: 3, cents: 60000, confirmationDay: 5, adjusts: null }],
    allocations: [{ wire: 'W8', student: 'S9', cents: 60000, recognizedDay: 5, confirmType: 'school' }],
    advances: [{ advance: 'A9', student: 'S9', charge: 'C9', amount: 40000, fromDay: 1, toDay: 25, status: 'committed' }],
    history: [{ case: 'H1', route: 'student', period: -1, releaseDay: 1, lastSeenDay: 30, availableDay: 10 }],
  });
  const { plan } = planOf(synthetic, 10);
  assert.equal(plan.decisions.find((d) => d.advance === 'A9').action, '继续');
});

test('真实到账足额后承诺释放，已付垫付按超出部分回收', () => {
  const committed = makeLedger({
    ...BASE,
    transfers: [{ wire: 'W8', student: 'S9', route: 'school', day: 3, cents: 100000, confirmationDay: 5, adjusts: null }],
    allocations: [{ wire: 'W8', student: 'S9', cents: 100000, recognizedDay: 5, confirmType: 'school' }],
    advances: [{ advance: 'A9', student: 'S9', charge: 'C9', amount: 40000, fromDay: 1, toDay: 25, status: 'committed' }],
  });
  const released = planOf(committed, 10).plan.decisions.find((d) => d.advance === 'A9');
  assert.equal(released.action, '释放');
  assert.ok(released.reasons[0].includes('已足额'));

  const paid = makeLedger({
    ...BASE,
    transfers: [{ wire: 'W8', student: 'S9', route: 'school', day: 3, cents: 100000, confirmationDay: 5, adjusts: null }],
    allocations: [{ wire: 'W8', student: 'S9', cents: 100000, recognizedDay: 5, confirmType: 'school' }],
    advances: [{ advance: 'A9', student: 'S9', charge: 'C9', amount: 60000, fromDay: 1, toDay: 25, status: 'paid' }],
  });
  const recalled = planOf(paid, 10).plan.decisions.find((d) => d.advance === 'A9');
  assert.equal(recalled.action, '回收');
  assert.equal(recalled.amountCents, 60000);
});

test('确认减免生效后按实际周转状态回收，依据可查明', () => {
  const synthetic = makeLedger({
    ...BASE,
    charges: [
      { charge: 'C9', student: 'S9', period: 1, deadline: 30, cents: 100000, knownDay: 1, amends: null },
      { charge: 'C9R', student: 'S9', period: 1, deadline: 30, cents: -40000, knownDay: 8, amends: 'C9' },
    ],
    transfers: [{ wire: 'W8', student: 'S9', route: 'school', day: 3, cents: 20000, confirmationDay: 5, adjusts: null }],
    allocations: [{ wire: 'W8', student: 'S9', cents: 20000, recognizedDay: 5, confirmType: 'school' }],
    advances: [{ advance: 'A9', student: 'S9', charge: 'C9', amount: 60000, fromDay: 1, toDay: 25, status: 'paid' }],
  });
  const { state, plan } = planOf(synthetic, 10);
  // 减免生效后应缴 60000，实收 80000，回收超出的 20000
  assert.equal(state.charges.find((c) => c.id === 'C9').dueCents, 60000);
  const decision = plan.decisions.find((d) => d.advance === 'A9');
  assert.equal(decision.action, '回收');
  assert.equal(decision.amountCents, 20000);
  assert.deepEqual(decision.evidence.adjustments, ['C9R']);
  assert.deepEqual(decision.evidence.wires, ['W8']);
});

test('待审候选超过额度时给出待批依据', () => {
  const synthetic = makeLedger({
    ...BASE,
    advances: [
      { advance: 'A1', student: 'S9', charge: 'C9', amount: 80000, fromDay: 1, toDay: 25, status: 'paid' },
      { advance: 'A2', student: 'S9', charge: 'C9', amount: 30000, fromDay: 1, toDay: 25, status: 'proposed' },
    ],
  });
  const { plan } = planOf(synthetic, 10);
  const [proposed] = plan.budgets[0].proposed;
  assert.equal(proposed.overQuota, true);
  assert.equal(proposed.basis.budgetRemainingCents, 20000);
  assert.equal(proposed.basis.chargeProjectedGapCents, 20000);
  assert.equal(proposed.basis.windowDeadline, 30);
});

test('误记风险：按放款日口径足额、按确认口径仍有缺口的人被标出', () => {
  const synthetic = makeLedger({
    ...BASE,
    transfers: [{ wire: 'W9', student: 'S9', route: 'student', day: 5, cents: 100000, confirmationDay: null, adjusts: null }],
  });
  const { plan } = planOf(synthetic, 10);
  assert.equal(plan.naiveRisks.length, 1);
  assert.deepEqual(plan.naiveRisks[0], {
    student: 'S9',
    charge: 'C9',
    dueCents: 100000,
    naiveCoveredCents: 100000,
    confirmedCents: 0,
  });
});

test('待审超过承诺有效期未批则失效', () => {
  const synthetic = makeLedger({
    ...BASE,
    advances: [{ advance: 'A9', student: 'S9', charge: 'C9', amount: 40000, fromDay: 1, toDay: 10, status: 'proposed' }],
  });
  const { plan } = planOf(synthetic, 11);
  assert.equal(plan.decisions.find((d) => d.advance === 'A9').action, '失效');
});
