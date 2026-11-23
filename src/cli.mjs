#!/usr/bin/env node
// 用法：
//   node src/cli.mjs handler  [--as-of N] [--fixtures DIR]   经办视图（默认）
//   node src/cli.mjs student  --student S1 [--as-of N]       学生视图
//   node src/cli.mjs forecast [--as-of N]                    未确认到账的可用性预测
// 每次执行都重新载入台账；同一观测日重复执行结果一致，可重现对外告知的结论。
import { DEFAULT_LEDGER_DIR, latestObservableDay, loadLedger } from './ledger.mjs';
import { computeState } from './availability.mjs';
import { forecastPending, routeOutlooks } from './forecast.mjs';
import { computePlan } from './plan.mjs';
import { handlerView, studentView } from './views.mjs';

function parseArgs(argv) {
  const options = { command: null, asOf: null, fixtures: DEFAULT_LEDGER_DIR, student: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--as-of') options.asOf = Number.parseInt(argv[++i], 10);
    else if (arg === '--fixtures') options.fixtures = argv[++i];
    else if (arg === '--student') options.student = argv[++i];
    else if (!arg.startsWith('--') && options.command === null) options.command = arg;
    else throw new Error(`无法识别的参数：${arg}`);
  }
  options.command ??= 'handler';
  if (options.asOf !== null && !Number.isInteger(options.asOf)) {
    throw new Error('--as-of 须为整数日序号');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ledger = await loadLedger(options.fixtures);
  const asOf = options.asOf ?? latestObservableDay(ledger);
  const state = computeState(ledger, asOf);

  if (options.command === 'student') {
    if (!options.student) throw new Error('student 视图需要 --student 指定学生编号');
    console.log(JSON.stringify(studentView(state, options.student), null, 2));
    return;
  }
  if (options.command === 'forecast') {
    const forecast = forecastPending(ledger, state);
    console.log(JSON.stringify({ 观测日: asOf, 路径历史: [...routeOutlooks(ledger.tables.history).values()], ...forecast }, null, 2));
    return;
  }
  if (options.command === 'handler') {
    const forecast = forecastPending(ledger, state);
    const plan = computePlan(ledger, state, forecast);
    console.log(JSON.stringify(handlerView(ledger, state, forecast, plan), null, 2));
    return;
  }
  throw new Error(`未知命令：${options.command}（可用 handler / student / forecast）`);
}

main().catch((error) => {
  console.error(`核算失败：${error.message}`);
  process.exitCode = 1;
});
