import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { domesticFeeFen, intlPriceFenPerKg, setSetting } from '../../lib/db.ts';
import { badRequest, readJson } from '../../lib/http.ts';
import { toFen } from '../../lib/money.ts';

export const settingsRoutes = new Hono<{ Bindings: Env }>();

settingsRoutes.get('/', async (c) =>
  c.json({
    domesticFeeFen: await domesticFeeFen(c.env),
    intlPriceFenPerKg: await intlPriceFenPerKg(c.env),
  }),
);

/** 页面上填的是「元」，进来先按元换算 */
function yuanToFenValue(value: unknown, label: string): number {
  const fen = toFen(value);
  if (fen === null || fen < 0) throw badRequest(`${label}金额不合法`);
  return fen;
}

/** 键名带 Fen 的入参已经是「分」，不能再乘 100 */
function requireFen(value: unknown, label: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw badRequest(`${label}金额不合法`);
  return n;
}

/** 单价为 0 会把一整箱运费静默算成 0 元，拦住；国内运费填 0 是「不收」，允许。 */
function requirePositiveFen(value: number, label: string): number {
  if (value <= 0) throw badRequest(`${label}要大于 0`);
  return value;
}

settingsRoutes.post('/', async (c) => {
  const body = await readJson<{
    domesticFeeYuan?: unknown;
    domesticFeeFen?: unknown;
    intlPriceYuanPerKg?: unknown;
    intlPriceFenPerKg?: unknown;
  }>(c);

  const out: { domesticFeeFen: number; intlPriceFenPerKg: number } = {
    domesticFeeFen: await domesticFeeFen(c.env),
    intlPriceFenPerKg: await intlPriceFenPerKg(c.env),
  };

  const hasDomestic =
    (body.domesticFeeFen !== undefined && body.domesticFeeFen !== null) ||
    body.domesticFeeYuan !== undefined;
  if (hasDomestic) {
    const fen =
      body.domesticFeeFen !== undefined && body.domesticFeeFen !== null
        ? requireFen(body.domesticFeeFen, '国内运费')
        : yuanToFenValue(body.domesticFeeYuan, '国内运费');
    await setSetting(c.env, 'domestic_fee_fen', String(fen));
    out.domesticFeeFen = fen;
  }

  const hasIntl =
    (body.intlPriceFenPerKg !== undefined && body.intlPriceFenPerKg !== null) ||
    body.intlPriceYuanPerKg !== undefined;
  if (hasIntl) {
    const fen =
      body.intlPriceFenPerKg !== undefined && body.intlPriceFenPerKg !== null
        ? requireFen(body.intlPriceFenPerKg, '国际运费单价')
        : yuanToFenValue(body.intlPriceYuanPerKg, '国际运费单价');
    requirePositiveFen(fen, '国际运费单价');
    await setSetting(c.env, 'intl_price_fen_per_kg', String(fen));
    out.intlPriceFenPerKg = fen;
  }

  if (!hasDomestic && !hasIntl) throw badRequest('没有要保存的内容');
  return c.json(out);
});
