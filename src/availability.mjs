// 按观测日核算台账状态：应缴、可用款、待核、冲正影响。
// 所有结论只依赖观测日（含）之前可观察到的记录，同一观测日重算结果一致。

const PENDING_REASONS = {
  student: '学生账户已到账，待确认可转缴',
  school: '学校专户到账，待拆分确认',
};

function pendingReason(route) {
  return PENDING_REASONS[route] ?? `放款方式 ${route} 到账，待确认`;
}

// 把一笔可用款按截止日先后摊到学生的各笔账单上
function assignToCharges(chargeEntries, usableCents) {
  let remaining = usableCents;
  const assigned = new Map();
  for (const entry of chargeEntries) {
    const use = Math.min(Math.max(0, entry.dueCents), Math.max(0, remaining));
    remaining -= use;
    assigned.set(entry.id, use);
  }
  return assigned;
}

function sumBy(list, pick) {
  return list.reduce((sum, item) => sum + pick(item), 0);
}

export function computeState(ledger, asOf) {
  const tables = ledger.tables;
  const charges = tables.charges.filter((c) => c.knownDay <= asOf);
  const wires = tables.transfers.filter((w) => w.day <= asOf);
  const allocations = tables.allocations.filter((a) => a.recognizedDay <= asOf);
  const advances = tables.advances.filter((a) => a.fromDay <= asOf);
  const deadlineChanges = tables['deadline-changes'].filter((d) => d.acceptedDay <= asOf);
  const enrolments = tables.enrolments.filter((e) => e.knownDay <= asOf);
  const warnings = [];

  const wireById = new Map(tables.transfers.map((w) => [w.wire, w]));

  // 学籍：以观测日前最新已知记录为准；晚到的异动记录用于标注退费来源
  const enrolmentsByStudent = new Map();
  for (const row of enrolments) {
    const list = enrolmentsByStudent.get(row.student) ?? [];
    list.push(row);
    enrolmentsByStudent.set(row.student, list);
  }
  const departmentOf = new Map();
  const enrolmentChangeDays = new Map();
  for (const [student, rows] of enrolmentsByStudent) {
    rows.sort((a, b) => a.knownDay - b.knownDay);
    departmentOf.set(student, rows[rows.length - 1].department);
    const firstKnown = rows[0].knownDay;
    enrolmentChangeDays.set(
      student,
      new Set(rows.filter((r) => r.knownDay > firstKnown).map((r) => r.knownDay)),
    );
  }

  // 应缴账：抵减并入原账单（只减应缴，不当现金），截止日以确认的延期为准
  const visibleChargeIds = new Set(charges.map((c) => c.charge));
  const adjustmentsByParent = new Map();
  for (const row of charges.filter((c) => c.amends !== null)) {
    if (!visibleChargeIds.has(row.amends)) {
      warnings.push(`抵减 ${row.charge} 的原账单 ${row.amends} 在观测日不可见，暂未并入`);
      continue;
    }
    const list = adjustmentsByParent.get(row.amends) ?? [];
    list.push(row);
    adjustmentsByParent.set(row.amends, list);
  }
  const chargeEntries = [];
  for (const row of charges.filter((c) => c.amends === null)) {
    const adjustments = (adjustmentsByParent.get(row.charge) ?? [])
      .map((a) => ({
        id: a.charge,
        cents: a.cents,
        knownDay: a.knownDay,
        source: (enrolmentChangeDays.get(row.student) ?? new Set()).has(a.knownDay)
          ? '学籍异动退费'
          : a.cents < 0
            ? '减免'
            : '补账',
      }))
      .sort((a, b) => a.knownDay - b.knownDay || a.id.localeCompare(b.id));
    const accepted = deadlineChanges
      .filter((d) => d.charge === row.charge)
      .sort((a, b) => a.acceptedDay - b.acceptedDay);
    const last = accepted[accepted.length - 1] ?? null;
    chargeEntries.push({
      id: row.charge,
      student: row.student,
      period: row.period,
      department: departmentOf.get(row.student) ?? null,
      baseCents: row.cents,
      adjustments,
      dueCents: row.cents + sumBy(adjustments, (a) => a.cents),
      dueBeforeAdjustments: row.cents,
      deadline: last ? last.newDeadline : row.deadline,
      originalDeadline: row.deadline,
      deadlineChange: last ? { acceptedDay: last.acceptedDay, newDeadline: last.newDeadline } : null,
    });
  }
  chargeEntries.sort((a, b) => a.deadline - b.deadline || a.id.localeCompare(b.id));
  const chargeById = new Map(chargeEntries.map((c) => [c.id, c]));

  const studentIds = new Set();
  for (const e of enrolments) studentIds.add(e.student);
  for (const c of chargeEntries) studentIds.add(c.student);
  for (const w of wires) if (w.student !== null) studentIds.add(w.student);
  for (const a of allocations) studentIds.add(a.student);
  for (const a of advances) studentIds.add(a.student);
  const students = [...studentIds].sort();

  // 可用款：以拆分（学校入账/个人确认）为准，冲正为负值冲减；
  // 未拆分的批量余款与未确认的学生账户到账都不算可用
  const usablePartsByStudent = new Map(students.map((s) => [s, []]));
  for (const a of allocations) {
    const wire = wireById.get(a.wire);
    usablePartsByStudent.get(a.student)?.push({
      wire: a.wire,
      cents: a.cents,
      recognizedDay: a.recognizedDay,
      confirmType: a.confirmType,
      route: wire.route,
    });
  }
  for (const parts of usablePartsByStudent.values()) {
    parts.sort((a, b) => a.recognizedDay - b.recognizedDay || a.wire.localeCompare(b.wire));
  }

  const pendingByStudent = new Map(students.map((s) => [s, []]));
  const unallocated = [];
  for (const w of wires) {
    if (w.cents <= 0) continue;
    const allocated = sumBy(allocations.filter((a) => a.wire === w.wire), (a) => a.cents);
    const remainder = w.cents - allocated;
    if (remainder <= 0) continue;
    if (w.student !== null) {
      pendingByStudent.get(w.student)?.push({
        wire: w.wire,
        cents: remainder,
        route: w.route,
        day: w.day,
        reason: pendingReason(w.route),
      });
    } else {
      unallocated.push({
        wire: w.wire,
        cents: remainder,
        route: w.route,
        day: w.day,
        note: '批量汇款未拆分部分，不能当作学生已足额',
      });
    }
  }

  // 误记对照口径：把银行放款日当作学生已可用日（仅用于提示风险，不参与核算）
  const naiveByStudent = new Map(students.map((s) => [s, 0]));
  for (const w of wires) {
    if (w.student !== null) {
      naiveByStudent.set(w.student, naiveByStudent.get(w.student) + w.cents);
    } else {
      for (const a of allocations.filter((x) => x.wire === w.wire)) {
        naiveByStudent.set(a.student, (naiveByStudent.get(a.student) ?? 0) + a.cents);
      }
    }
  }

  const advanceEntries = advances
    .map((a) => {
      const charge = chargeById.get(a.charge);
      if (!charge) warnings.push(`垫付 ${a.id} 的账单 ${a.charge} 在观测日不可见，未纳入额度占用`);
      return {
        id: a.advance,
        student: a.student,
        charge: a.charge,
        amount: a.amount,
        fromDay: a.fromDay,
        toDay: a.toDay,
        status: a.status,
        period: charge?.period ?? null,
        department: charge?.department ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const coverage = [];
  const studentsState = {};
  for (const student of students) {
    const parts = usablePartsByStudent.get(student) ?? [];
    const usableCents = sumBy(parts, (p) => p.cents);
    const pending = pendingByStudent.get(student) ?? [];
    let pendingRemaining = sumBy(pending, (p) => p.cents);
    const myCharges = chargeEntries.filter((c) => c.student === student);
    const usableAssigned = assignToCharges(myCharges, usableCents);
    const naiveAssigned = assignToCharges(myCharges, naiveByStudent.get(student) ?? 0);
    const myAdvances = advanceEntries.filter((a) => a.student === student);
    for (const charge of myCharges) {
      const ofCharge = (status) =>
        sumBy(myAdvances.filter((a) => a.charge === charge.id && a.status === status), (a) => a.amount);
      const paid = ofCharge('paid');
      const committed = ofCharge('committed');
      const proposed = ofCharge('proposed');
      const use = usableAssigned.get(charge.id) ?? 0;
      const confirmed = use + paid + committed;
      const gap = Math.max(0, charge.dueCents - confirmed);
      // 待核到账按“不算承诺”的口径摊入，用于判断暂缓，不计入实收
      const pendingAssigned = Math.min(Math.max(0, charge.dueCents - use - paid), pendingRemaining);
      pendingRemaining -= pendingAssigned;
      coverage.push({
        charge: charge.id,
        student,
        period: charge.period,
        department: charge.department,
        deadline: charge.deadline,
        dueCents: charge.dueCents,
        usableAssignedCents: use,
        paidCents: paid,
        committedCents: committed,
        proposedCents: proposed,
        receivedCents: use + paid,
        confirmedCents: confirmed,
        actualGapCents: gap,
        pendingAssignedCents: pendingAssigned,
        naiveAssignedCents: naiveAssigned.get(charge.id) ?? 0,
      });
    }
    studentsState[student] = {
      usableCents,
      usableParts: parts,
      pending,
      naiveUsableCents: naiveByStudent.get(student) ?? 0,
      advances: myAdvances,
    };
  }

  // 冲正/补单：沿 adjusts 找回原流水，辨明哪些后续安排受到影响
  const reversals = [];
  for (const w of wires.filter((x) => x.adjusts !== null)) {
    const effects = allocations
      .filter((a) => a.wire === w.wire)
      .map((a) => ({ student: a.student, cents: a.cents, recognizedDay: a.recognizedDay }));
    const effectByStudent = new Map();
    for (const e of effects) effectByStudent.set(e.student, (effectByStudent.get(e.student) ?? 0) + e.cents);
    const impacted = new Set();
    for (const [student, cents] of effectByStudent) {
      const myCharges = chargeEntries.filter((c) => c.student === student);
      const usableNow = studentsState[student]?.usableCents ?? 0;
      const withEffect = assignToCharges(myCharges, usableNow);
      const withoutEffect = assignToCharges(myCharges, usableNow - cents);
      for (const charge of myCharges) {
        if ((withEffect.get(charge.id) ?? 0) !== (withoutEffect.get(charge.id) ?? 0)) {
          for (const a of advanceEntries) {
            if (a.student === student && a.charge === charge.id) impacted.add(a.id);
          }
        }
      }
    }
    reversals.push({
      wire: w.wire,
      adjusts: w.adjusts,
      day: w.day,
      cents: w.cents,
      effects,
      impactedAdvances: [...impacted].sort(),
    });
  }
  reversals.sort((a, b) => a.wire.localeCompare(b.wire));

  coverage.sort((a, b) => a.deadline - b.deadline || a.charge.localeCompare(b.charge));

  return {
    asOf,
    charges: chargeEntries,
    students: studentsState,
    advances: advanceEntries,
    coverage,
    unallocated,
    reversals,
    warnings,
  };
}
