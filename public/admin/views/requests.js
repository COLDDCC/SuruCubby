import {api} from '/admin/api.js';
import {escapeHtml,money,toast,confirmBox,promptBox} from '/admin/ui.js';
export async function render(view){
 const d=await api.get('/api/admin/requests');
 view.innerHTML='<div class="card"><h2>客户发货申请</h2><p class="small muted">核对扫码转账后确认收款，再填写国内快递单号寄出。</p></div>'+d.requests.map(r=>{
 const a=JSON.parse(r.address_snapshot),items=d.items.filter(i=>i.request_id===r.id),intl=items.filter(i=>!i.intl_paid).reduce((s,i)=>s+(i.intl_fee_fen??0),0);
 return `<div class="card"><h3>${escapeHtml(r.nickname)} · 申请 #${r.id}</h3><p>${escapeHtml({pending:'待确认收款',paid:'已收款，待寄出',shipped:'已寄出',cancelled:'已取消'}[r.status])}</p><p>${escapeHtml(a.recipient)} · ${escapeHtml(a.phone)}<br>${escapeHtml(a.detail)}</p><ul>${items.map(i=>`<li>${escapeHtml(i.title)} · ${i.weight_g||0}g · 国际运费${money(i.intl_fee_fen)}</li>`).join('')}</ul>${r.status==='pending'?`<p>应收国际运费 ${money(intl)} + 国内运费 ${money(r.domestic_fee_fen)} = ${money(intl+r.domestic_fee_fen)}</p><button data-paid="${r.id}">扫码转账已收到</button>`:''}${r.status==='paid'?`<button data-ship="${r.id}">填写快递单号并寄出</button>`:''}</div>`;
 }).join('');
 view.querySelectorAll('[data-paid]').forEach(el=>el.onclick=async()=>{if(!await confirmBox('确认本次显示的国际运费和国内运费都已收到？'))return;el.disabled=true;try{await api.post(`/api/admin/requests/${el.dataset.paid}/paid`);await render(view);}catch(e){toast(e.message,true);el.disabled=false;}});
 view.querySelectorAll('[data-ship]').forEach(el=>el.onclick=async()=>{const trackingNo=await promptBox('国内快递单号','');if(!trackingNo)return;el.disabled=true;try{await api.post(`/api/admin/requests/${el.dataset.ship}/ship`,{trackingNo});await render(view);}catch(e){toast(e.message,true);el.disabled=false;}});
}
