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

function toIntFen(value: unknown, label: string): number {
  const fen = toFen(value);
  if (fen === null || fen < 0) throw badRequest(`${label}金额不合法`);
  return fen;
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
        ? toIntFen(body.domesticFeeFen, '国内运费')
        : toIntFen(body.domesticFeeYuan, '国内运费');
    await setSetting(c.env, 'domestic_fee_fen', String(fen));
    out.domesticFeeFen = fen;
  }

  const hasIntl =
    (body.intlPriceFenPerKg !== undefined && body.intlPriceFenPerKg !== null) ||
    body.intlPriceYuanPerKg !== undefined;
  if (hasIntl) {
    const fen =
      body.intlPriceFenPerKg !== undefined && body.intlPriceFenPerKg !== null
        ? toIntFen(body.intlPriceFenPerKg, '国际运费单价')
        : toIntFen(body.intlPriceYuanPerKg, '国际运费单价');
    await setSetting(c.env, 'intl_price_fen_per_kg', String(fen));
    out.intlPriceFenPerKg = fen;
  }

  if (!hasDomestic && !hasIntl) throw badRequest('没有要保存的内容');
  return c.json(out);
});
