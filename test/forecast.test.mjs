import assert from 'node:assert/strict';
import test from 'node:test';
import { computeState } from '../src/availability.mjs';
import { forecastPending, routeOutlooks } from '../src/forecast.mjs';
import { loadLedger } from '../src/ledger.mjs';

const ledger = await loadLedger();

test('各路径历史时滞：已结清给出区间，未结清按观测日截断', () => {
  const outlooks = routeOutlooks(ledger.tables.history);
  const school = outlooks.get('school');
  assert.equal(school.support, 21);
  assert.equal(school.minLag, 1);
  assert.equal(school.maxLag, 15);
  assert.equal(school.censored.length, 1);
  // H7 截至观测日（第 18 日）仍未结清，时滞下限 15 未超过已结清最长 15，上限不开放
  assert.deepEqual(school.censored, [{ case: 'H7', minLag: 15 }]);
  assert.equal(school.upperOpen, false);
  const student = outlooks.get('student');
  assert.equal(student.support, 15);
  assert.equal(student.minLag, 5);
  assert.equal(student.maxLag, 14);
  assert.equal(student.censored.length, 7);
  assert.equal(student.upperOpen, true);
  assert.equal(outlooks.has('instant'), false);
});

test('可用日晚于观测截止的历史案例按未结清处理', () => {
  const outlooks = routeOutlooks([
    { case: 'X1', route: 'r', period: -1, releaseDay: 5, lastSeenDay: 9, availableDay: 12 },
    { case: 'X2', route: 'r', period: -1, releaseDay: 1, lastSeenDay: 20, availableDay: 4 },
  ]);
  const r = outlooks.get('r');
  assert.equal(r.support, 1);
  assert.deepEqual(r.settled, [{ case: 'X2', lag: 3 }]);
  assert.deepEqual(r.censored, [{ case: 'X1', minLag: 4 }]);
  assert.equal(r.upperOpen, true);
});

test('未确认到账按下一截止日给出可用性区间与历史支撑', () => {
  const state = computeState(ledger, 22);
  const forecast = forecastPending(ledger, state);
  const w5 = forecast.items.find((i) => i.wire === 'W5');
  assert.equal(w5.targetCharge, 'C2');
  assert.equal(w5.deadline, 24);
  assert.equal(w5.earliestDay, 17);
  assert.equal(w5.latestDay, 26);
  assert.equal(w5.inTime, false);
  assert.equal(w5.support, 15);
  const w2 = forecast.items.find((i) => i.wire === 'W2');
  assert.equal(w2.targetCharge, 'C3');
  assert.equal(w2.inTime, true);
  assert.equal(w2.latestDay <= w2.deadline, true);
  assert.equal(forecast.inTimeByCharge.get('C3'), 70000);
});

test('放款方式无对应历史时提醒经办人，且不计入预计可及时到账', () => {
  const state = computeState(ledger, 22);
  const forecast = forecastPending(ledger, state);
  const w4 = forecast.items.find((i) => i.wire === 'W4');
  assert.equal(w4.inTime, false);
  assert.equal(w4.support, 0);
  assert.equal(w4.earliestDay, null);
  assert.ok(forecast.warnings.some((w) => w.includes('instant') && w.includes('W4') && w.includes('S4')));
  assert.equal(forecast.inTimeByCharge.get('C5') ?? 0, 0);
});
