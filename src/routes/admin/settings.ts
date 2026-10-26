import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { directPriceFenPerKg, domesticFeeFen, intlPriceFenPerKg, setSetting } from '../../lib/db.ts';
import { badRequest, readJson } from '../../lib/http.ts';
import { toFen } from '../../lib/money.ts';

export const settingsRoutes = new Hono<{ Bindings: Env }>();

settingsRoutes.get('/', async (c) =>
  c.json({
    domesticFeeFen: await domesticFeeFen(c.env),
    intlPriceFenPerKg: await intlPriceFenPerKg(c.env),
    directPriceFenPerKg: await directPriceFenPerKg(c.env),
  }),
);

/**
 * 这两个数会乘进所有人的运费：单价 × 重量 ÷ 1000。
 * 手滑多打几个零（比如 9007199254740991 这种「安全的整数」）不会报错，
 * 但乘出来早就不精确了，分摊到每一摞的钱就是歪的，所以这里必须封顶。
 */
const MAX_DOMESTIC_FEN = 100000; // 国内一段，最多 1000 元
const MAX_INTL_PRICE_FEN = 100000; // 国际单价，最多 1000 元 / kg

function capFen(fen: number, label: string, max: number): number {
  if (fen > max) throw badRequest(`${label}太大了，最多 ${max} 分（${(max / 100).toFixed(0)} 元），检查一下是不是多打了零`);
  return fen;
}

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
    directPriceYuanPerKg?: unknown;
    directPriceFenPerKg?: unknown;
  }>(c);

  const out: { domesticFeeFen: number; intlPriceFenPerKg: number; directPriceFenPerKg: number } = {
    domesticFeeFen: await domesticFeeFen(c.env),
    intlPriceFenPerKg: await intlPriceFenPerKg(c.env),
    directPriceFenPerKg: await directPriceFenPerKg(c.env),
  };

  const hasDomestic =
    (body.domesticFeeFen !== undefined && body.domesticFeeFen !== null) ||
    body.domesticFeeYuan !== undefined;
  if (hasDomestic) {
    const fen = capFen(
      body.domesticFeeFen !== undefined && body.domesticFeeFen !== null
        ? requireFen(body.domesticFeeFen, '国内运费')
        : yuanToFenValue(body.domesticFeeYuan, '国内运费'),
      '国内运费',
      MAX_DOMESTIC_FEN,
    );
    await setSetting(c.env, 'domestic_fee_fen', String(fen));
    out.domesticFeeFen = fen;
  }

  const hasIntl =
    (body.intlPriceFenPerKg !== undefined && body.intlPriceFenPerKg !== null) ||
    body.intlPriceYuanPerKg !== undefined;
  if (hasIntl) {
    const fen = capFen(
      body.intlPriceFenPerKg !== undefined && body.intlPriceFenPerKg !== null
        ? requireFen(body.intlPriceFenPerKg, '国际运费单价')
        : yuanToFenValue(body.intlPriceYuanPerKg, '国际运费单价'),
      '国际运费单价',
      MAX_INTL_PRICE_FEN,
    );
    requirePositiveFen(fen, '国际运费单价');
    await setSetting(c.env, 'intl_price_fen_per_kg', String(fen));
    out.intlPriceFenPerKg = fen;
  }

  const hasDirect =
    (body.directPriceFenPerKg !== undefined && body.directPriceFenPerKg !== null) ||
    body.directPriceYuanPerKg !== undefined;
  if (hasDirect) {
    const fen = capFen(
      body.directPriceFenPerKg !== undefined && body.directPriceFenPerKg !== null
        ? requireFen(body.directPriceFenPerKg, '直邮单价')
        : yuanToFenValue(body.directPriceYuanPerKg, '直邮单价'),
      '直邮单价',
      MAX_INTL_PRICE_FEN,
    );
    requirePositiveFen(fen, '直邮单价');
    await setSetting(c.env, 'direct_price_fen_per_kg', String(fen));
    out.directPriceFenPerKg = fen;
  }

  if (!hasDomestic && !hasIntl && !hasDirect) throw badRequest('没有要保存的内容');
  return c.json(out);
});
