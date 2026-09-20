/**
 * 预览用的假后端：拦掉 fetch，用一份从真接口导出来的演示数据回应。
 * 页面代码是真的（和线上跑的是同一批文件），只有数据是假的。
 */
(function () {
  const seed = structuredClone(window.__SEED__);
  const state = seed;

  // 称重台从「还没开始拆」的状态演起，这样点封面认领才有得玩
  const weigh = state['/api/admin/packages/1/weigh'];
  if (weigh) {
    weigh.package.allocatedAt = null;
    weigh.package.totalFeeFen = null;
    weigh.package.status = 'cn_arrived';
    for (const c of weigh.customers) {
      c.weightG = null;
      c.intlFeeFen = null;
      c.feePaid = 0;
      for (const item of c.items) {
        item.weighGroupId = null;
        if (!item.missing) item.status = 'cn_arrived';
      }
    }
  }

  // 预览里直接当成「已经验过 QQ」，省掉一次输入；真实页面第一次打开是要验的
  try {
    sessionStorage.setItem('demo-verified', '1');
  } catch {
    /* 隐私模式下不管它 */
  }

  const params = new URLSearchParams(location.search);
  const customerKey = params.get('who') === 'ali' ? '__customer__' : '__customer2__';

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function customerDetail(id) {
    return state[`/api/admin/customers/${id}`];
  }

  function recount(detail) {
    if (!detail) return;
    const s = detail.summary;
    s.goodsUnpaidFen = detail.items
      .filter((i) => !i.goodsPaid && i.status !== 'cancelled' && i.status !== 'refunded')
      .reduce((sum, i) => sum + i.goodsFeeFen, 0);
    s.intlUnpaidFen = detail.weighGroups
      .filter((g) => !g.feePaid)
      .reduce((sum, g) => sum + (g.intlFeeFen || 0), 0);
    s.domesticUnpaidFen = detail.shipments
      .filter((sh) => !sh.feePaid)
      .reduce((sum, sh) => sum + sh.feeFen, 0);
    s.totalUnpaidFen = s.goodsUnpaidFen + s.intlUnpaidFen + s.domesticUnpaidFen;
    s.stockCount = detail.items.filter((i) => i.status === 'cn_stock').length;
    for (const b of detail.batches) {
      b.unpaidFen = detail.items
        .filter((i) => i.batchId === b.batchId && !i.goodsPaid && i.status !== 'cancelled' && i.status !== 'refunded')
        .reduce((sum, i) => sum + i.goodsFeeFen, 0);
    }
  }

  function weighProgress() {
    const items = weigh.customers.flatMap((c) => c.items);
    for (const c of weigh.customers) {
      c.found = c.items.filter((i) => i.weighGroupId && !i.missing).length;
      c.missing = c.items.filter((i) => i.missing).length;
      c.expected = c.items.length;
    }
    weigh.progress = {
      expectedItems: items.length,
      foundItems: items.filter((i) => i.weighGroupId && !i.missing).length,
      missingItems: items.filter((i) => i.missing).length,
      weighedCustomers: weigh.customers.filter((c) => c.weightG > 0).length,
      totalCustomers: weigh.customers.length,
    };
  }

  function allocation(totalFeeYuan, declaredWeightG) {
    const fee = Math.round(Number(String(totalFeeYuan).replace(/[^\d.]/g, '')) * 100);
    const usable = weigh.customers.filter((c) => c.weightG > 0 && c.items.some((i) => i.weighGroupId && !i.missing));
    const notWeighed = weigh.customers.filter(
      (c) => c.items.some((i) => i.weighGroupId && !i.missing) && !(c.weightG > 0),
    );
    if (notWeighed.length) {
      return { error: `还有 ${notWeighed.length} 位客户没称重：${notWeighed.map((c) => c.nickname).join('、')}` };
    }
    if (!usable.length) return { error: '还没有任何已认领的物品，不能分摊' };
    const total = usable.reduce((sum, c) => sum + c.weightG, 0);
    const rows = usable.map((c) => ({
      weighGroupId: c.customerId,
      customerId: c.customerId,
      nickname: c.nickname,
      itemCount: c.items.filter((i) => i.weighGroupId && !i.missing).length,
      weightG: c.weightG,
      share: c.weightG / total,
      feeFen: Math.floor((fee * c.weightG) / total),
    }));
    return {
      totalFeeFen: fee,
      totalWeightG: total,
      declaredWeightG: declaredWeightG ?? null,
      weightDiffG: declaredWeightG ? declaredWeightG - total : null,
      diffFen: fee - rows.reduce((sum, r) => sum + r.feeFen, 0),
      rows,
    };
  }

  const realFetch = window.fetch.bind(window);

  window.fetch = async function (input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, location.href);
    const idx = url.pathname.indexOf('/api/');
    if (idx < 0) return realFetch(input, init);

    const path = url.pathname.slice(idx);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};

    // 客户页
    if (path.startsWith('/api/w/')) {
      if (path.endsWith('/verify')) {
        const expected = customerKey === '__customer__' ? state.__customerQq__ : state.__customer2Qq__;
        if (String(body.qq).trim() !== expected) {
          return json({ error: 'QQ 号对不上（演示里的号码写在页面上）', left: 4 }, 401);
        }
        return json({ verified: true, ...state[customerKey] });
      }
      if (!sessionStorage.getItem('demo-verified')) return json({ verified: false }, 401);
      return json({ verified: true, ...state[customerKey] });
    }

    if (path === '/api/admin/session') return json({ loggedIn: true });
    if (path === '/api/admin/login' || path === '/api/admin/logout') return json({ ok: true });

    if (method === 'GET') {
      if (path.startsWith('/api/admin/customers?') || path === '/api/admin/customers') {
        const q = url.searchParams.get('q')?.trim() ?? '';
        const all = state['/api/admin/customers'].customers;
        return json({
          customers: q ? all.filter((c) => c.nickname.includes(q) || c.qq.includes(q)) : all,
        });
      }
      if (path === '/api/admin/packages/1/weigh') {
        weighProgress();
        return json(weigh);
      }
      if (state[path]) return json(state[path]);
      return json({ error: '演示数据里没有这一页' }, 404);
    }

    // —— 写操作：改内存里的演示数据，让按钮点着有反应 ——
    if (path === '/api/admin/packages/1/weigh/claim') {
      for (const c of weigh.customers) {
        const item = c.items.find((i) => i.id === body.itemId);
        if (item) {
          item.weighGroupId = body.claimed ? c.customerId : null;
          if (body.claimed) item.missing = 0;
        }
      }
      return json({ ok: true });
    }
    if (path === '/api/admin/packages/1/weigh/missing') {
      for (const c of weigh.customers) {
        const item = c.items.find((i) => i.id === body.itemId);
        if (item) {
          item.missing = body.missing ? 1 : 0;
          if (body.missing) item.weighGroupId = null;
          item.exceptionNote = body.note || null;
        }
      }
      return json({ ok: true });
    }
    if (path === '/api/admin/packages/1/weigh/group') {
      const c = weigh.customers.find((x) => x.customerId === body.customerId);
      if (c) c.weightG = body.weightG ? Number(body.weightG) : null;
      return json({ ok: true });
    }
    if (path.endsWith('/allocate/preview') || path.endsWith('/allocate/commit')) {
      const result = allocation(body.totalFeeYuan, body.totalWeightG ? Number(body.totalWeightG) : null);
      if (result.error) return json(result, 400);
      if (path.endsWith('/commit')) {
        weigh.package.allocatedAt = new Date().toISOString();
        weigh.package.totalFeeFen = result.totalFeeFen;
        for (const row of result.rows) {
          const c = weigh.customers.find((x) => x.customerId === row.customerId);
          if (c) c.intlFeeFen = row.feeFen;
          for (const item of c.items) if (item.weighGroupId && !item.missing) item.status = 'cn_stock';
        }
        result.itemsMovedToStock = weigh.customers.flatMap((c) => c.items).filter((i) => i.status === 'cn_stock').length;
      }
      return json(result);
    }
    if (path.endsWith('/allocate/undo')) {
      weigh.package.allocatedAt = null;
      weigh.package.totalFeeFen = null;
      for (const c of weigh.customers) {
        c.intlFeeFen = null;
        for (const item of c.items) if (item.status === 'cn_stock') item.status = 'cn_arrived';
      }
      return json({ ok: true, itemsReverted: 0 });
    }

    if (path === '/api/admin/payments' && method === 'POST') {
      const dash = state['/api/admin/dashboard'];
      const detail = customerDetail(body.customerId);
      let amountFen = 0;
      if (body.kind === 'goods') {
        const ids = body.itemIds ?? null;
        if (detail) {
          for (const item of detail.items) {
            const hit = ids ? ids.includes(item.id) : item.batchId === body.batchId;
            if (hit && !item.goodsPaid && item.status !== 'cancelled' && item.status !== 'refunded') {
              item.goodsPaid = 1;
              amountFen += item.goodsFeeFen;
            }
          }
        }
        dash.goodsUnpaid = dash.goodsUnpaid.filter(
          (r) => !(r.customerId === body.customerId && (!body.batchId || r.batchId === body.batchId)),
        );
      } else if (body.kind === 'intl') {
        const group = detail?.weighGroups.find((g) => g.id === body.weighGroupId);
        if (group) {
          group.feePaid = 1;
          amountFen = group.intlFeeFen;
        }
        dash.intlUnpaid = dash.intlUnpaid.filter((r) => r.weighGroupId !== body.weighGroupId);
      } else {
        const shipment = detail?.shipments.find((s) => s.id === body.shipmentId);
        if (shipment) {
          shipment.feePaid = 1;
          amountFen = shipment.feeFen;
        }
        dash.domesticUnpaid = dash.domesticUnpaid.filter((r) => r.shipmentId !== body.shipmentId);
        const list = state['/api/admin/shipments'].shipments.find((s) => s.id === body.shipmentId);
        if (list) list.feePaid = 1;
      }
      recount(detail);
      state['/api/admin/payments'].payments.unshift({
        id: Date.now() % 100000,
        customerId: body.customerId,
        nickname: detail?.customer.nickname ?? '演示客户',
        qq: detail?.customer.qq ?? '',
        kind: body.kind,
        amountFen,
        note: null,
        paidAt: new Date().toISOString(),
      });
      return json({ id: 1, amountFen });
    }

    if (path.startsWith('/api/admin/items/') && method === 'PATCH') {
      const id = Number(path.split('/').pop());
      const dash = state['/api/admin/dashboard'];
      if (body.status === 'refunded') dash.pendingRefunds = dash.pendingRefunds.filter((r) => r.itemId !== id);
      for (const key of Object.keys(state)) {
        const entry = state[key];
        for (const item of entry?.items ?? []) {
          if (item.id === id && body.status) item.status = body.status;
        }
      }
      return json({ ok: true });
    }

    if (path === '/api/admin/shipments' && method === 'POST') {
      const detail = customerDetail(body.customerId);
      const unpaid = (detail?.weighGroups ?? []).filter((g) => !g.feePaid);
      const unpaidIntlFen = unpaid.reduce((sum, g) => sum + (g.intlFeeFen || 0), 0);
      const feeFen = state['/api/admin/settings'].domesticFeeFen;
      if (unpaidIntlFen > 0 && !body.force) {
        return json(
          {
            error: '这位客户还有国际运费没付',
            blocked: true,
            unpaidIntlFen,
            unpaidGroups: unpaid,
            feeFen,
            totalDueFen: feeFen + unpaidIntlFen,
          },
          409,
        );
      }
      const id = Date.now() % 100000;
      const items = (detail?.items ?? []).filter((i) => body.itemIds.includes(i.id));
      for (const item of items) item.status = 'shipped';
      detail?.shipments.unshift({
        id,
        trackingNo: null,
        feeFen,
        feePaid: 0,
        shippedAt: null,
        createdAt: new Date().toISOString(),
        itemCount: items.length,
        items: items.map((i) => ({ id: i.id, title: i.title })),
      });
      recount(detail);
      return json({ id, feeFen, itemCount: items.length, unpaidIntlFen, totalDueFen: feeFen + unpaidIntlFen });
    }

    if (path.startsWith('/api/admin/shipments/') && method === 'PATCH') {
      const id = Number(path.split('/').pop());
      for (const key of Object.keys(state)) {
        for (const s of state[key]?.shipments ?? []) {
          if (s.id === id && body.trackingNo) s.trackingNo = body.trackingNo;
        }
      }
      return json({ ok: true });
    }

    if (path === '/api/admin/settings' && method === 'POST') {
      state['/api/admin/settings'].domesticFeeFen = Math.round(Number(body.domesticFeeYuan) * 100);
      return json(state['/api/admin/settings']);
    }

    return json({ ok: true, demo: true });
  };

  // 客户页验证过一次之后就记住，跟线上的 Cookie 行为一致
  const origPost = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origPost(input, init);
    const raw = typeof input === 'string' ? input : input.url;
    if (raw.includes('/verify') && res.ok) sessionStorage.setItem('demo-verified', '1');
    return res;
  };
})();
