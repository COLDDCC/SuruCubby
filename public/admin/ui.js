import { escapeHtml, toast } from '/shared.js';

export { escapeHtml, toast };
export * from '/shared.js';

/** 简易弹窗，返回 Promise：确定 → true，取消 → false。 */
export function confirmBox(message, { okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal">
        <p>${escapeHtml(message)}</p>
        <div class="row" style="justify-content:flex-end">
          <button class="plain" data-no>取消</button>
          <button ${danger ? 'class="danger"' : ''} data-yes>${escapeHtml(okText)}</button>
        </div>
      </div>`;
    const close = (value) => {
      back.remove();
      resolve(value);
    };
    back.querySelector('[data-no]').onclick = () => close(false);
    back.querySelector('[data-yes]').onclick = () => close(true);
    back.onclick = (e) => {
      if (e.target === back) close(false);
    };
    document.body.appendChild(back);
  });
}

/** 输入框弹窗，取消返回 null。 */
export function promptBox(message, defaultValue = '', { okText = '确定', type = 'text' } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal">
        <p>${escapeHtml(message)}</p>
        <input style="width:100%" type="${type}" value="${escapeHtml(defaultValue)}">
        <div class="row" style="justify-content:flex-end;margin-top:12px">
          <button class="plain" data-no>取消</button>
          <button data-yes>${escapeHtml(okText)}</button>
        </div>
      </div>`;
    const input = back.querySelector('input');
    const close = (value) => {
      back.remove();
      resolve(value);
    };
    back.querySelector('[data-no]').onclick = () => close(null);
    back.querySelector('[data-yes]').onclick = () => close(input.value.trim());
    input.onkeydown = (e) => {
      if (e.key === 'Enter') close(input.value.trim());
    };
    document.body.appendChild(back);
    input.focus();
    input.select();
  });
}

/** 打开一个自定义弹窗，内容由 render(close) 提供。 */
export function openModal(render) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  const box = document.createElement('div');
  box.className = 'modal';
  back.appendChild(box);
  const close = () => back.remove();
  back.onclick = (e) => {
    if (e.target === back) close();
  };
  document.body.appendChild(back);
  render(box, close);
  return close;
}

export function empty(text) {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

/**
 * 给容器里所有 [data-action] 元素绑定点击事件。
 * 统一兜错：后端 400/403 的提示必须让群主看见，以前这些报错只进 console，
 * 点第二下「已收款」失败时页面毫无反应，看着像已经记上了。
 */
export function bindActions(root, handlers) {
  root.querySelectorAll('[data-action]').forEach((el) => {
    const handler = handlers[el.dataset.action];
    if (!handler) return;
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      el.disabled = true;
      try {
        await handler(el.dataset, el, e);
      } catch (err) {
        toast(err?.message ? err.message : '这一步没成，刷新后重试', true);
      } finally {
        el.disabled = false;
      }
    });
  });
}

/** 「12.5」「12.5kg」「12500g」→ 克；空 → null。填错的留给后端报错。 */
export function kgToGrams(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  const n = Number(t.replace(/kg|公斤|千克|g|克/g, '').trim());
  if (!Number.isFinite(n) || n <= 0) return t;
  return /(?<!k)g$|克$/.test(t) ? Math.round(n) : Math.round(n * 1000);
}

