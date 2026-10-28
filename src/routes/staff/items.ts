import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { notFound, requireInt } from '../../lib/http.ts';
import { buildItemDetail } from '../../lib/itemDetail.ts';
import { searchItems } from '../../lib/itemSearch.ts';
import { staffOf } from '../../lib/staff.ts';

/** 物品详情：管理员和日本仓都能看；价格和付款状态只给管理员。 */
export const staffItemRoutes = new Hono<{ Bindings: Env }>();

/** 找货：日本仓也要能对货号。货号尾号、名称、cn、客户名、日本运单号 / 订单号都认。 */
staffItemRoutes.get('/search', async (c) => {
  return c.json({ items: await searchItems(c.env.DB, c.req.query('q') ?? '') });
});

staffItemRoutes.get('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '物品 ID');
  const detail = await buildItemDetail(c.env.DB, id, { money: staffOf(c).role === 'admin' });
  if (!detail) throw notFound('没有这件东西');
  return c.json(detail);
});
