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

/** 一摞内部怎么分：各件都称过就按重量分，否则件数均摊。 */
export type UnitSplitMode = 'byWeight' | 'equal';

export interface UnitSplit {
  mode: UnitSplitMode;
  rows: Array<{ id: number; feeFen: number }>;
}

/**
 * 把一摞的运费分到这一摞里的每一件，保证「每件加起来正好等于这一摞」。
 * 尾差按件摊给最前面几件各 1 分 —— 客户页面按件勾发货，件上的钱必须能拼回整摞。
 */
export function splitGroupFee(
  totalFeeFen: number,
  units: Array<{ id: number; weightG: number | null }>,
): UnitSplit {
  if (units.length === 0) return { mode: 'equal', rows: [] };
  const byWeight = units.every((u) => Number.isInteger(u.weightG) && (u.weightG as number) > 0);
  const split = allocate(totalFeeFen, units.map((u) => ({ id: u.id, weightG: byWeight ? (u.weightG as number) : 1 })));
  let remainder = split.diffFen;
  const rows = split.rows.map((r) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { id: r.id, feeFen: r.feeFen + extra };
  });
  return { mode: byWeight ? 'byWeight' : 'equal', rows };
}
