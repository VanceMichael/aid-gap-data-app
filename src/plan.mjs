// 周转安排：缴费窗汇总、额度占用、实际/预计缺口、垫付处置。
// 处置只依据已确认事实（拆分入账、确认减免、承诺有效期）；
// 历史预测只能提示，不能自动收走已答应的垫付。

export function computePlan(ledger, state, forecast) {
  const coverageByCharge = new Map(state.coverage.map((c) => [c.charge, c]));
  const chargeById = new Map(state.charges.map((c) => [c.id, c]));

  const projectedGapByCharge = new Map();
  for (const cov of state.coverage) {
    const inTime = forecast.inTimeByCharge.get(cov.charge) ?? 0;
    projectedGapByCharge.set(cov.charge, Math.max(0, cov.actualGapCents - inTime));
  }

  // 缴费窗：同一缴费期、同一截止日的账单归为一窗
  const windowMap = new Map();
  for (const cov of state.coverage) {
    const key = `${cov.period}|${cov.deadline}`;
    if (!windowMap.has(key)) {
      windowMap.set(key, {
        period: cov.period,
        deadline: cov.deadline,
        charges: [],
        receivedCents: 0,
        committedCents: 0,
        actualGapCents: 0,
        projectedGapCents: 0,
        forecastInTimeCents: 0,
      });
    }
    const win = windowMap.get(key);
    win.charges.push(cov.charge);
    win.receivedCents += cov.receivedCents;
    win.committedCents += cov.committedCents;
    win.actualGapCents += cov.actualGapCents;
    win.projectedGapCents += projectedGapByCharge.get(cov.charge);
    win.forecastInTimeCents += forecast.inTimeByCharge.get(cov.charge) ?? 0;
  }
  const windows = [...windowMap.values()].sort((a, b) => a.period - b.period || a.deadline - b.deadline);

  // 垫付处置：释放、暂缓、回收、继续、待审、失效
  const decisions = [];
  const recallPoolByCharge = new Map();
  for (const adv of state.advances) {
    const cov = coverageByCharge.get(adv.charge);
    const charge = chargeById.get(adv.charge);
    const base = { advance: adv.id, student: adv.student, charge: adv.charge, status: adv.status };
    if (!cov || !charge) {
      decisions.push({ ...base, action: '继续', reasons: ['账单在观测日不可见，暂不处置'] });
      continue;
    }
    const evidence = {
      wires: [...new Set((state.students[adv.student]?.usableParts ?? []).map((p) => p.wire))],
      adjustments: charge.adjustments.map((a) => a.id),
    };
    // 不含任何承诺的真实覆盖：拆分入账 + 已付垫付
    const realCents = cov.usableAssignedCents + cov.paidCents;
    if (adv.status === 'paid') {
      const pool = recallPoolByCharge.get(adv.charge) ?? Math.max(0, cov.receivedCents - cov.dueCents);
      const recall = Math.min(adv.amount, pool);
      recallPoolByCharge.set(adv.charge, pool - recall);
      if (recall > 0) {
        decisions.push({
          ...base,
          action: '回收',
          amountCents: recall,
          reasons: ['真实到账或确认减免已覆盖应缴，按实际周转状态回收已付垫付'],
          evidence,
        });
      } else {
        decisions.push({ ...base, action: '继续', reasons: ['已付垫付仍被实际缺口占用'] });
      }
    } else if (adv.status === 'committed') {
      if (realCents >= cov.dueCents) {
        decisions.push({
          ...base,
          action: '释放',
          amountCents: adv.amount,
          reasons: ['真实到账或确认减免已足额，承诺不再拨付'],
          evidence,
        });
      } else if (state.asOf > adv.toDay) {
        decisions.push({
          ...base,
          action: '释放',
          amountCents: adv.amount,
          reasons: [`承诺有效期至第 ${adv.toDay} 日，到期未付按约定释放`],
          evidence,
        });
      } else if (realCents + cov.pendingAssignedCents >= cov.dueCents) {
        decisions.push({
          ...base,
          action: '暂缓',
          reasons: ['有到账尚未确认可转缴，暂缓拨付，承诺与占用额度保留'],
          evidence: {
            ...evidence,
            pendingWires: (state.students[adv.student]?.pending ?? []).map((p) => p.wire),
          },
        });
      } else {
        decisions.push({ ...base, action: '继续', reasons: ['实际缺口仍在，承诺继续有效'] });
      }
    } else {
      if (state.asOf > adv.toDay) {
        decisions.push({ ...base, action: '失效', reasons: [`超过承诺有效期（第 ${adv.toDay} 日）未批复`] });
      } else if (realCents >= cov.dueCents) {
        decisions.push({
          ...base,
          action: '释放',
          amountCents: adv.amount,
          reasons: ['真实到账或确认减免已足额，无需再安排'],
          evidence,
        });
      } else {
        decisions.push({ ...base, action: '待审', reasons: ['缺口仍在，等待批复'], evidence });
      }
    }
  }

  const releasableByBudgetKey = new Map();
  for (const d of decisions) {
    if (d.action !== '释放' || d.status !== 'committed') continue;
    const adv = state.advances.find((a) => a.id === d.advance);
    if (!adv || adv.period === null) continue;
    const key = `${adv.period}|${adv.department}`;
    releasableByBudgetKey.set(key, (releasableByBudgetKey.get(key) ?? 0) + (d.amountCents ?? 0));
  }

  // 周转额度：paid 与 committed 占额，proposed 为待审
  const budgets = ledger.tables.budgets.map((b) => {
    const advances = state.advances.filter((a) => a.period === b.period && a.department === b.department);
    const paidCents = advances.filter((a) => a.status === 'paid').reduce((s, a) => s + a.amount, 0);
    const committedCents = advances.filter((a) => a.status === 'committed').reduce((s, a) => s + a.amount, 0);
    const remainingCents = b.totalCents - paidCents - committedCents;
    const gaps = state.coverage.filter((c) => c.period === b.period && c.department === b.department);
    let running = 0;
    const proposed = advances
      .filter((a) => a.status === 'proposed')
      .sort((a, b) => a.toDay - b.toDay || a.id.localeCompare(b.id))
      .map((a) => {
        running += a.amount;
        const inTimeItems = forecast.items.filter((it) => it.targetCharge === a.charge && it.inTime);
        return {
          advance: a.id,
          student: a.student,
          charge: a.charge,
          amountCents: a.amount,
          overQuota: running > remainingCents,
          basis: {
            chargeProjectedGapCents: projectedGapByCharge.get(a.charge) ?? null,
            forecastInTimeCents: inTimeItems.reduce((s, it) => s + it.cents, 0),
            forecastWires: inTimeItems.map((it) => it.wire),
            windowDeadline: coverageByCharge.get(a.charge)?.deadline ?? null,
            budgetRemainingCents: remainingCents,
          },
        };
      });
    return {
      period: b.period,
      department: b.department,
      totalCents: b.totalCents,
      paidCents,
      committedCents,
      remainingCents,
      releasableCents: releasableByBudgetKey.get(`${b.period}|${b.department}`) ?? 0,
      actualGapCents: gaps.reduce((s, c) => s + c.actualGapCents, 0),
      projectedGapCents: gaps.reduce((s, c) => s + (projectedGapByCharge.get(c.charge) ?? 0), 0),
      proposed,
    };
  });

  // 误记风险：按放款日口径看似已足额、按确认口径仍有缺口的人
  const naiveRisks = [];
  for (const cov of state.coverage) {
    const naiveCovered = cov.naiveAssignedCents + cov.paidCents + cov.committedCents;
    if (naiveCovered >= cov.dueCents && cov.confirmedCents < cov.dueCents) {
      naiveRisks.push({
        student: cov.student,
        charge: cov.charge,
        dueCents: cov.dueCents,
        naiveCoveredCents: naiveCovered,
        confirmedCents: cov.confirmedCents,
      });
    }
  }

  return { windows, budgets, decisions, naiveRisks, projectedGapByCharge };
}
