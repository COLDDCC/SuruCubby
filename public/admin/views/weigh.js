import { api } from "/admin/api.js";
import {
  bindActions,
  codeTag,
  confirmBox,
  escapeHtml,
  fenToYuan,
  itemCode,
  money,
  openModal,
  promptBox,
  thumb,
  toast,
} from "/admin/ui.js";

export async function render(view, [id]) {
  const data = await api.get(`/api/admin/packages/${id}/weigh`);
  const p = data.progress;
  const pkg = data.package;

  const isReady = (c) => {
    if (c.intlFeeFen !== null) return false;
    const live = c.items.filter((i) => !i.missing);
    if (!live.length) return false;
    return live.every((i) => i.weightG) || (c.weightG ?? 0) > 0;
  };
  // 标了「不拼邮」的人从这条链上整段退出：不进称重进度、不进分摊，卡片也只留一行说明
  const joined = data.customers.filter((c) => !c.selfReturn);
  const offList = data.customers.filter((c) => c.selfReturn);
  const chargedStacks = joined.filter((c) => c.intlFeeFen !== null);
  const readyStacks = joined.filter(isReady);
  const openStacks = joined.filter((c) => c.intlFeeFen === null);

  const unpaidGroups = chargedStacks.filter((c) => !c.feePaid);
  const unpaidIntl = unpaidGroups.reduce((sum, c) => sum + c.intlFeeFen, 0);

  const stockCustomers = joined.filter((c) =>
    c.items.some((i) => i.status === "cn_stock"),
  );
  const stockCount = stockCustomers.reduce(
    (sum, c) => sum + c.items.filter((i) => i.status === "cn_stock").length,
    0,
  );
  const stockHint = stockCount
    ? `<p class="small paid">这一箱 ${stockCount} 件已是「可发货」，客户打开自己的页面就能勾选申请发货。你要直接寄出：${
        stockCustomers.length === 1
          ? `<a href="#/customers/${stockCustomers[0].customerId}">${escapeHtml(stockCustomers[0].nickname)} 的详情页</a>`
          : `<a href="#/customers">${stockCustomers.length} 个人的详情页</a>`
      }，或到 <a href="#/shipments">寄出</a> 页点「登记一次发货」——勾完这一批、填上快递单号就同时标成「已寄出」。</p>`
    : "";

  view.innerHTML = `
    <div class="progress-bar">
      <span>应有 <strong>${p.expectedItems}</strong> 件 / 已找到 <strong>${p.foundItems}</strong> 件</span>
      <span>已称 <strong>${p.weighedCustomers}</strong> 人 / 共 <strong>${p.totalCustomers}</strong> 人</span>
      <span>已算运费 <strong>${chargedStacks.length}</strong> 摞${
        openStacks.length ? ` / 还有 <strong>${openStacks.length}</strong> 摞` : ""
      }</span>
      ${p.missingItems ? `<span class="badge warn">缺件 ${p.missingItems}</span>` : ""}
      ${p.offScaleItems ? `<span class="badge">已寄出/已签收 ${p.offScaleItems} 件（不在秤上）</span>` : ""}
      ${
        p.selfReturnCustomers
          ? `<span class="badge">不拼邮 ${p.selfReturnCustomers} 人 / ${p.selfReturnItems} 件</span>`
          : ""
      }
      ${stockCount ? `<span class="badge ok">可发货 ${stockCount} 件</span>` : ""}
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">${escapeHtml(pkg.name)} · 称重台</h2>
        <a class="btn small ghost" href="#/packages/${pkg.id}">包裹详情</a>
      </div>
      ${
        pkg.jpWeightG || pkg.cartonCount
          ? `<p class="small">日本仓封箱时：${pkg.jpWeightG ? `整箱 <b>${(pkg.jpWeightG / 1000).toFixed(2)} kg</b>` : '没称'}${
              pkg.cartonCount ? ` · <b>${pkg.cartonCount}</b> 箱` : ''
            } <span class="muted">（和这边各摞合计对一下，差太多就是少了一箱或者有件没认领）</span></p>`
          : ''
      }
      <p class="small muted">对货看大图和货号就够：点图片＝这件找到了，货号能点开商品页核对。称重有两种填法——整摞放秤上填一个总重（摞内按件数均摊），或者一件一件填重量（按各件轻重摊）。<strong>不用等全箱称完</strong>：哪一摞称好了就先「算分摊」那一摞，那个人马上就能申请发货，剩下的人称好了再算一次，账各记各的。已经算过运费的那几摞要改，得先「撤销分摊」。<strong>已经寄出或签收的件不在这台秤上</strong>（进度、认领、分摊都不算它们），改回拼邮也不会再收一次运费。</p>
      ${
        p.unclaimedItems > 0
          ? `<p><button class="small" data-action="claimAll">整箱全部认领（还差 ${p.unclaimedItems} 件）</button>
             <span class="small muted">货全到了就点这个，一件件都不用点；确实没收到的请在下面标「缺件」</span></p>`
          : ""
      }
      ${
        chargedStacks.length
          ? `<p class="small">已分摊：国际运费 <span class="money">${money(pkg.totalFeeFen)}</span>
              · <button class="small danger" data-action="undo">撤销分摊</button>
              <span class="small muted">（这一箱算过的 ${chargedStacks.length} 摞一起退回）</span></p>
            ${stockHint}
            ${
              unpaidGroups.length
                ? `<p><button class="small" data-action="payAllIntl">这个包裹运费全收（${unpaidGroups.length} 人 · ${money(
                    unpaidIntl,
                  )}）</button>
                    <span class="small muted">点一次给每个人都记一笔；谁其实没付，去他页面撤销那一笔</span></p>`
                : '<p class="small paid">这个包裹的运费都记完了。</p>'
            }`
          : ""
      }
    </div>
    ${offList
      .map(
        (c) => `
      <div class="card" data-customer-card="${c.customerId}">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">${escapeHtml(c.nickname)} <span class="badge">不拼邮</span>
            <span class="muted small">${c.items.length} 件</span></h3>
          <button class="small plain" data-action="backToGroup" data-customer="${c.customerId}" data-nickname="${escapeHtml(c.nickname)}">改回拼邮</button>
        </div>
        <p class="small muted">这批货他自己带回国／另找转运，后面不再走我们这条链：不认领、不称重、不摊国际运费、不能申请发货、也不发国内快递。
          货款照旧按表里记的算，一分没多一分没少。要恢复就点右边「改回拼邮」，还没交接的件会重新回到「待认领」里；
          已经点过「当面给他了」的那几件已经算签收，不会再回这台秤上，也不会再收一次运费。
          <a href="#/customers/${c.customerId}">他的详情页</a>那儿有「这几件已经当面给他了」，货交接完在那儿结掉就行。</p>
      </div>`,
      )
      .join("")}
    ${joined
      .map((c) => {
        const live = c.items.filter((i) => !i.missing);
        const weighedUnits = live.filter((i) => i.weightG).length;
        const byUnit = live.length > 0 && weighedUnits === live.length;
        const charged = c.intlFeeFen !== null;
        return `
      <div class="card" data-customer-card="${c.customerId}">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">${escapeHtml(c.nickname)}
            <span class="muted small">${c.found}/${c.expected} 件${c.missing ? ` · 缺 ${c.missing}` : ""}</span>
            ${charged ? "" : `<button class="small plain" data-action="selfOff" data-customer="${c.customerId}" data-nickname="${escapeHtml(c.nickname)}">他不拼邮</button>`}</h3>
          ${
            charged || byUnit
              ? `<span class="small muted">这一摞 ${
                  c.weightG ? `${Number(c.weightG).toLocaleString()} g` : "还没称"
                }${byUnit ? " · 逐件相加" : ""}</span>`
              : `<div class="row" style="justify-content:flex-end">
                  <input inputmode="numeric" placeholder="整摞重量 g" data-group-weight="${c.customerId}"
                         value="${c.weightG ?? ""}" style="width:120px">
                  <button class="small" data-action="groupWeight" data-customer="${c.customerId}">存整摞</button>
                  ${weighedUnits ? `<span class="small muted">已逐件称 ${weighedUnits}/${live.length}</span>` : ""}
                </div>`
          }
        </div>
        ${
          charged
            ? `<p class="small">分摊运费 <span class="money ${c.feePaid ? "paid" : "unpaid"}">${money(c.intlFeeFen)}</span>${c.feePaid ? " 已付" : ""} · 这一摞已封账，要改先撤销分摊</p>`
            : ""
        }
        <div class="claim-grid" style="margin-top:10px">
          ${c.items
            .map((i) => {
              const code = itemCode(i.productUrl);
              return `
            <div class="claim ${i.missing ? "missing" : i.weighGroupId ? "found" : ""}" data-item="${i.id}"
                 data-focus-item="${i.id}">
              <div class="claim-photo" data-action="toggle" data-item="${i.id}" data-claimed="${i.weighGroupId && !i.missing ? "1" : ""}"
                   title="${escapeHtml(i.title)}">${thumb(i)}</div>
              <div class="claim-id">
                ${codeTag(i)}
                ${code ? "" : `<div class="name">${escapeHtml(i.title)}</div>`}
              </div>
              <div class="claim-ctrl">
                <input inputmode="numeric" placeholder="重量 g" data-unit-weight="${i.id}" value="${i.weightG ?? ""}" ${charged ? "disabled" : ""}>
                <button class="small" data-action="unitWeight" data-item="${i.id}" ${charged ? "disabled" : ""}>存</button>
              </div>
              <button class="small plain claim-missing"
                      data-action="missing" data-item="${i.id}" data-missing="${i.missing ? "1" : ""}" ${charged ? "disabled" : ""}>
                ${i.missing ? "取消缺件" : "缺件"}
              </button>
            </div>`;
            })
            .join("")}
        </div>
      </div>`;
      })
      .join("")}
    ${
      openStacks.length
        ? `<div class="card">
      <label for="price">这一箱国际运费单价（元 / kg）</label>
      <div class="row" style="justify-content:space-between">
        <div class="row">
          <input id="price" inputmode="decimal" style="width:120px" value="${fenToYuan(data.intlPriceFenPerKg)}">
          <button class="small plain" data-action="savePrice">存单价</button>
        </div>
        <button data-action="preview">算分摊${
          readyStacks.length ? `（称好的 ${readyStacks.length} 摞）` : ""
        }</button>
      </div>
      <p class="small muted">单价 × 各摞重量之和就是这一箱运费，每人摊多少当场出来；点「算分摊」只把<strong>称好的那几摞</strong>入账，没称的照旧不动。包装箱重量按比例摊给所有人，尾差算需求方的。转运仓那天收得不一样，预览里可以直接改总额再确认——但手填实收总额得整箱都称完认领完才行，不然这笔钱会全压在已经称好的那几个人头上。${
        offList.length
          ? `<strong>标了「不拼邮」的 ${offList.length} 个人不参与这一箱的分摊</strong>，凑「整箱」也不把他们算进去。`
          : ""
      }</p>
      ${
        readyStacks.length === 0
          ? `<p class="small warn">现在还没有一摞称好：把某一摞「存整摞」填一个总重，或逐件填完重量，就能先算那一摞。</p>`
          : ""
      }
    </div>`
        : `<div class="card"><p class="small paid">这一箱 ${chargedStacks.length} 摞都算过运费了。剩下的人后到货再称再算，或到「包裹详情」继续对账。</p>${stockHint}</div>`
    }`;

  const reload = () => render(view, [id]);

  bindActions(view, {
    selfOff: async ({ customer, nickname }) => {
      if (
        !(await confirmBox(
          `把「${nickname}」标成不拼邮？标了之后：他这几件不用认领称重、不参与国际运费分摊、不能申请发货，也不发国内快递；货款照旧按表里记。已经算过运费或有寄出记录的会被拦住，得先撤销。`,
          { danger: true, okText: "标成不拼邮" },
        ))
      )
        return;
      try {
        await api.patch(`/api/admin/customers/${customer}`, { selfReturn: true });
        toast(`已把「${nickname}」标成不拼邮，这一箱的账里不再算他`);
        await reload();
      } catch (err) {
        toast(err.message, true);
      }
    },
    backToGroup: async ({ customer, nickname }) => {
      try {
        await api.patch(`/api/admin/customers/${customer}`, { selfReturn: false });
        toast(`「${nickname}」改回拼邮了，还没交接的件重新回到待认领；已经签收的那几件不再上秤`);
        await reload();
      } catch (err) {
        toast(err.message, true);
      }
    },
    claimAll: async (_p, el) => {
      el.disabled = true;
      try {
        const r = await api.post(`/api/admin/packages/${id}/weigh/claim-all`, {});
        toast(
          r.claimed
            ? `已认领 ${r.claimed} 件，分成 ${r.customers} 摞，接着称每摞的重量就行${
                r.skipped ? `；还有 ${r.skipped} 件在已封账的那几摞里，要撤销分摊才能加进去` : ""
              }`
            : "没有待认领的商品了",
        );
        await reload();
      } catch (err) {
        toast(err.message, true);
        el.disabled = false;
      }
    },
    groupWeight: async ({ customer }, el) => {
      el.disabled = true;
      try {
        await api.post(`/api/admin/packages/${id}/weigh/group`, {
          customerId: Number(customer),
          weightG: view.querySelector(`[data-group-weight="${customer}"]`).value.trim(),
        });
        await reload();
      } catch (err) {
        toast(err.message, true);
        el.disabled = false;
      }
    },
    unitWeight: async ({ item }, el) => {
      el.disabled = true;
      try {
        await api.post(`/api/admin/packages/${id}/weigh/item`, {
          itemId: Number(item),
          weightG: Number(
            view.querySelector(`[data-unit-weight="${item}"]`).value,
          ),
        });
        await reload();
      } catch (err) {
        toast(err.message, true);
        el.disabled = false;
      }
    },
    toggle: async ({ item, claimed }) => {
      try {
        await api.post(`/api/admin/packages/${id}/weigh/claim`, {
          itemId: Number(item),
          claimed: !claimed,
        });
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    },
    missing: async ({ item, missing }) => {
      if (missing) {
        await api.post(`/api/admin/packages/${id}/weigh/missing`, {
          itemId: Number(item),
          missing: false,
        });
        reload();
        return;
      }
      const note = await promptBox("缺件说明（例如「骏河屋漏发」）", "");
      if (note === null) return;
      await api.post(`/api/admin/packages/${id}/weigh/missing`, {
        itemId: Number(item),
        missing: true,
        note,
      });
      toast("已标记缺件，不参与分摊");
      reload();
    },
    savePrice: async () => {
      const value = view.querySelector("#price").value.trim();
      if (value === "") return toast("请填写这一箱的单价（元 / kg）", true);
      try {
        const r = await api.post("/api/admin/settings", { intlPriceYuanPerKg: value });
        toast(`单价已存：${money(r.intlPriceFenPerKg)} / kg`);
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    },
    preview: async () => {
      // 输入框里的单价先落库，预览和确认都按库里的单价算，避免页面上改了、实际没生效
      const typed = view.querySelector("#price")?.value.trim() ?? "";
      // 不传金额：后端按设置里的单价（默认 100 元/kg）从各摞重量算出这一箱的运费
      let preview;
      try {
        if (typed !== "") await api.post("/api/admin/settings", { intlPriceYuanPerKg: typed });
        preview = await api.post(`/api/admin/packages/${id}/allocate/preview`, {});
      } catch (err) {
        return toast(err.message, true);
      }
      openModal((box, close) => {
        // 只有把单价算出来的那个数改掉了，才叫「手填实收总额」；没改就不传金额，
        // 后端继续按单价算 —— 不然分批分摊会被当成整箱实收，钱全压在这几摞头上。
        const autoFeeFen = preview.totalFeeFen;
        const body = () => {
          const fee = box.querySelector("#fee").value.trim();
          const declared = box.querySelector("#declared").value.trim();
          return {
            totalFeeYuan: fee === "" || Math.round(Number(fee) * 100) === autoFeeFen ? null : fee,
            totalWeightG: declared === "" ? null : Number(declared),
          };
        };
        const draw = (p) => {
          box.innerHTML = `
            <h3>分摊预览</h3>
            ${
              p.priceFenPerKg === null
                ? ""
                : `<p class="small paid">没让你填运费：${money(
                    p.priceFenPerKg,
                  )} / kg × 各摞合计 ${p.totalWeightG.toLocaleString()} g = ${money(
                    p.totalFeeFen,
                  )}</p>`
            }
            ${
              p.fullBox
                ? ""
                : `<p class="small warn">这次只算称好的 ${p.rows.length} 摞${
                    p.chargedStacks
                      ? `（这一箱已经有 ${p.chargedStacks} 摞算过，不会重复算）`
                      : ""
                  }；还差 ${p.pendingStacks} 摞没称${
                    p.pendingNames.length ? `（${p.pendingNames.join("、")}）` : ""
                  }${p.unclaimedItems ? `、${p.unclaimedItems} 件没认领` : ""}。
                  这些人这次不进账、状态也不变，等称好了再点一次「算分摊」就行。</p>`
            }
            ${
              p.selfReturnStacks
                ? `<p class="small muted">另有 ${p.selfReturnStacks} 摞标了「不拼邮」，不算进这一箱的账，也不用凑整箱。</p>`
                : ""
            }
            <div class="scroll-x"><table>
              <thead><tr><th>客户</th><th class="right">重量</th><th class="right">占比</th><th class="right">应付运费</th></tr></thead>
              <tbody>${p.rows
                .map(
                  (r) => `<tr>
                <td>${escapeHtml(r.nickname)}<div class="small muted">${r.itemCount} 件${
                    r.unitMode === "equal"
                      ? ` · 整摞均摊，每件 ${money(Math.floor(r.feeFen / r.itemCount))} 起`
                      : " · 按各件轻重"
                  }</div></td>
                <td class="right">${r.weightG.toLocaleString()} g</td>
                <td class="right">${(r.share * 100).toFixed(1)}%</td>
                <td class="right money">${money(r.feeFen)}</td>
              </tr>`,
                )
                .join("")}</tbody></table></div>
            <p class="small">各摞合计 ${p.totalWeightG.toLocaleString()} g，运费合计 ${money(
              p.totalFeeFen,
            )}，尾差 <strong>${money(p.diffFen)}</strong> 记在需求方名下。</p>
            ${
              p.weightDiffG === null
                ? ""
                : `<p class="small muted">转运仓重量 − 各摞之和 = ${p.weightDiffG.toLocaleString()} g（仅供参考）</p>`
            }
            <label for="fee">这一箱实收的国际运费（元）${
              p.fullBox
                ? ""
                : "<span class=\"small muted\">这一箱还没弄完，改这个数会被拦住；只算称好的那几摞就别动它</span>"
            }</label>
            <div class="row">
              <input id="fee" inputmode="decimal" value="${fenToYuan(p.totalFeeFen)}">
              <input id="declared" inputmode="numeric" placeholder="转运仓总重量 g，对账用，可不填"${
                p.fullBox ? "" : " disabled"
              }>
              <button class="small plain" data-recalc>按新金额重算</button>
            </div>
            <div class="row" style="justify-content:flex-end;margin-top:12px">
              <button class="plain" data-no>再改改</button><button data-yes>确认分摊</button>
            </div>`;
          box.querySelector("[data-no]").onclick = close;
          box.querySelector("[data-recalc]").onclick = async () => {
            try {
              draw(await api.post(`/api/admin/packages/${id}/allocate/preview`, body()));
            } catch (err) {
              toast(err.message, true);
            }
          };
          box.querySelector("[data-yes]").onclick = async () => {
            try {
              const result = await api.post(
                `/api/admin/packages/${id}/allocate/commit`,
                body(),
              );
              close();
              toast(
                `已分摊 ${result.rows.length} 摞，${result.itemsMovedToStock} 件变成「可发货」，客户页面现在就能申请发货${
                  result.fullBox
                    ? ""
                    : `；另外 ${result.pendingStacks} 摞没称的照旧不动，称好了再算一次`
                }`,
              );
              reload();
            } catch (err) {
              toast(err.message, true);
            }
          };
        };
        draw(preview);
      });
    },
    payAllIntl: async () => {
      if (
        !(await confirmBox(
          `把这个包裹还没收的国际运费全部记为已收？${unpaidGroups.length} 个人，合计 ${money(unpaidIntl)}。`,
          { okText: "全记上" },
        ))
      )
        return;
      try {
        const r = await api.post("/api/admin/payments/all-intl", {
          packageId: Number(id),
        });
        toast(
          `已记 ${r.customers} 个人的运费，合计 ${money(r.amountFen)}${r.skipped ? `；${r.skipped} 人按件收过，没动` : ""}`,
        );
      } catch (err) {
        toast(err.message, true);
      }
      reload();
    },
    undo: async () => {
      if (
        !(await confirmBox(
          `撤销分摊？这一箱算过的 ${chargedStacks.length} 摞全部退回「回国中」，客户那边不再显示可发货；没算的那几摞本来就没动。`,
          { danger: true, okText: "撤销" },
        ))
      )
        return;
      try {
        await api.post(`/api/admin/packages/${id}/allocate/undo`);
        toast("已撤销分摊");
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    },
  });
}
