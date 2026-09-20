/** 前端从工作表里抽地址的逻辑（在线版 Excel 的 =IMAGE 公式就靠它） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellUrl, collectCellUrls, encodeCell } from '../public/admin/sheet.js';

test('单元格地址编码', () => {
  assert.equal(encodeCell(0, 0), 'A1');
  assert.equal(encodeCell(1, 6), 'G2');
  assert.equal(encodeCell(9, 26), 'AA10');
});

test('公式、超链接、被当成文本写出来的公式都能抽出地址', () => {
  // SheetJS 里公式存在 cell.f，不带等号
  assert.equal(cellUrl({ t: 'e', v: '#VALUE!', f: 'IMAGE("https://img/a.png")' }), 'https://img/a.png');
  assert.equal(cellUrl({ f: '_xlfn.IMAGE("https://img/b.png",1)' }), 'https://img/b.png');
  assert.equal(cellUrl({ t: 's', v: '商品页', l: { Target: 'https://suruga-ya.jp/p/1' } }), 'https://suruga-ya.jp/p/1');
  assert.equal(cellUrl({ t: 's', v: '=IMAGE("https://img/c.png")' }), 'https://img/c.png');
  assert.equal(cellUrl({ t: 's', v: '普通文字' }), null);
  assert.equal(cellUrl({ f: 'SUM(A1:A2)' }), null);
  assert.equal(cellUrl(undefined), null);
});

test('按数据区形状铺成一张地址表，表头行不算进去', () => {
  const ws = {
    B1: { t: 's', v: '图片' },
    B2: { t: 'e', v: '#VALUE!', f: 'IMAGE("https://img/a.png")' },
    C3: { t: 's', v: '点这里', l: { Target: 'https://suruga-ya.jp/p/2' } },
  };
  const urls = collectCellUrls(ws, 2, 3);
  assert.deepEqual(urls, [
    [null, 'https://img/a.png', null],
    [null, null, 'https://suruga-ya.jp/p/2'],
  ]);
});
