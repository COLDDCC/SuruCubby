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
