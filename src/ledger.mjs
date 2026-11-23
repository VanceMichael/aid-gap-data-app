import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLinks, parseTable } from '../tools/check-materials.mjs';

export const DEFAULT_LEDGER_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

// 原始字段名 -> 内部字段名
const RENAMES = new Map(Object.entries({
  known_day: 'knownDay',
  recognized_day: 'recognizedDay',
  confirmation_day: 'confirmationDay',
  available_day: 'availableDay',
  last_seen_day: 'lastSeenDay',
  release_day: 'releaseDay',
  from_day: 'fromDay',
  to_day: 'toDay',
  accepted_day: 'acceptedDay',
  new_deadline: 'newDeadline',
  total_cents: 'totalCents',
  confirm_type: 'confirmType',
}));

const INT_FIELDS = {
  charges: ['deadline', 'cents', 'known_day', 'period'],
  transfers: ['day', 'cents'],
  allocations: ['cents', 'recognized_day'],
  advances: ['amount', 'from_day', 'to_day'],
  budgets: ['total_cents', 'period'],
  history: ['release_day', 'last_seen_day', 'period'],
  enrolments: ['from_day', 'to_day', 'known_day'],
  'deadline-changes': ['accepted_day', 'new_deadline'],
};

const OPTIONAL_INT_FIELDS = {
  transfers: ['confirmation_day'],
  history: ['available_day'],
};

// `-` 表示不适用，转为 null
const DASH_FIELDS = {
  charges: ['amends'],
  transfers: ['student', 'adjusts'],
};

const ADVANCE_STATUSES = new Set(['paid', 'committed', 'proposed']);

function toInt(table, line, field, raw) {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${table} 第 ${line} 行 ${field} 不是整数：${raw === '' ? '(空)' : raw}`);
  }
  return Number.parseInt(raw, 10);
}

function convertRow(table, row, line) {
  const out = {};
  for (const [field, raw] of Object.entries(row)) {
    const name = RENAMES.get(field) ?? field;
    if ((INT_FIELDS[table] ?? []).includes(field)) {
      out[name] = toInt(table, line, field, raw);
    } else if ((OPTIONAL_INT_FIELDS[table] ?? []).includes(field)) {
      out[name] = raw === '' ? null : toInt(table, line, field, raw);
    } else if ((DASH_FIELDS[table] ?? []).includes(field)) {
      out[name] = raw === '-' ? null : raw;
    } else {
      out[name] = raw;
    }
  }
  return out;
}

function validateLedger(t) {
  const wires = new Map(t.transfers.map((w) => [w.wire, w]));

  t.transfers.forEach((w, i) => {
    const line = i + 2;
    if (w.cents === 0) throw new Error(`transfers 第 ${line} 行金额为零，无法对账`);
    if (w.cents < 0 && w.adjusts === null) {
      throw new Error(`transfers 第 ${line} 行为负值回单，须用 adjusts 指明所冲正的流水`);
    }
    if (w.confirmationDay !== null && w.confirmationDay < w.day) {
      throw new Error(`transfers 第 ${line} 行确认日早于放款日`);
    }
  });

  t.allocations.forEach((a, i) => {
    const line = i + 2;
    const wire = wires.get(a.wire);
    if (a.recognizedDay < wire.day) {
      throw new Error(`allocations 第 ${line} 行确认日早于 ${a.wire} 的放款日`);
    }
    if (Math.sign(a.cents) !== Math.sign(wire.cents)) {
      throw new Error(`allocations 第 ${line} 行与 ${a.wire} 的正负方向不一致，正反回单不得互记`);
    }
  });

  const splitTotals = new Map();
  for (const a of t.allocations) splitTotals.set(a.wire, (splitTotals.get(a.wire) ?? 0) + a.cents);
  for (const [wireId, total] of splitTotals) {
    const wire = wires.get(wireId);
    if (wire.cents > 0 && total > wire.cents) {
      throw new Error(`allocations 中 ${wireId} 的拆分合计超过汇总金额`);
    }
    if (wire.cents < 0 && total < wire.cents) {
      throw new Error(`allocations 中 ${wireId} 的冲正拆分超过原负值回单金额`);
    }
  }

  t.charges.forEach((c, i) => {
    if (c.cents < 0 && c.amends === null) {
      throw new Error(`charges 第 ${i + 2} 行为抵减，须用 amends 指明所抵账单`);
    }
  });

  t.advances.forEach((a, i) => {
    const line = i + 2;
    if (!ADVANCE_STATUSES.has(a.status)) {
      throw new Error(`advances 第 ${line} 行状态 ${a.status} 不是 paid/committed/proposed`);
    }
    if (a.amount <= 0) throw new Error(`advances 第 ${line} 行金额须为正数`);
    if (a.fromDay > a.toDay) throw new Error(`advances 第 ${line} 行有效期起日晚于止日`);
  });

  t.enrolments.forEach((e, i) => {
    if (e.fromDay > e.toDay) throw new Error(`enrolments 第 ${i + 2} 行学籍起日晚于止日`);
  });

  t.history.forEach((h, i) => {
    const line = i + 2;
    if (h.lastSeenDay < h.releaseDay) throw new Error(`history 第 ${line} 行观测截止日早于放款日`);
    if (h.availableDay !== null && h.availableDay < h.releaseDay) {
      throw new Error(`history 第 ${line} 行可用日早于放款日`);
    }
  });

  const budgetKeys = new Set();
  t.budgets.forEach((b, i) => {
    const key = `${b.period}|${b.department}`;
    if (budgetKeys.has(key)) throw new Error(`budgets 第 ${i + 2} 行与已有记录的缴费期、院系重复`);
    budgetKeys.add(key);
  });
}

/**
 * 载入台账。每次调用都重新读取并独立校验，资助人员可反复载入，
 * 返回的快照互不共享数据，改动一份不影响另一份。
 */
export async function loadLedger(dir = DEFAULT_LEDGER_DIR) {
  const format = JSON.parse(await readFile(join(dir, 'format.json'), 'utf8'));
  const raw = {};
  for (const [name, fields] of Object.entries(format.tables)) {
    const content = await readFile(join(dir, `${name}.csv`), 'utf8');
    raw[name] = parseTable(content, fields, name);
    if (raw[name].length === 0) throw new Error(`${name} 没有交接记录`);
  }
  checkLinks(raw, format.links);
  const tables = Object.fromEntries(
    Object.entries(raw).map(([name, rows]) => [name, rows.map((row, i) => convertRow(name, row, i + 2))]),
  );
  validateLedger(tables);
  return { tables };
}

/** 台账中最晚的可观测日，作为未指定观测日时的默认“当周”。 */
export function latestObservableDay(ledger) {
  const t = ledger.tables;
  const days = [
    ...t.transfers.map((w) => w.day),
    ...t.allocations.map((a) => a.recognizedDay),
    ...t.charges.map((c) => c.knownDay),
    ...t['deadline-changes'].map((d) => d.acceptedDay),
    ...t.advances.map((a) => a.fromDay),
    ...t.enrolments.map((e) => e.knownDay),
  ];
  return Math.max(...days);
}
