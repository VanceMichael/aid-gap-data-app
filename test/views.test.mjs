import assert from 'node:assert/strict';
import test from 'node:test';
import { computeState } from '../src/availability.mjs';
import { forecastPending } from '../src/forecast.mjs';
import { loadLedger } from '../src/ledger.mjs';
import { computePlan } from '../src/plan.mjs';
import { handlerView, studentView } from '../src/views.mjs';

const ledger = await loadLedger();

function buildViews(asOf) {
  const state = computeState(ledger, asOf);
  const forecast = forecastPending(ledger, state);
  const plan = computePlan(ledger, state, forecast);
  return { state, forecast, plan };
}

test('学生视图只含本人应缴、已可用款、学校垫付、待核原因', () => {
  const { state } = buildViews(22);
  const view = studentView(state, 'S1');
  assert.deepEqual(Object.keys(view), ['学生', '观测日', '应缴', '已可用款', '学校垫付', '待核']);
  const text = JSON.stringify(view);
  for (const other of ['S2', 'S3', 'S4']) assert.ok(!text.includes(other), `不应出现 ${other}`);
  assert.equal(view.应缴[0].应缴分, 250000);
  assert.equal(view.应缴[0].抵减[0].来源, '学籍异动退费');
  assert.equal(view.已可用款.合计分, 120000);
  assert.equal(view.学校垫付[0].垫付, 'A1');
  // 学生看不到额度、预测，也看不到他人的回单
  assert.ok(!text.includes('额度'));
  for (const wire of ['W2', 'W4', 'W5']) assert.ok(!text.includes(wire), `不应出现 ${wire}`);
});

test('学生视图列出本人待核原因', () => {
  const { state } = buildViews(22);
  const view = studentView(state, 'S2');
  assert.deepEqual(view.待核, [{ 回单: 'W5', 金额分: 50000, 原因: '学生账户已到账，待确认可转缴' }]);
  assert.equal(view.应缴[0].截止日, 24);
  assert.equal(view.应缴[0].原截止日, 20);
});

test('学生视图对未知学生报错', () => {
  const { state } = buildViews(22);
  assert.throws(() => studentView(state, 'S99'), /S99/);
});

test('经办视图可按当周证据重现：同一观测日重算结果一致', () => {
  const first = handlerView(ledger, ...(() => { const v = buildViews(18); return [v.state, v.forecast, v.plan]; })());
  const second = handlerView(ledger, ...(() => { const v = buildViews(18); return [v.state, v.forecast, v.plan]; })());
  assert.deepEqual(first, second);
  assert.ok(first.证据.账单.includes('C1'));
  assert.ok(first.证据.抵减.includes('C4'));
  assert.ok(first.证据.回单.includes('W3'));
  assert.ok(first.证据.历史案例.length > 0);
});

test('经办视图按缴费窗核对实收、承诺与可继续安排的金额', () => {
  const { state, forecast, plan } = buildViews(22);
  const view = handlerView(ledger, state, forecast, plan);
  const window = view.缴费窗.find((w) => w.缴费期 === 1 && w.截止日 === 24);
  assert.equal(window.实收分, 150000);
  assert.equal(window.承诺分, 60000);
  assert.equal(window.实际缺口分, 70000);
  const budget = view.周转额度.find((b) => b.缴费期 === 1);
  assert.equal(budget.剩余分, 30000);
  assert.equal(budget.释放后可用分, 90000);
  // 冲正影响到的后续安排可见
  assert.deepEqual(view.冲正影响[0].影响的后续安排, ['A1']);
  // 新放款方式提醒可见
  assert.ok(view.提醒.some((w) => w.includes('instant')));
});
