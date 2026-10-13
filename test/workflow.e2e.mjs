import assert from 'node:assert/strict';
// 会真的写库：不给 E2E_BASE 就拒绝，免得测试批次进你正在用的 8787。
// 手动跑：npm run test:e2e 之外，用 node scripts/sandbox.mjs --state .wrangler/e2e --port 8792 -- node test/workflow.e2e.mjs
const base=process.env.E2E_BASE||refuse();
function refuse(){console.error('要 E2E_BASE，别写 8787。');process.exit(1);}
const cookies=new Map();
async function call(method,path,body,expected=200){
 const r=await fetch(base+path,{method,headers:{cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0];const i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}
 const d=await r.json();assert.equal(r.status,expected,`${method} ${path}: ${JSON.stringify(d)}`);return d;
}
const stamp=Date.now(),qq=String(stamp).slice(-9),names=['A'+stamp,'B'+stamp];
await call('POST','/api/admin/login',{password:'test-admin-pw'});
const imported=await call('POST','/api/admin/import/commit',{
 batchName:'workflow '+stamp,orderNo:'JP-123',japanTrackingNo:'JPTRACK',fileHash:'f'+stamp,
 sheet:{headers:['名称','客户名字','数量','应付日元金额'],rows:[['卡片',names[0],2,'1001'],['徽章',names[1],1,'20']]},
 assignments:names.map(cn=>({cn,newCustomer:{qq,nickname:cn}}))});
assert.equal(imported.createdCustomers.length,1);assert.equal(imported.itemCount,3);
const cid=imported.createdCustomers[0].id,token=imported.createdCustomers[0].token,pid=imported.packageId;
let pkg=await call('GET',`/api/admin/packages/${pid}`);
const ids=pkg.items.map(i=>i.id);
await call('PATCH',`/api/admin/packages/${pid}`,{trackingNo:'RETURN123'});
let customer=await call('POST',`/api/w/${token}/verify`,{qq});
assert(customer.items.every(i=>i.returnTrackingNo==='RETURN123'&&i.orderNo==='JP-123'&&i.status==='intl_transit'));
await call('POST',`/api/admin/packages/${pid}/weigh/item`,{itemId:ids[0],weightG:100});
await call('POST',`/api/admin/packages/${pid}/allocate/commit`,{totalFeeFen:1000},400);
await call('POST',`/api/admin/packages/${pid}/weigh/item`,{itemId:ids[1],weightG:200});
await call('POST',`/api/admin/packages/${pid}/weigh/item`,{itemId:ids[2],weightG:700});
await call('POST',`/api/admin/packages/${pid}/allocate/commit`,{totalFeeFen:1000});
customer=await call('GET',`/api/w/${token}`);assert(customer.items.every(i=>i.status==='cn_stock'&&i.weightG>0&&i.intlFeeFen!==null));
assert.equal(customer.summary.intlUnpaidFen,1000);
const address={recipient:'本人',phone:'13800000000',detail:'测试地址1'};
const a=await call('POST',`/api/w/${token}/addresses`,address);
await call('POST',`/api/w/${token}/addresses`,{...address,detail:'测试地址2'});
await call('POST',`/api/w/${token}/addresses`,{...address,detail:'测试地址3'});
await call('POST',`/api/w/${token}/addresses`,{...address,detail:'测试地址4'},400);
const request=await call('POST',`/api/w/${token}/requests`,{addressId:a.id,itemIds:[ids[0]]});
await call('POST',`/api/w/${token}/requests`,{addressId:a.id,itemIds:[ids[0]]},400);
await call('POST',`/api/admin/packages/${pid}/items`,{action:'remove',itemIds:[ids[0]]},400);
await call('POST',`/api/admin/packages/${pid}/allocate/undo`,undefined,400);
await call('POST',`/api/admin/requests/${request.id}/ship`,{trackingNo:'DOMESTIC'},400);
await call('DELETE',`/api/w/${token}/addresses/${a.id}`);
const requests=await call('GET','/api/admin/requests');assert.equal(JSON.parse(requests.requests.find(r=>r.id===request.id).address_snapshot).detail,'测试地址1');
await call('POST',`/api/admin/requests/${request.id}/paid`);
await call('POST',`/api/admin/requests/${request.id}/paid`,undefined,400);
customer=await call('GET',`/api/w/${token}`);assert.equal(customer.summary.intlUnpaidFen,900);
const shipped=await call('POST',`/api/admin/requests/${request.id}/ship`,{trackingNo:'DOMESTIC'});
await call('POST',`/api/admin/requests/${request.id}/ship`,{trackingNo:'DOMESTIC'},400);
customer=await call('GET',`/api/w/${token}`);assert.equal(customer.items.filter(i=>i.status==='shipped').length,1);assert.equal(customer.items.filter(i=>i.status==='cn_stock').length,2);
assert.equal(customer.shipments[0].trackingNo,'DOMESTIC');assert.equal(customer.summary.domesticUnpaidFen,0);
const stranger=await call('POST','/api/admin/customers',{qq:'9'+qq,nickname:'陌生人'});
await call('POST',`/api/w/${stranger.token}/verify`,{qq:'9'+qq});
await call('POST',`/api/w/${stranger.token}/requests`,{addressId:customer.addresses[0].id,itemIds:[ids[1]]},404);
const admin=await call('GET',`/api/admin/customers/${cid}`);assert.equal(admin.summary.intlUnpaidFen,900);
const payments=await call('GET',`/api/admin/payments?customerId=${cid}`);
const itemPayment=payments.payments.find(p=>p.kind==='item_intl');
await call('DELETE',`/api/admin/payments/${itemPayment.id}`);
customer=await call('GET',`/api/w/${token}`);assert.equal(customer.summary.intlUnpaidFen,1000);
await call('POST',`/api/admin/packages/${pid}/allocate/undo`,undefined,400);
const concurrent=await Promise.all([call('GET','/api/admin/session'),call('GET','/api/admin/session')]);assert(concurrent.every(r=>r.loggedIn));
const cross=await fetch(base+'/api/admin/login',{method:'POST',headers:{Origin:'https://other.invalid','content-type':'application/json'},body:JSON.stringify({password:'test-admin-pw'})});assert.equal(cross.status,403);
const split=await call('POST','/api/admin/import/commit',{batchName:'split'+stamp,sheet:{headers:['名称','cn','应付日元金额'],rows:[['拆包1',names[0],100],['拆包2',names[0],100]]}});
const splitData=await call('GET',`/api/admin/packages/${split.packageId}`);
const target=await call('POST','/api/admin/packages',{name:'合包'+stamp});
await call('POST',`/api/admin/packages/${split.packageId}/weigh/claim`,{itemId:splitData.items[0].id});
await call('POST',`/api/admin/packages/${target.id}/items`,{itemIds:[splitData.items[0].id],action:'add'});
let moved=await call('GET',`/api/admin/packages/${target.id}`);assert.equal(moved.items.length,1);assert.equal(moved.items[0].weighGroupId,null);
await call('POST',`/api/admin/packages/${target.id}/items`,{itemIds:[splitData.items[1].id],action:'add'});
moved=await call('GET',`/api/admin/packages/${target.id}`);assert.equal(moved.items.length,2);
await call('POST',`/api/w/${token}/verify`,{qq});
const cancelled=await call('POST',`/api/w/${token}/requests`,{addressId:customer.addresses[0].id,itemIds:[ids[1]]});
await call('DELETE',`/api/w/${token}/requests/${cancelled.id}`);
const again=await call('POST',`/api/w/${token}/requests`,{addressId:customer.addresses[0].id,itemIds:[ids[1]]});
assert(again.id!==cancelled.id);
await call('DELETE',`/api/w/${token}/requests/${again.id}`);
console.log('PASS: quantity, aliases, tracking, per-item weight, incomplete allocation, 3-address limit, snapshot, duplicate request, payment, partial shipment, customer isolation');
