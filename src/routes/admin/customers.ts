import { Hono } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, notFound, optionalString, readJson, requireInt, requireString } from '../../lib/http.ts';
import { isSelfReturn, nextId, nowIso, statusLogStmt } from '../../lib/db.ts';
import { randomToken } from '../../lib/crypto.ts';
import { hashPassword, passwordProblem } from '../../lib/password.ts';
import { buildCustomerView } from '../../lib/customerView.ts';
import { buildNameIndex, matchName } from '../../lib/nameMatch.ts';

export const customerRoutes = new Hono<{ Bindings: Env }>();

interface RosterRow {
  qq?: string;
  nickname?: string;
  realName?: string;
}

/** 库里已有的人，名单导入时既拿来判重，也当名字索引用 */
interface RosterCustomer {
  id: number;
  qq: string;
  nickname: string;
  token: string;
  realName: string | null;
}

customerRoutes.get('/', async (c) => {
  const q = c.req.query('q')?.trim() ?? '';
  const like = `%${q}%`;
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.qq, c.nickname, c.real_name AS realName, c.token, c.note, c.self_return AS selfReturn, c.created_at AS createdAt,
            c.password_hash IS NULL AS passwordInitial,
            (SELECT COUNT(*) FROM items i WHERE i.customer_id = c.id) AS itemCount,
            (SELECT COUNT(*) FROM items i WHERE i.customer_id = c.id AND i.status = 'cn_stock') AS stockCount,
            (SELECT COALESCE(SUM(i.goods_fee_jpy), 0) FROM items i
              WHERE i.customer_id = c.id AND i.goods_paid = 0 AND i.status NOT IN ('cancelled','refunded')) AS goodsUnpaidJpy,
            (SELECT COALESCE(SUM(g.intl_fee_fen - COALESCE((SELECT SUM(i.intl_fee_fen) FROM items i WHERE i.weigh_group_id=g.id AND i.intl_paid=1),0)), 0) FROM weigh_groups g
              WHERE g.customer_id = c.id AND g.fee_paid = 0 AND g.intl_fee_fen IS NOT NULL) AS intlUnpaidFen,
            (SELECT COALESCE(SUM(s.fee_fen), 0) FROM shipments s
              WHERE s.customer_id = c.id AND s.fee_paid = 0) AS domesticUnpaidFen
       FROM customers c
      WHERE (? = '' OR c.qq LIKE ? OR c.nickname LIKE ? OR c.real_name LIKE ?
             OR EXISTS (SELECT 1 FROM customer_aliases a WHERE a.customer_id = c.id AND a.alias LIKE ?))
      ORDER BY c.nickname`,
  )
    .bind(q, like, like, like, like)
    .all();
  return c.json({ customers: rows.results });
});

customerRoutes.post('/', async (c) => {
  const body = await readJson<{
    qq?: string;
    nickname?: string;
    realName?: string;
    note?: string;
    alias?: string;
  }>(c);
  const qq = requireString(body.qq, 'QQ 号');
  if (!/^\d{5,15}$/.test(qq)) throw badRequest('QQ 号格式不对');
  const nickname = requireString(body.nickname, '昵称');
  const db = c.env.DB;
  const exists = await db.prepare('SELECT id FROM customers WHERE qq = ?').bind(qq).first();
  if (exists) throw badRequest('这个 QQ 号已经有客户了');
  const id = await nextId(db, 'customers');
  const token = randomToken();
  // 表里写的既可能是昵称也可能是另一个叫法，两个都得登记，不然下次导入认不出这个人
  const aliases = [...new Set([nickname, optionalString(body.alias)].filter((x): x is string => !!x))];
  await db.batch([
    db
      .prepare(
        'INSERT INTO customers (id, qq, nickname, token, note, real_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(id, qq, nickname, token, optionalString(body.note), optionalString(body.realName), nowIso()),
    ...aliases.map((alias) =>
      db.prepare('INSERT OR IGNORE INTO customer_aliases (alias, customer_id) VALUES (?, ?)').bind(alias, id),
    ),
  ]);
  return c.json({ id, token });
});

/**
 * 名单导入：把攒了很久的「名字 + QQ（+ 真名）」一次灌进来，不用一个个点。
 * dryRun 只出结果不写库，确认没问题再来一次真写。
 * 名字已经有主的情况一律不动手：宁可让你去核对，也不把一个客户的名字挪到另一个客户身上。
 */
customerRoutes.post('/import', async (c) => {
  const body = await readJson<{ fileName?: string; dryRun?: boolean; rows?: RosterRow[] }>(c);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) throw badRequest('名单里没有内容');
  if (rows.length > 2000) throw badRequest('一份名单最多 2000 行，多了分开导');

  const db = c.env.DB;
  const index = await buildNameIndex(db);
  const byQq = new Map<string, RosterCustomer>();
  for (let offset = 0; ; offset += 100) {
    const page = await db
      .prepare('SELECT id, qq, nickname, token, real_name AS realName FROM customers ORDER BY id LIMIT 100 OFFSET ?')
      .bind(offset)
      .all<RosterCustomer>();
    for (const row of page.results) byQq.set(row.qq, row);
    if (page.results.length < 100) break;
  }

  const created: Array<{ qq: string; nickname: string; realName: string | null }> = [];
  const updated: Array<{ qq: string; nickname: string; addedNames: string[]; realNameFilled: boolean }> = [];
  const conflicts: Array<{ row: number; qq: string; nickname: string; reason: string }> = [];
  const errors: Array<{ row: number; reason: string }> = [];
  const statements: D1PreparedStatement[] = [];

  let nextCustomerId = await nextId(db, 'customers');
  const now = nowIso();

  for (let i = 0; i < rows.length; i += 1) {
    const rowNo = i + 2; // 第 1 行是表头，报错好对得上 Excel
    const raw = rows[i];
    const qq = optionalString(raw?.qq) ?? '';
    const nickname = optionalString(raw?.nickname) ?? '';
    const realName = optionalString(raw?.realName);
    if (!qq && !nickname) continue; // 整行空着，跳过
    if (!qq) {
      errors.push({ row: rowNo, reason: `「${nickname}」没有 QQ 号，光靠名字认不出人` });
      continue;
    }
    if (!/^\d{5,15}$/.test(qq)) {
      errors.push({ row: rowNo, reason: `QQ 号「${qq}」不像 QQ 号` });
      continue;
    }
    if (!nickname) {
      errors.push({ row: rowNo, reason: `QQ ${qq} 这一行没有名字` });
      continue;
    }

    const nameHit = matchName(index, nickname);
    const ownerByQq = byQq.get(qq);
    const ownerByName = nameHit.customer;

    if (nameHit.by === 'ambiguous') {
      conflicts.push({
        row: rowNo,
        qq,
        nickname,
        reason: `「${nickname}」和好几个客户都对得上（${nameHit.candidates.map((x) => `${x.nickname} QQ ${x.qq}`).join('、')}）`,
      });
      continue;
    }
    if (ownerByQq && ownerByName && ownerByName.id !== ownerByQq.id) {
      conflicts.push({
        row: rowNo,
        qq,
        nickname,
        reason: `QQ ${qq} 是「${ownerByQq.nickname}」，但名字「${nickname}」已经是 ${ownerByName.nickname}（QQ ${ownerByName.qq}）的`,
      });
      continue;
    }
    if (!ownerByQq && ownerByName) {
      conflicts.push({
        row: rowNo,
        qq,
        nickname,
        reason: `「${nickname}」已经是 ${ownerByName.nickname}（QQ ${ownerByName.qq}）的名字，再按 QQ ${qq} 建就成了两个同名人`,
      });
      continue;
    }

    if (ownerByQq) {
      // 这个人已经在库里：把表里的写法补成名字，真名只在空着的时候填
      const added: string[] = [];
      if (!index.exact.has(nickname)) {
        added.push(nickname);
        index.exact.set(nickname, ownerByQq);
        statements.push(
          db.prepare('INSERT OR IGNORE INTO customer_aliases (alias, customer_id) VALUES (?, ?)').bind(nickname, ownerByQq.id),
        );
      }
      let realNameFilled = false;
      if (realName && !ownerByQq.realName) {
        realNameFilled = true;
        ownerByQq.realName = realName;
        statements.push(db.prepare('UPDATE customers SET real_name = ? WHERE id = ?').bind(realName, ownerByQq.id));
      }
      if (added.length || realNameFilled) {
        updated.push({ qq, nickname: ownerByQq.nickname, addedNames: added, realNameFilled });
      }
      continue;
    }

    const id = nextCustomerId;
    nextCustomerId += 1;
    const customer: RosterCustomer = { id, qq, nickname, realName, token: randomToken() };
    byQq.set(qq, customer);
    index.exact.set(nickname, customer);
    created.push({ qq, nickname, realName });
    statements.push(
      db
        .prepare(
          'INSERT INTO customers (id, qq, nickname, token, real_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(id, qq, nickname, customer.token, realName, now),
      db.prepare('INSERT OR IGNORE INTO customer_aliases (alias, customer_id) VALUES (?, ?)').bind(nickname, id),
    );
  }

  if (!body.dryRun && statements.length) await db.batch(statements);

  return c.json({
    dryRun: Boolean(body.dryRun),
    fileName: optionalString(body.fileName) || null,
    counts: {
      rows: rows.length,
      created: created.length,
      updated: updated.length,
      conflicts: conflicts.length,
      errors: errors.length,
    },
    created,
    updated,
    conflicts,
    errors,
  });
});

customerRoutes.get('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const view = await buildCustomerView(c.env, id);
  if (!view) throw notFound('客户不存在');
  const aliases = await c.env.DB.prepare('SELECT alias FROM customer_aliases WHERE customer_id = ? ORDER BY alias')
    .bind(id)
    .all<{ alias: string }>();
  const row = await c.env.DB.prepare(
    'SELECT token, note, real_name AS realName, password_hash IS NULL AS passwordInitial FROM customers WHERE id = ?',
  )
    .bind(id)
    .first<{ token: string; note: string | null; realName: string | null; passwordInitial: number }>();
  const payments = await c.env.DB.prepare(
    `SELECT id, kind, currency, amount, ref_type AS refType, ref_id AS refId, note, paid_at AS paidAt
       FROM payments WHERE customer_id = ? ORDER BY id DESC LIMIT 50`,
  )
    .bind(id)
    .all();
  return c.json({
    ...view,
    aliases: aliases.results.map((a) => a.alias),
    token: row?.token,
    note: row?.note ?? null,
    realName: row?.realName ?? null,
    passwordInitial: row?.passwordInitial === 1,
    payments: payments.results,
  });
});

/**
 * 帮客户设密码：给了 password 就设成那一个，留空则退回初始密码 123456
 * （退回去之后客户下次登录会被要求先改自己的，等同于「他来找我从头来一遍」）。
 */
customerRoutes.post('/:id/password', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const body = await readJson<{ password?: unknown }>(c);
  const password = optionalString(body.password);
  const db = c.env.DB;
  const row = await db
    .prepare('SELECT qq, token FROM customers WHERE id = ?')
    .bind(id)
    .first<{ qq: string; token: string }>();
  if (!row) throw notFound('客户不存在');
  // 群主出手改密码＝「从头来一遍」，把他之前输错攒下的锁定一起清掉
  const unlock = db.prepare('DELETE FROM token_attempts WHERE token IN (?, ?)').bind(`qq:${row.qq}`, row.token);
  if (password === null) {
    await db.batch([db.prepare('UPDATE customers SET password_hash = NULL WHERE id = ?').bind(id), unlock]);
    return c.json({ ok: true, reset: true });
  }
  const problem = passwordProblem(password);
  if (problem) throw badRequest(problem);
  await db.batch([
    db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), id),
    unlock,
  ]);
  return c.json({ ok: true, reset: false });
});

customerRoutes.patch('/:id', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const body = await readJson<{
    nickname?: string;
    qq?: string;
    realName?: string;
    note?: string;
    selfReturn?: boolean;
  }>(c);
  const qq = optionalString(body.qq);
  if (qq !== null && !/^\d{5,15}$/.test(qq)) throw badRequest('QQ 号格式不对');
  const nickname = optionalString(body.nickname);
  const db = c.env.DB;
  if (nickname !== null) {
    const taken = await db
      .prepare('SELECT customer_id AS ownerId FROM customer_aliases WHERE alias = ?')
      .bind(nickname)
      .first<{ ownerId: number }>();
    if (taken && taken.ownerId !== id) throw badRequest(`「${nickname}」这个名字已经是别的客户在用了`);
  }
  const selfReturn = body.selfReturn === undefined ? null : body.selfReturn ? 1 : 0;
  // 标「不拼邮」= 这个人从称重、摊运费、发快递这条链上整段退出。已经走在链上的账不能悬空，
  // 所以有算过费的摞 / 没处理完的申请 / 寄出过的，一律先撤销再标。
  if (selfReturn === 1) {
    const busy = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM weigh_groups WHERE customer_id = ? AND intl_fee_fen IS NOT NULL) AS chargedStacks,
                (SELECT COUNT(*) FROM shipping_requests WHERE customer_id = ? AND status IN ('pending','paid')) AS openRequests,
                (SELECT COUNT(*) FROM shipments WHERE customer_id = ?) AS shipments`,
      )
      .bind(id, id, id)
      .first<{ chargedStacks: number; openRequests: number; shipments: number }>();
    if (busy?.chargedStacks) {
      throw badRequest('这位已经有算过运费的摞了，先在称重台「撤销分摊」再标不拼邮');
    }
    if (busy?.openRequests) throw badRequest('还有没处理完的发货申请，先去「发货申请」页处理掉');
    if (busy?.shipments) throw badRequest('这位已经寄出过，先在「寄出」页撤销那次寄出');
  }
  const at = nowIso();
  await db.batch([
    db
      .prepare(
        'UPDATE customers SET nickname = COALESCE(?, nickname), qq = COALESCE(?, qq), real_name = COALESCE(?, real_name), note = COALESCE(?, note), self_return = COALESCE(?, self_return) WHERE id = ?',
      )
      .bind(nickname, qq, optionalString(body.realName), optionalString(body.note), selfReturn, id),
    // 改完昵称，新名字必须也能在表里认出来；旧别名留着，早前的表还能对上
    ...(nickname === null
      ? []
      : [db.prepare('INSERT OR IGNORE INTO customer_aliases (alias, customer_id) VALUES (?, ?)').bind(nickname, id)]),
    // 标上不拼邮就把他之前那点认领退回未认领，空出来的那一摞删掉，称重台里立刻不再出现他
    ...(selfReturn === 1
      ? [
          db
            .prepare(
              `UPDATE items SET weigh_group_id = NULL, updated_at = ?
                WHERE customer_id = ? AND weigh_group_id IN
                  (SELECT id FROM weigh_groups WHERE customer_id = ? AND intl_fee_fen IS NULL)`,
            )
            .bind(at, id, id),
          db
            .prepare(
              `DELETE FROM weigh_groups
                WHERE customer_id = ? AND intl_fee_fen IS NULL
                  AND id NOT IN (SELECT ref_id FROM payments WHERE ref_type = 'weigh_group')`,
            )
            .bind(id),
        ]
      : []),
  ]);
  return c.json({ ok: true, selfReturn: selfReturn === null ? undefined : selfReturn === 1 });
});

/**
 * 不拼邮的人：货当面交给他（或他自己从转运那儿收到了）就点这个，
 * 这几件直接结成「已签收」——不走称重分摊、不生成寄出、也不记国内运费。
 */
customerRoutes.post('/:id/received', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const db = c.env.DB;
  if (!(await isSelfReturn(db, id))) {
    throw badRequest('只有标了「不拼邮」的客户才用这一步；拼邮的照旧走称重分摊和寄出');
  }
  const rows = await db
    .prepare(
      `SELECT id, status FROM items
        WHERE customer_id = ? AND missing = 0 AND shipment_id IS NULL
          AND status NOT IN ('cancelled','refunded','delivered')`,
    )
    .bind(id)
    .all<{ id: number; status: string }>();
  if (!rows.results.length) throw badRequest('他这边没有要结掉的货（要么已经标过，要么缺件/砍单了）');
  const at = nowIso();
  await db.batch(
    rows.results.flatMap((i) => [
      db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').bind('delivered', at, i.id),
      statusLogStmt(db, i.id, i.status, 'delivered', at),
    ]),
  );
  return c.json({ ok: true, count: rows.results.length });
});

customerRoutes.post('/:id/reset-token', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const row = await c.env.DB.prepare('SELECT qq, token FROM customers WHERE id = ?')
    .bind(id)
    .first<{ qq: string; token: string }>();
  if (!row) throw notFound('客户不存在');
  const token = randomToken();
  await c.env.DB.prepare('UPDATE customers SET token = ? WHERE id = ?').bind(token, id).run();
  // 失败次数是按「qq:<QQ号>」记的，删旧 token 删不掉；不清的话他输错过几次就一直登不进来
  await c.env.DB.prepare('DELETE FROM token_attempts WHERE token IN (?, ?)')
    .bind(`qq:${row.qq}`, row.token)
    .run();
  return c.json({ token });
});

customerRoutes.post('/:id/aliases', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const body = await readJson<{ alias?: string }>(c);
  const alias = requireString(body.alias, '别名');
  const existing = await c.env.DB.prepare('SELECT customer_id AS customerId FROM customer_aliases WHERE alias = ?')
    .bind(alias)
    .first<{ customerId: number }>();
  if (existing && existing.customerId !== id) throw badRequest('这个名字已经绑在别的客户身上了');
  await c.env.DB.prepare('INSERT OR IGNORE INTO customer_aliases (alias, customer_id) VALUES (?, ?)')
    .bind(alias, id)
    .run();
  return c.json({ ok: true });
});

customerRoutes.delete('/:id/aliases/:alias', async (c) => {
  const id = requireInt(c.req.param('id'), '客户 ID');
  const alias = decodeURIComponent(c.req.param('alias'));
  await c.env.DB.prepare('DELETE FROM customer_aliases WHERE alias = ? AND customer_id = ?').bind(alias, id).run();
  return c.json({ ok: true });
});

/** 合并误建的重复客户：把 source 的一切挪到 target，然后删掉 source。 */
customerRoutes.post('/merge', async (c) => {
  const body = await readJson<{ sourceId?: unknown; targetId?: unknown }>(c);
  const sourceId = requireInt(body.sourceId, '被合并客户 ID');
  const targetId = requireInt(body.targetId, '保留客户 ID');
  if (sourceId === targetId) throw badRequest('不能自己合并自己');

  const db = c.env.DB;
  const source = await db.prepare('SELECT id FROM customers WHERE id = ?').bind(sourceId).first();
  const target = await db.prepare('SELECT id FROM customers WHERE id = ?').bind(targetId).first();
  if (!source || !target) throw notFound('客户不存在');

  // 同一包裹里两边都有称重组时，把物品并到 target 的组，重量与运费相加
  const conflicts = await db
    .prepare(
      `SELECT s.id AS sourceGroupId, t.id AS targetGroupId
         FROM weigh_groups s
         JOIN weigh_groups t ON t.package_id = s.package_id AND t.customer_id = ?
        WHERE s.customer_id = ?`,
    )
    .bind(targetId, sourceId)
    .all<{ sourceGroupId: number; targetGroupId: number }>();

  if (conflicts.results.length) {
    const charged = await db
      .prepare(
        `SELECT id FROM weigh_groups WHERE customer_id IN (?,?) AND (intl_fee_fen IS NOT NULL OR fee_paid=1) LIMIT 1`,
      )
      .bind(sourceId, targetId)
      .first();
    if (charged) throw badRequest('已有运费账目的客户不能合并，请先核对并撤销相关收款和分摊');
  }
  const addressCount = await db
    .prepare('SELECT COUNT(*) AS n FROM addresses WHERE customer_id IN (?,?)')
    .bind(sourceId, targetId)
    .first<{ n: number }>();
  if ((addressCount?.n ?? 0) > 3) throw badRequest('合并后地址超过3个，请先删除多余地址');
  const active = await db
    .prepare(`SELECT id FROM shipping_requests WHERE customer_id IN (?,?) AND status IN ('pending','paid') LIMIT 1`)
    .bind(sourceId, targetId)
    .first();
  if (active) throw badRequest('有待处理发货申请，不能合并');
  const statements: D1PreparedStatement[] = [];
  for (const conflict of conflicts.results) {
    statements.push(
      db
        .prepare('UPDATE items SET weigh_group_id = ? WHERE weigh_group_id = ?')
        .bind(conflict.targetGroupId, conflict.sourceGroupId),
      db
        .prepare(
          `UPDATE weigh_groups SET
              weight_g = COALESCE(weight_g, 0) + COALESCE((SELECT weight_g FROM weigh_groups WHERE id = ?), 0),
              intl_fee_fen = COALESCE(intl_fee_fen, 0) + COALESCE((SELECT intl_fee_fen FROM weigh_groups WHERE id = ?), 0)
            WHERE id = ?`,
        )
        .bind(conflict.sourceGroupId, conflict.sourceGroupId, conflict.targetGroupId),
      db.prepare('DELETE FROM weigh_groups WHERE id = ?').bind(conflict.sourceGroupId),
    );
  }
  statements.push(
    db.prepare('UPDATE weigh_groups SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db.prepare('UPDATE items SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db.prepare('UPDATE addresses SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db.prepare('UPDATE shipping_requests SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db.prepare('UPDATE shipments SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db.prepare('UPDATE payments SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db.prepare('UPDATE OR REPLACE customer_aliases SET customer_id = ? WHERE customer_id = ?').bind(targetId, sourceId),
    db.prepare('DELETE FROM customers WHERE id = ?').bind(sourceId),
  );
  await db.batch(statements);
  return c.json({ ok: true, targetId });
});
