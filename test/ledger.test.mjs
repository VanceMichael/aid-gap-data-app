import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_LEDGER_DIR, latestObservableDay, loadLedger } from '../src/ledger.mjs';

async function withLedgerCopy(mutate) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
  await cp(DEFAULT_LEDGER_DIR, dir, { recursive: true });
  await mutate(dir);
  return dir;
}

test('台账可反复载入，快照彼此独立', async () => {
  const first = await loadLedger();
  const second = await loadLedger();
  assert.deepEqual(first, second);
  first.tables.charges[0].cents = 1;
  first.tables.transfers.splice(0, 1);
  assert.notEqual(second.tables.charges[0].cents, 1);
  assert.equal(second.tables.transfers.length, 5);
});

test('类型转换：金额为整数分，空确认日为 null，`-` 为 null', async () => {
  const { tables } = await loadLedger();
  const w4 = tables.transfers.find((w) => w.wire === 'W4');
  assert.equal(w4.confirmationDay, null);
  assert.equal(w4.cents, 210000);
  const w1 = tables.transfers.find((w) => w.wire === 'W1');
  assert.equal(w1.student, null);
  const c4 = tables.charges.find((c) => c.charge === 'C4');
  assert.equal(c4.amends, 'C1');
  assert.equal(c4.cents, -50000);
});

test('最晚可观测日作为默认当周', async () => {
  assert.equal(latestObservableDay(await loadLedger()), 22);
});

test('拆分合计超过汇总金额被拒绝', async () => {
  const dir = await withLedgerCopy(async (d) => {
    await writeFile(join(d, 'allocations.csv'), 'wire,student,cents,recognized_day,confirm_type\nW1,S1,390000,9,school\nW1,S2,150000,12,school\nW2,S3,180000,22,transfer-consent\nW3,S1,-40000,17,school\n');
  });
  await assert.rejects(() => loadLedger(dir), /超过汇总金额/);
});

test('负值回单必须指明所冲正的流水', async () => {
  const dir = await withLedgerCopy(async (d) => {
    await writeFile(join(d, 'transfers.csv'), 'wire,student,route,day,cents,confirmation_day,adjusts\nW1,-,school,6,400000,12,-\nW2,S3,student,8,250000,21,-\nW3,S1,school,13,-40000,17,-\nW4,S4,instant,19,210000,,-\nW5,S2,student,12,50000,,-\n');
  });
  await assert.rejects(() => loadLedger(dir), /冲正/);
});

test('正反回单不得互记：拆分方向与回单不一致被拒绝', async () => {
  const dir = await withLedgerCopy(async (d) => {
    await writeFile(join(d, 'allocations.csv'), 'wire,student,cents,recognized_day,confirm_type\nW1,S1,160000,9,school\nW1,S2,150000,12,school\nW2,S3,180000,22,transfer-consent\nW3,S1,40000,17,school\n');
  });
  await assert.rejects(() => loadLedger(dir), /正负/);
});

test('数值字段不是整数时指出表与行号', async () => {
  const dir = await withLedgerCopy(async (d) => {
    await writeFile(join(d, 'charges.csv'), 'charge,student,period,deadline,cents,known_day,amends\nC1,S1,1,20,三十万,1,-\nC2,S2,1,20,280000,1,-\nC3,S3,2,28,420000,2,-\nC4,S1,1,20,-50000,16,C1\nC5,S4,2,28,220000,2,-\n');
  });
  await assert.rejects(() => loadLedger(dir), /charges 第 2 行.*不是整数/);
});
