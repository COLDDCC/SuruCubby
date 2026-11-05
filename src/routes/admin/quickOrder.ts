import { Hono } from 'hono';
import { startInBackground } from '../../lib/imageJobs.ts';
import type { Env } from '../../lib/env.ts';
import { badRequest, bound, intList, notFound, optionalString, placeholders, readJson, requireInt } from '../../lib/http.ts';
import { nextId, nowIso } from '../../lib/db.ts';
import { toJpy } from '../../lib/money.ts';
import { isHttpUrl, liveImageUrl, surugaCode, surugaImageCandidates } from '../../lib/images.ts';
import { beijingDay } from '../../lib/parcels.ts';
import { buildNameIndex, matchName } from '../../lib/nameMatch.ts';

export const quickOrderRoutes = new Hono<{ Bindings: Env }>();

interface Line {
  url?: unknown;
  title?: unknown;
  priceJpy?: unknown;
  qty?: unknown;
  imageUrl?: unknown;
}

/**
 * 直接往某一位客户的仓库里录东西，不走整张 Excel：
 *   kind = 'buy'      这位客户单独下单：贴骏河屋链接（可带价格），一行一件；
 *   kind = 'forward'  不是群主买的、从别处转运来的：只要名称 / 图片 + 单号，货款记 0。
 * 每次录入都是一个独立的「订单」，仓库拿订单号或运单号就能进门。
 */
quickOrderRoutes.post('/', async (c) => {
  const body = await readJson<{
    customerId?: unknown;
    kind?: unknown;
    batchName?: unknown;
    orderNo?: unknown;
    japanTrackingNo?: unknown;
    shop?: unknown;
    orderedAt?: unknown;
    release?: unknown;
    lines?: unknown;
  }>(c);
  const customerId = requireInt(body.customerId, '客户');
  const forward = body.kind === 'forward';
  const db = c.env.DB;
  const customer = await db.prepare('SELECT id, nickname FROM customers WHERE id = ?').bind(customerId).first<{ id: number; nickname: string }>();
  if (!customer) throw notFound('客户不存在');
  if (!Array.isArray(body.lines) || body.lines.length === 0) throw badRequest('至少录一件');
  if (body.lines.length > 200) throw badRequest('一次最多录 200 行');

  const orderNo = bound(optionalString(body.orderNo), '日本订单号', 60);
  const japanTrackingNo = bound(optionalString(body.japanTrackingNo), forward ? '转运单号' : '日本运单号', 60);
  if (forward && !orderNo && !japanTrackingNo) throw badRequest('转运的东西要填一个单号，仓库靠它找到这批货');
  const at = nowIso();
  const day = beijingDay(at);
  const shop = bound(optionalString(body.shop) ?? (forward ? '转运' : null), '来源店铺', 40);
  const batchName = bound(optionalString(body.batchName) ?? `${customer.nickname} ${forward ? '转运' : '单独下单'} ${day}`, '订单名', 60) as string;
  const orderedAt = bound(optionalString(body.orderedAt) ?? (forward ? null : day), '下单日期', 30);
  // 转运的东西不欠群主货款，录进来就放行；自己下单的照「先收钱再放行」，默认不放
  const release = forward || body.release === true;

  type Row = { title: string; productUrl: string | null; imageUrl: string | null; priceJpy: number };
  const rows: Row[] = [];
  let checks = 0;
  for (const [index, raw] of (body.lines as Line[]).entries()) {
    const n = index + 1;
    const url = optionalString(raw?.url);
    if (url && !isHttpUrl(url)) throw badRequest(`第 ${n} 行的链接不是 http 开头`);
    let imageUrl = optionalString(raw?.imageUrl);
    if (imageUrl && !isHttpUrl(imageUrl)) throw badRequest(`第 ${n} 行的图片地址不是 http 开头`);
    const code = url ? surugaCode(url) : '';
    const title = bound(optionalString(raw?.title) ?? (code ? `骏河屋 ${code}` : url), `第 ${n} 行的名称`, 200);
    if (!title) throw badRequest(`第 ${n} 行既没有链接也没有名称`);
    let priceJpy = 0;
    if (!forward && raw?.priceJpy !== undefined && raw?.priceJpy !== null && raw?.priceJpy !== '') {
      const p = toJpy(raw.priceJpy);
      if (p === null || p < 0) throw badRequest(`第 ${n} 行的价格看不懂：${String(raw.priceJpy)}`);
      if (p > 10_000_000) throw badRequest(`第 ${n} 行的价格太大了`);
      priceJpy = p;
    }
    const qty = raw?.qty === undefined || raw?.qty === null || raw?.qty === '' ? 1 : Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw badRequest(`第 ${n} 行的数量要是 1 到 50`);
    // 没给图片就按货号拼骏河屋的图，取得到才用（一次最多试 30 个，免得请求太久）
    if (!imageUrl && url && checks < 30) {
      for (const candidate of surugaImageCandidates(url)) {
        checks += 1;
        imageUrl = await liveImageUrl(candidate).catch(() => null);
        if (imageUrl) break;
      }
    }
    for (let k = 0; k < qty; k += 1) rows.push({ title, productUrl: url, imageUrl, priceJpy });
  }

  const batchId = await nextId(db, 'batches');
  const packageId = await nextId(db, 'packages');
  let itemId = await nextId(db, 'items');
  const stmts: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO batches (id, name, ordered_at, source_file, created_at, order_no, shop, japan_tracking_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(batchId, batchName, orderedAt, forward ? '转运录入' : '单客户录入', at, orderNo, shop, japanTrackingNo),
    db.prepare("INSERT INTO packages (id, name, status, created_at) VALUES (?, ?, 'ordered', ?)").bind(packageId, batchName, at),
    db.prepare('INSERT INTO package_batches (package_id, batch_id) VALUES (?, ?)').bind(packageId, batchId),
  ];
  rows.forEach((r, i) => {
    stmts.push(
      db
        .prepare(
          `INSERT INTO items (id, batch_id, customer_id, package_id, row_no, title, image_url, product_url, actual_price_jpy, goods_fee_jpy,
                              status, goods_paid, released_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ordered', ?, ?, ?, ?)`,
        )
        .bind(itemId, batchId, customerId, packageId, i + 1, r.title, r.imageUrl, r.productUrl, forward ? null : r.priceJpy, r.priceJpy, forward ? 1 : 0, release ? at : null, at, at),
      db.prepare("INSERT INTO status_logs (item_id, from_status, to_status, at) VALUES (?, NULL, 'ordered', ?)").bind(itemId, at),
    );
    itemId += 1;
  });
  await db.batch(stmts);
  startInBackground(c, batchId);
  return c.json({ ok: true, batchId, packageId, itemCount: rows.length, released: release, withImage: rows.filter((r) => r.imageUrl).length });
});

/**
 * 群主点客户名字放行：这些东西才出现在客户自己的仓库里。undo = 收回（客户那边又看不到了）。
 * 传 itemIds，或者传 batchId（+ 可选 customerId）放行这一单里这个人 / 所有人的东西。
 */
quickOrderRoutes.post('/release', async (c) => {
  const body = await readJson<{ itemIds?: unknown; batchId?: unknown; customerId?: unknown; undo?: boolean }>(c);
  const db = c.env.DB;
  let ids: number[];
  if (body.itemIds !== undefined) {
    ids = intList(body.itemIds, '东西');
  } else {
    const batchId = requireInt(body.batchId, '订单');
    const customerId = body.customerId === undefined || body.customerId === null ? null : requireInt(body.customerId, '客户');
    const rows = await db
      .prepare(`SELECT id FROM items WHERE batch_id = ? AND (? IS NULL OR customer_id = ?)`)
      .bind(batchId, customerId, customerId)
      .all<{ id: number }>();
    ids = rows.results.map((r) => r.id);
  }
  if (ids.length === 0) throw badRequest('没有要放行的东西');
  const at = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    stmts.push(
      body.undo
        ? db.prepare(`UPDATE items SET released_at = NULL WHERE id IN (${placeholders(chunk.length)})`).bind(...chunk)
        : db.prepare(`UPDATE items SET released_at = ? WHERE released_at IS NULL AND id IN (${placeholders(chunk.length)})`).bind(at, ...chunk),
    );
  }
  const results = await db.batch(stmts);
  const changed = results.reduce((s, r) => s + (r.meta?.changes ?? 0), 0);
  return c.json({ ok: true, count: changed });
});

/**
 * 直邮名单导入：表里一行一个人（名字 / QQ + 收货地址），预演之后确认才写库。
 * 认人和团购表同一套：QQ 优先，没有 QQ 就按名字（含别名、全角半角差异）认；认不准的不猜。
 */
quickOrderRoutes.post('/direct-roster', async (c) => {
  const body = await readJson<{ rows?: unknown; commit?: boolean }>(c);
  if (!Array.isArray(body.rows) || body.rows.length === 0) throw badRequest('名单是空的');
  if (body.rows.length > 2000) throw badRequest('一次最多 2000 行');
  const db = c.env.DB;
  const index = await buildNameIndex(db);
  const results: Array<{ row: number; name: string; qq: string; address: string; customerId: number | null; nickname: string | null; problem: string | null }> = [];
  for (const [i, raw] of (body.rows as Array<Record<string, unknown>>).entries()) {
    const name = String(raw?.name ?? '').trim();
    const qq = String(raw?.qq ?? '').trim();
    const address = String(raw?.address ?? '').trim();
    const out = { row: i + 1, name, qq, address, customerId: null as number | null, nickname: null as string | null, problem: null as string | null };
    if (address.length > 300) out.problem = '地址太长了（最多 300 字）';
    if (!name && !qq) out.problem = '名字和 QQ 都是空的';
    if (!out.problem && qq) {
      const hit = await db.prepare('SELECT id, nickname FROM customers WHERE qq = ?').bind(qq).first<{ id: number; nickname: string }>();
      if (hit) Object.assign(out, { customerId: hit.id, nickname: hit.nickname });
    }
    if (!out.problem && out.customerId === null && name) {
      const m = matchName(index, name);
      if (m.customer) Object.assign(out, { customerId: m.customer.id, nickname: m.customer.nickname });
      else if (m.by === 'ambiguous') out.problem = `好几个人都叫这个：${m.candidates.map((x) => x.nickname).join('、')}，填上 QQ 再导`;
    }
    if (!out.problem && out.customerId === null) out.problem = '客户名单里没有这个人，先去「客户 → 导入名单」建上';
    results.push(out);
  }
  const ok = results.filter((r) => r.customerId !== null && !r.problem);
  if (body.commit) {
    const stmts = ok.map((r) =>
      r.address
        ? db.prepare("UPDATE customers SET ship_mode = 'direct', direct_address = ? WHERE id = ?").bind(r.address, r.customerId)
        : db.prepare("UPDATE customers SET ship_mode = 'direct' WHERE id = ?").bind(r.customerId),
    );
    if (stmts.length) await db.batch(stmts);
  }
  return c.json({ committed: !!body.commit, matched: ok.length, problems: results.length - ok.length, rows: results });
});
