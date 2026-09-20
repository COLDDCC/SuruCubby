import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { domesticFeeFen, setSetting } from '../../lib/db.ts';
import { badRequest, readJson } from '../../lib/http.ts';
import { toFen } from '../../lib/money.ts';

export const settingsRoutes = new Hono<{ Bindings: Env }>();

settingsRoutes.get('/', async (c) => c.json({ domesticFeeFen: await domesticFeeFen(c.env) }));

settingsRoutes.post('/', async (c) => {
  const body = await readJson<{ domesticFeeYuan?: unknown; domesticFeeFen?: unknown }>(c);
  let fen: number | null = null;
  if (body.domesticFeeFen !== undefined && body.domesticFeeFen !== null) {
    fen = Number(body.domesticFeeFen);
  } else if (body.domesticFeeYuan !== undefined) {
    fen = toFen(body.domesticFeeYuan);
  }
  if (fen === null || !Number.isInteger(fen) || fen < 0) throw badRequest('国内运费金额不合法');
  await setSetting(c.env, 'domestic_fee_fen', String(fen));
  return c.json({ domesticFeeFen: fen });
});
