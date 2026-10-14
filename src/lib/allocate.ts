/**
 * 国际运费按重量分摊。
 *   W     = 各摞重量之和（包装箱重量因此按比例摊给了所有人）
 *   fee_i = floor(F × w_i / W)
 *   diff  = F − Σ fee_i   → 尾差由需求方承担，不加给任何客户
 */

export interface WeighInput {
  id: number;
  weightG: number;
}

export interface AllocationRow {
  id: number;
  weightG: number;
  /** 占比，0~1，仅用于展示 */
  share: number;
  feeFen: number;
}

export interface AllocationResult {
  totalWeightG: number;
  totalFeeFen: number;
  rows: AllocationRow[];
  /** 尾差（分），>= 0，记在需求方名下 */
  diffFen: number;
}

/**
 * 总价 = 总重量 × 单价（分 / kg）。先整数相乘再除，避免浮点误差；不足 1 分四舍五入。
 * 群主的口径：国际运费单价基本固定（默认 100 元/kg），称完重量金额就出来了，不用每次手填。
 */
export function feeFromWeight(totalWeightG: number, priceFenPerKg: number): number {
  if (!Number.isInteger(totalWeightG) || totalWeightG < 0) {
    throw new Error('总重量必须是整数克');
  }
  if (!Number.isInteger(priceFenPerKg) || priceFenPerKg < 0) {
    throw new Error('运费单价必须是整数分 / kg');
  }
  return Math.round((totalWeightG * priceFenPerKg) / 1000);
}

export function allocate(totalFeeFen: number, groups: WeighInput[]): AllocationResult {
  if (!Number.isInteger(totalFeeFen) || totalFeeFen < 0) {
    throw new Error('国际运费必须是非负整数（分）');
  }
  if (groups.length === 0) {
    throw new Error('没有可分摊的称重组');
  }
  for (const g of groups) {
    if (!Number.isInteger(g.weightG) || g.weightG <= 0) {
      throw new Error('每一摞都必须填写大于 0 的重量（克）');
    }
  }
  const totalWeightG = groups.reduce((sum, g) => sum + g.weightG, 0);
  const rows = groups.map((g) => ({
    id: g.id,
    weightG: g.weightG,
    share: g.weightG / totalWeightG,
    feeFen: Math.floor((totalFeeFen * g.weightG) / totalWeightG),
  }));
  const diffFen = totalFeeFen - rows.reduce((sum, r) => sum + r.feeFen, 0);
  return { totalWeightG, totalFeeFen, rows, diffFen };
}
