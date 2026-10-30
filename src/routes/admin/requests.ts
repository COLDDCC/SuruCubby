import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../lib/env.ts';
import { badRequest, notFound, readJson, requireInt, requireString } from '../../lib/http.ts';
import { nextId, nowIso, domesticFeeFen, statusLogStmt, isSelfReturn } from '../../lib/db.ts';
import { clearCustomerSession, customerSession } from '../../lib/session.ts';
import { usingInitialPassword } from '../../lib/password.ts';
export const requestAdminRoutes=new Hono<{Bindings:Env}>();
type CustomerMe={id:number;passwordHash:string|null};
type CustomerCtx=Context<{Bindings:Env;Variables:{customer:CustomerMe}}>;
export const requestCustomerRoutes=new Hono<{Bindings:Env;Variables:{customer:CustomerMe}}>();
requestCustomerRoutes.use('/:token/*',async(c,next)=>{
 const token=c.req.param('token'); const me=await customerSession(c,token);
 if(!me){clearCustomerSession(c,token);return c.json({error:'请先验证身份'},401);}
 // 还拿着统一的初始密码时不让动手下单：谁都知道 123456，先改成自己的才认
 if(c.req.method!=='GET'&&usingInitialPassword(me.passwordHash)) return c.json({error:'请先点击「修改密码」设一个只有你知道的密码'},403);
 c.set('customer',me);
 await next();
});
function identity(c:CustomerCtx):number{return c.get('customer').id;}
requestCustomerRoutes.post('/:token/addresses',async c=>{
 const cid=identity(c); const b=await readJson<{recipient:string;phone:string;detail:string}>(c);
 const recipient=requireString(b.recipient,'收件人'),phone=requireString(b.phone,'电话'),detail=requireString(b.detail,'地址');
 if(recipient.length>100 || phone.length>40 || detail.length>500) throw badRequest('地址内容过长');
 const count=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM addresses WHERE customer_id=?').bind(cid).first<{n:number}>();
 if((count?.n??0)>=3) throw badRequest('最多保存3个地址');
 const id=await nextId(c.env.DB,'addresses'); await c.env.DB.prepare('INSERT INTO addresses VALUES(?,?,?,?,?)').bind(id,cid,recipient,phone,detail).run();return c.json({id});
});
requestCustomerRoutes.delete('/:token/addresses/:id',async c=>{
 await c.env.DB.prepare('DELETE FROM addresses WHERE id=? AND customer_id=?').bind(requireInt(c.req.param('id'),'地址 ID'),identity(c)).run();return c.json({ok:true});
});
requestCustomerRoutes.post('/:token/requests',async c=>{
 const cid=identity(c),db=c.env.DB;
 const b=await readJson<{itemIds:number[];addressId:number}>(c);
 // 标了「不拼邮」的人（自己带回国 / 另找转运）不在这条链上，货款照旧但不用申请发货
 if(await isSelfReturn(db,cid)) throw badRequest('这一批你不走拼邮，不用申请发货；有变动在群里说一声，群主改回来就行');
 if(!Array.isArray(b.itemIds)||!b.itemIds.length||b.itemIds.length>500) throw badRequest('请勾选1至500件商品');
 const ids=[...new Set(b.itemIds.map(x=>requireInt(x,'物品 ID')))];
 const address=await db.prepare('SELECT recipient,phone,detail FROM addresses WHERE id=? AND customer_id=?').bind(requireInt(b.addressId,'地址 ID'),cid).first();
 if(!address) throw notFound('地址不存在');
 const rows=await db.prepare(`SELECT i.id,i.status,i.weight_g AS weight,i.intl_fee_fen AS fee,p.allocated_at AS allocated FROM items i LEFT JOIN packages p ON p.id=i.package_id WHERE i.id IN (${ids.map(()=>'?')}) AND i.customer_id=? AND i.missing=0 AND i.shipment_id IS NULL AND NOT EXISTS(SELECT 1 FROM request_items r WHERE r.item_id=i.id)`).bind(...ids,cid).all<{id:number;status:string;weight:number|null;fee:number|null;allocated:string|null}>();
 if(rows.results.length!==ids.length||rows.results.some(i=>i.status!=='cn_stock'||!i.allocated||i.fee===null)) throw badRequest('有商品尚未算费、已申请或不属于你，请刷新');
 const id=await nextId(db,'shipping_requests');
 await db.batch([db.prepare('INSERT INTO shipping_requests(id,customer_id,address_snapshot,domestic_fee_fen,status,created_at) VALUES(?,?,?,?,?,?)').bind(id,cid,JSON.stringify(address),await domesticFeeFen(c.env),'pending',nowIso()),...ids.map(i=>db.prepare('INSERT INTO request_items VALUES(?,?)').bind(i,id))]);return c.json({id});
});
requestCustomerRoutes.delete('/:token/requests/:id',async c=>{
 const id=requireInt(c.req.param('id'),'申请 ID'),cid=identity(c);
 const r=await c.env.DB.prepare('SELECT status FROM shipping_requests WHERE id=? AND customer_id=?').bind(id,cid).first<{status:string}>();
 if(!r||r.status!=='pending') throw badRequest('仅未确认收款的申请可以取消');
 await c.env.DB.batch([c.env.DB.prepare('DELETE FROM request_items WHERE request_id=?').bind(id),c.env.DB.prepare("UPDATE shipping_requests SET status='cancelled' WHERE id=?").bind(id)]);return c.json({ok:true});
});
requestAdminRoutes.get('/',async c=>{
 const requests=await c.env.DB.prepare(`SELECT r.*,c.nickname,c.qq FROM shipping_requests r JOIN customers c ON c.id=r.customer_id ORDER BY r.id DESC`).all();
 const items=await c.env.DB.prepare(`SELECT i.*,ri.request_id FROM request_items ri JOIN items i ON i.id=ri.item_id`).all();
 const groups=await c.env.DB.prepare(`SELECT DISTINCT ri.request_id,g.id,g.intl_fee_fen,g.fee_paid FROM request_items ri JOIN items i ON i.id=ri.item_id JOIN weigh_groups g ON g.id=i.weigh_group_id`).all();
 return c.json({requests:requests.results,items:items.results,groups:groups.results});
});
requestAdminRoutes.post('/:id/paid',async c=>{
 const id=requireInt(c.req.param('id'),'申请 ID'),db=c.env.DB;
 const r=await db.prepare('SELECT * FROM shipping_requests WHERE id=?').bind(id).first<any>();
 if(!r) throw notFound('申请不存在');
 // 撤销过运费收款会留下「申请显示已确认、件却没收到钱」，直接说清下一步往哪点
 if(r.status==='paid'&&await db.prepare('SELECT i.id FROM request_items ri JOIN items i ON i.id=ri.item_id WHERE ri.request_id=? AND i.intl_paid=0 LIMIT 1').bind(id).first())
  throw badRequest('这一笔里有商品的国际运费收款被撤销了：到「收款」页重新收那一摞，或把这笔的国内运费收款也撤销、再重新确认');
 if(r.status!=='pending') throw badRequest('申请不存在或已经处理');
 // International charges remain settled per customer/package, as in the existing ledger.
 const items=await db.prepare(`SELECT i.id,i.intl_fee_fen FROM request_items ri JOIN items i ON i.id=ri.item_id WHERE ri.request_id=? AND i.intl_paid=0`).bind(id).all<any>();
 let payment=await nextId(db,'payments');const at=nowIso(); const statements:D1PreparedStatement[]=[];
 for(const i of items.results){
 statements.push(db.prepare("INSERT INTO payments(id,customer_id,kind,currency,amount,ref_type,ref_id,paid_at) VALUES(?,?,'item_intl','CNY',?,'item',?,?)").bind(payment++,r.customer_id,i.intl_fee_fen,i.id,at),db.prepare('UPDATE items SET intl_paid=1 WHERE id=?').bind(i.id));
 }
 // 只重算这次申请里那些摞的收款状态，别把这位客户其它包裹的历史摞一起改掉
 statements.push(db.prepare(`UPDATE weigh_groups SET fee_paid=CASE WHEN EXISTS(SELECT 1 FROM items i WHERE i.weigh_group_id=weigh_groups.id AND i.intl_paid=0 AND i.missing=0 AND i.status NOT IN ('cancelled','refunded')) THEN 0 ELSE 1 END WHERE id IN(SELECT DISTINCT i.weigh_group_id FROM request_items ri JOIN items i ON i.id=ri.item_id WHERE ri.request_id=? AND i.weigh_group_id IS NOT NULL) AND intl_fee_fen IS NOT NULL`).bind(id));
 statements.push(db.prepare("INSERT INTO payments(id,customer_id,kind,currency,amount,ref_type,ref_id,paid_at) VALUES(?,?,'domestic','CNY',?,'request',?,?)").bind(payment++,r.customer_id,r.domestic_fee_fen,id,at));
 statements.push(db.prepare("UPDATE shipping_requests SET status='paid',paid_at=? WHERE id=?").bind(at,id));
 await db.batch(statements);return c.json({ok:true});
});
requestAdminRoutes.post('/:id/ship',async c=>{
 const id=requireInt(c.req.param('id'),'申请 ID'),db=c.env.DB;
 const b=await readJson<{trackingNo:string}>(c);const tracking=requireString(b.trackingNo,'国内快递单号');
 const r=await db.prepare('SELECT * FROM shipping_requests WHERE id=?').bind(id).first<any>();
 if(!r||r.status!=='paid') throw badRequest('请先确认扫码款项已经收到');
 const items=await db.prepare('SELECT i.id,i.status FROM request_items ri JOIN items i ON i.id=ri.item_id WHERE ri.request_id=?').bind(id).all<{id:number;status:string}>();
 if(!items.results.length||items.results.some(i=>i.status!=='cn_stock')) throw badRequest('商品状态有变化，请核对');
 const unpaid=await db.prepare('SELECT g.id FROM request_items ri JOIN items i ON i.id=ri.item_id JOIN weigh_groups g ON g.id=i.weigh_group_id WHERE ri.request_id=? AND i.intl_paid=0 LIMIT 1').bind(id).first();
 if(unpaid) throw badRequest('国际运费收款已撤销，请重新核对');
 const domestic=await db.prepare("SELECT id FROM payments WHERE kind='domestic' AND ref_type='request' AND ref_id=?").bind(id).first();
 if(!domestic) throw badRequest('国内运费收款已撤销');
 const sid=await nextId(db,'shipments'),at=nowIso();
 await db.batch([
 db.prepare('INSERT INTO shipments(id,customer_id,tracking_no,fee_fen,fee_paid,shipped_at,created_at,address_snapshot,request_id) VALUES(?,?,?,?,1,?,?,?,?)').bind(sid,r.customer_id,tracking,r.domestic_fee_fen,at,at,r.address_snapshot,id),
 db.prepare("UPDATE payments SET ref_type='shipment',ref_id=? WHERE kind='domestic' AND ref_type='request' AND ref_id=?").bind(sid,id),
 ...items.results.flatMap(i=>[db.prepare("UPDATE items SET shipment_id=?,status='shipped',updated_at=? WHERE id=?").bind(sid,at,i.id),statusLogStmt(db,i.id,i.status,'shipped',at)]),
 db.prepare("UPDATE shipping_requests SET status='shipped',shipment_id=? WHERE id=?").bind(sid,id)]);
 return c.json({ok:true,id:sid});
});
