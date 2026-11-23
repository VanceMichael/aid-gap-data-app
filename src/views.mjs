// 对外视图：学生只看自己的应缴、已可用款、学校垫付、待核原因；
// 经办按缴费窗核对实收、承诺与可继续安排的金额，并附当周证据以便重现。

export function studentView(state, student) {
  const studentState = state.students[student];
  if (!studentState) throw new Error(`学生 ${student} 不在台账中`);
  return {
    学生: student,
    观测日: state.asOf,
    应缴: state.charges
      .filter((c) => c.student === student)
      .map((c) => ({
        账单: c.id,
        缴费期: c.period,
        截止日: c.deadline,
        应缴分: c.dueCents,
        抵减: c.adjustments.map((a) => ({ 账单: a.id, 金额分: a.cents, 生效日: a.knownDay, 来源: a.source })),
        ...(c.deadlineChange ? { 原截止日: c.originalDeadline } : {}),
      })),
    已可用款: {
      合计分: studentState.usableCents,
      明细: studentState.usableParts.map((p) => ({
        回单: p.wire,
        金额分: p.cents,
        确认日: p.recognizedDay,
        确认方式: p.confirmType,
      })),
    },
    学校垫付: studentState.advances.map((a) => ({
      垫付: a.id,
      账单: a.charge,
      金额分: a.amount,
      状态: a.status,
      有效期自: a.fromDay,
      有效期至: a.toDay,
    })),
    待核: studentState.pending.map((p) => ({ 回单: p.wire, 金额分: p.cents, 原因: p.reason })),
  };
}

export function handlerView(ledger, state, forecast, plan) {
  const coverageByCharge = new Map(state.coverage.map((c) => [c.charge, c]));
  const evidenceWires = new Set();
  const evidenceSplits = new Set();
  for (const [student, studentState] of Object.entries(state.students)) {
    for (const p of studentState.usableParts) {
      evidenceWires.add(p.wire);
      evidenceSplits.add(`${p.wire}:${student}`);
    }
    for (const p of studentState.pending) evidenceWires.add(p.wire);
  }
  for (const u of state.unallocated) evidenceWires.add(u.wire);
  for (const r of state.reversals) evidenceWires.add(r.wire);

  return {
    观测日: state.asOf,
    缴费窗: plan.windows.map((w) => ({
      缴费期: w.period,
      截止日: w.deadline,
      账单: w.charges.map((id) => {
        const cov = coverageByCharge.get(id);
        return {
          账单: id,
          学生: cov.student,
          应缴分: cov.dueCents,
          实收分: cov.receivedCents,
          承诺分: cov.committedCents,
          实际缺口分: cov.actualGapCents,
          预计缺口分: plan.projectedGapByCharge.get(id),
          预计可及时到账分: forecast.inTimeByCharge.get(id) ?? 0,
        };
      }),
      实收分: w.receivedCents,
      承诺分: w.committedCents,
      实际缺口分: w.actualGapCents,
      预计缺口分: w.projectedGapCents,
    })),
    周转额度: plan.budgets.map((b) => ({
      缴费期: b.period,
      院系: b.department,
      总额分: b.totalCents,
      已付占用分: b.paidCents,
      承诺占用分: b.committedCents,
      剩余分: b.remainingCents,
      释放后可用分: b.remainingCents + b.releasableCents,
      实际缺口分: b.actualGapCents,
      预计缺口分: b.projectedGapCents,
      待审: b.proposed.map((p) => ({
        垫付: p.advance,
        学生: p.student,
        账单: p.charge,
        金额分: p.amountCents,
        超额度: p.overQuota,
        待批依据: {
          账单预计缺口分: p.basis.chargeProjectedGapCents,
          预计可及时到账分: p.basis.forecastInTimeCents,
          依据回单: p.basis.forecastWires,
          窗口截止日: p.basis.windowDeadline,
          当前额度剩余分: p.basis.budgetRemainingCents,
        },
      })),
    })),
    未分配款: state.unallocated.map((u) => ({
      回单: u.wire,
      金额分: u.cents,
      路径: u.route,
      放款日: u.day,
      说明: u.note,
    })),
    冲正影响: state.reversals.map((r) => ({
      回单: r.wire,
      冲正自: r.adjusts,
      放款日: r.day,
      金额分: r.cents,
      影响: r.effects.map((e) => ({ 学生: e.student, 金额分: e.cents, 确认日: e.recognizedDay })),
      影响的后续安排: r.impactedAdvances,
    })),
    处置: plan.decisions.map((d) => ({
      垫付: d.advance,
      学生: d.student,
      账单: d.charge,
      状态: d.status,
      处置: d.action,
      ...(d.amountCents !== undefined ? { 金额分: d.amountCents } : {}),
      理由: d.reasons,
      ...(d.evidence ? { 依据: d.evidence } : {}),
    })),
    误记风险: plan.naiveRisks.map((r) => ({
      学生: r.student,
      账单: r.charge,
      应缴分: r.dueCents,
      按放款日口径覆盖分: r.naiveCoveredCents,
      实际确认覆盖分: r.confirmedCents,
      说明: '若把银行放款日当作可用日，该生会从周转名单误消失',
    })),
    预计到账: forecast.items.map((it) => ({
      回单: it.wire,
      学生: it.student,
      金额分: it.cents,
      路径: it.route,
      放款日: it.day,
      目标账单: it.targetCharge,
      截止日: it.deadline,
      最早可用日: it.earliestDay,
      最晚可用日: it.latestDay,
      可及时到账: it.inTime,
      上限开放: it.upperOpen,
      历史支撑案例数: it.support,
    })),
    提醒: [...state.warnings, ...forecast.warnings],
    证据: {
      账单: state.charges.map((c) => c.id),
      抵减: state.charges.flatMap((c) => c.adjustments.map((a) => a.id)),
      回单: [...evidenceWires].sort(),
      拆分: [...evidenceSplits].sort(),
      垫付: state.advances.map((a) => a.id),
      延期账单: state.charges.filter((c) => c.deadlineChange).map((c) => c.id),
      学籍: Object.keys(state.students),
      历史案例: ledger.tables.history.map((h) => h.case),
    },
  };
}
