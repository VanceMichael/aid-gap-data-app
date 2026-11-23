// 按路径回看历史确认时滞，为未确认到账给出可用性区间。
// 历史案例按 last_seen_day 截断：观测截止仍未结清的，按未结清处理（只提供时滞下限）。

export function routeOutlooks(history) {
  const byRoute = new Map();
  for (const h of history) {
    if (!byRoute.has(h.route)) byRoute.set(h.route, { route: h.route, settled: [], censored: [] });
    const outlook = byRoute.get(h.route);
    if (h.availableDay !== null && h.availableDay <= h.lastSeenDay) {
      outlook.settled.push({ case: h.case, lag: h.availableDay - h.releaseDay });
    } else {
      outlook.censored.push({ case: h.case, minLag: h.lastSeenDay - h.releaseDay });
    }
  }
  for (const outlook of byRoute.values()) {
    outlook.settled.sort((a, b) => a.lag - b.lag || a.case.localeCompare(b.case));
    outlook.censored.sort((a, b) => a.minLag - b.minLag || a.case.localeCompare(b.case));
    outlook.support = outlook.settled.length;
    outlook.minLag = outlook.support > 0 ? outlook.settled[0].lag : null;
    outlook.maxLag = outlook.support > 0 ? outlook.settled[outlook.settled.length - 1].lag : null;
    // 存在比已结清最长时滞更久仍未结清的案例时，区间上限开放
    outlook.upperOpen =
      outlook.support === 0 || outlook.censored.some((c) => c.minLag > outlook.maxLag);
  }
  return byRoute;
}

// 学生的待核到账 -> 下一截止日账单的可用性预测
export function forecastPending(ledger, state) {
  const outlooks = routeOutlooks(ledger.tables.history);
  const coverageByStudent = new Map();
  for (const cov of state.coverage) {
    const list = coverageByStudent.get(cov.student) ?? [];
    list.push(cov);
    coverageByStudent.set(cov.student, list);
  }
  const items = [];
  const warnings = [];
  for (const [student, studentState] of Object.entries(state.students)) {
    // 目标账单：真实覆盖（拆分入账+已付垫付）仍有缺口的下一截止日账单，
    // 承诺不算真实覆盖，否则被承诺盖住的账单拿不到到账预测
    const gaps = (coverageByStudent.get(student) ?? []).filter(
      (c) => c.dueCents - c.receivedCents > 0,
    );
    const target = gaps.find((c) => c.deadline >= state.asOf) ?? gaps[0] ?? null;
    for (const pending of studentState.pending) {
      const outlook = outlooks.get(pending.route);
      if (!outlook || outlook.support === 0) {
        warnings.push(
          `放款方式 ${pending.route} 无对应历史，${student} 的 ${pending.wire}（${pending.cents} 分）能否及时到账需经办人人工核实`,
        );
        items.push({
          wire: pending.wire,
          student,
          cents: pending.cents,
          route: pending.route,
          day: pending.day,
          targetCharge: target?.charge ?? null,
          deadline: target?.deadline ?? null,
          earliestDay: null,
          latestDay: null,
          inTime: false,
          upperOpen: true,
          support: 0,
          settledLags: [],
          censoredCount: outlook?.censored.length ?? 0,
        });
        continue;
      }
      const earliestDay = pending.day + outlook.minLag;
      const latestDay = pending.day + outlook.maxLag;
      items.push({
        wire: pending.wire,
        student,
        cents: pending.cents,
        route: pending.route,
        day: pending.day,
        targetCharge: target?.charge ?? null,
        deadline: target?.deadline ?? null,
        earliestDay,
        latestDay,
        inTime: target !== null && latestDay <= target.deadline,
        upperOpen: outlook.upperOpen,
        support: outlook.support,
        settledLags: outlook.settled.map((s) => s.lag),
        censoredCount: outlook.censored.length,
      });
    }
  }
  const inTimeByCharge = new Map();
  for (const item of items) {
    if (item.inTime && item.targetCharge !== null) {
      inTimeByCharge.set(item.targetCharge, (inTimeByCharge.get(item.targetCharge) ?? 0) + item.cents);
    }
  }
  return { items, warnings, inTimeByCharge };
}
