# 助学款到账缺口与校内周转额度

业务资料均为合成记录。表头字段及跨表引用见 `fixtures/format.json`。

## 数据说明

钱均为整数分，day 是学期开始以来的日期序号。charges 负数表示抵减，同一 charge 的截止日以资助中心确认的延期为准；减免在 known_day 前不能花用。transfers 的 cents 是汇总金额，可用金额以 allocations 和用途确认日为准。正反银行回单不得互相复制成另一学生的已收款。空到账日表示观察结果仍开放，历史时点按 last_seen_day 截断。
支出以 budget 所在缴费期的额度计算，paid 与 committed 占额，proposed 为待审。已付垫款的回收以真实到账或确认减免为依据，承诺到期未付可以释放。经手台账只列 synthetic student 编号。

CSV 使用 UTF-8、逗号分隔，无引号与内嵌换行。未提供的字段是空字符串，作为关系值的 `-` 表示不适用。多值字段用竖线分隔，数值和日期单位见业务约定。

## 资料检查

使用 Node.js 22.23.4，依赖仅为 Node.js 标准库。运行 `npm ci --ignore-scripts --offline` 准备工作区。

运行 `npm run check:materials` 检查合成交接资料的字段与记录引用。运行 `npm test` 检查交接资料的读取和校验。
