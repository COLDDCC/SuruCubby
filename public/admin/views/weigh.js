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
  const allocated = Boolean(pkg.allocatedAt);

  const unpaidGroups = data.customers.filter(
    (c) => !c.feePaid && c.intlFeeFen !== null,
  );
  const unpaidIntl = unpaidGroups.reduce((sum, c) => sum + c.intlFeeFen, 0);

  const stockCustomers = allocated
    ? data.customers.filter((c) => c.items.some((i) => i.status === 'cn_stock'))
    : [];
  const stockCount = stockCustomers.reduce(
    (sum, c) => sum + c.items.filter((i) => i.status === 'cn_stock').length,
    0,
  );
  const stockHint = stockCount
    ? `<p class="small paid">这一箱 ${stockCount} 件已是「可发货」，客户打开自己的页面就能勾选申请发货。要现在寄出：${
        stockCustomers.length === 1
          ? `<a href="#/customers/${stockCustomers[0].customerId}">${escapeHtml(stockCustomers[0].nickname)} 的详情页</a>`
          : `<a href="#/customers">${stockCustomers.length} 个人的详情页</a>`
      }</p>`
    : "";

  view.innerHTML = `
    <div class="progress-bar">
      <span>应有 <strong>${p.expectedItems}</strong> 件 / 已找到 <strong>${p.foundItems}</strong> 件</span>
      <span>已称 <strong>${p.weighedCustomers}</strong> 人 / 共 <strong>${p.totalCustomers}</strong> 人</span>
      ${p.missingItems ? `<span class="badge warn">缺件 ${p.missingItems}</span>` : ""}
      ${allocated ? `<span class="badge ok">可发货 ${stockCount} 件</span>` : ""}
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">${escapeHtml(pkg.name)} · 称重台</h2>
        <a class="btn small ghost" href="#/packages/${pkg.id}">包裹详情</a>
      </div>
      <p class="small muted">对货看大图和货号就够：点图片＝这件找到了，货号能点开商品页核对。每件填重量并保存，漏件请明确标记。包裹到手、全部称重算费后确认，商品才变为绿色「可发货」，客户那边马上能勾选申请发货。</p>
      ${
        allocated
          ? `<p class="small">已分摊：国际运费 <span class="money">${money(pkg.totalFeeFen)}</span>
              · <button class="small danger" data-action="undo">撤销分摊</button></p>
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
    ${data.customers
      .map(
        (c) => `
      <div class="card" data-customer-card="${c.customerId}">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">${escapeHtml(c.nickname)}
            <span class="muted small">${c.found}/${c.expected} 件${c.missing ? ` · 缺 ${c.missing}` : ""}</span></h3>
          <div class="row">
            <span class="small muted">这一摞 ${c.weightG ? `${Number(c.weightG).toLocaleString()} g` : "还没称"}</span>
          </div>
        </div>
        ${
          c.intlFeeFen !== null
            ? `<p class="small">分摊运费 <span class="money ${c.feePaid ? "paid" : "unpaid"}">${money(c.intlFeeFen)}</span>${c.feePaid ? " 已付" : ""}</p>`
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
                <input inputmode="numeric" placeholder="重量 g" data-unit-weight="${i.id}" value="${i.weightG ?? ""}" ${allocated ? "disabled" : ""}>
                <button class="small" data-action="unitWeight" data-item="${i.id}" ${allocated ? "disabled" : ""}>存</button>
              </div>
              <button class="small plain claim-missing"
                      data-action="missing" data-item="${i.id}" data-missing="${i.missing ? "1" : ""}">
                ${i.missing ? "取消缺件" : "缺件"}
              </button>
            </div>`;
            })
            .join("")}
        </div>
      </div>`,
      )
      .join("")}
    ${
      allocated
        ? ""
        : `<div class="card">
      <label for="price">这一箱国际运费单价（元 / kg）</label>
      <div class="row" style="justify-content:space-between">
        <div class="row">
          <input id="price" inputmode="decimal" style="width:120px" value="${fenToYuan(data.intlPriceFenPerKg)}">
          <button class="small plain" data-action="savePrice">存单价</button>
        </div>
        <button data-action="preview">算分摊</button>
      </div>
      <p class="small muted">开始称之前先把这一箱的单价填好点「存单价」，称完点「算分摊」：各摞重量之和 × 单价就是这一箱运费，每人摊多少当场出来。单价是全箱通用的默认值，下一箱可以直接改；包装箱重量按比例摊给所有人，尾差算需求方的。转运仓那天收得不一样，预览里可以直接改总额再确认。</p>
    </div>`
    }`;

  const reload = () => render(view, [id]);

  bindActions(view, {
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
      if (
        data.customers.some((c) =>
          c.items.some((i) => !i.missing && !i.weightG),
        )
      )
        return toast("请先填写每件商品重量，缺件要明确标记", true);
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
        const body = () => ({
          totalFeeYuan: box.querySelector("#fee").value.trim(),
          totalWeightG:
            box.querySelector("#declared").value.trim() === ""
              ? null
              : Number(box.querySelector("#declared").value.trim()),
        });
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
            <div class="scroll-x"><table>
              <thead><tr><th>客户</th><th class="right">重量</th><th class="right">占比</th><th class="right">应付运费</th></tr></thead>
              <tbody>${p.rows
                .map(
                  (r) => `<tr>
                <td>${escapeHtml(r.nickname)}<div class="small muted">${r.itemCount} 件</div></td>
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
            <label for="fee">这一箱实收的国际运费（元）</label>
            <div class="row">
              <input id="fee" inputmode="decimal" value="${fenToYuan(p.totalFeeFen)}">
              <input id="declared" inputmode="numeric" placeholder="转运仓总重量 g，对账用，可不填">
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
                `已分摊，${result.itemsMovedToStock} 件变成「可发货」，客户页面现在就能申请发货`,
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
        !(await confirmBox("撤销分摊？物品退回「回国中」，客户那边不再显示可发货。", {
          danger: true,
          okText: "撤销",
        }))
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
