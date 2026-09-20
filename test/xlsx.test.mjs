/**
 * 拿一个「像 Excel（在线版）保存出来」的真 .xlsx，用 SheetJS 解一遍，
 * 验证前端那套抽地址的逻辑确实能把 IMAGE() 公式和超链接里的地址捞出来。
 *
 * SheetJS 只在这里用到，而且不进 package.json（npm 上最新只有带 CVE 的 0.18.5）。
 * 想跑这个测试：
 *   npm i --no-save xlsx && node --test test/xlsx.test.mjs
 * 没装就自动跳过，不影响 npm test。
 *
 * 固定文件由 test/fixtures/make-fixture.py 生成。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectCellUrls } from '../public/admin/sheet.js';
import { parseSheet } from '../src/lib/excel.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/online-excel-image.xlsx', import.meta.url));

let XLSX = null;
try {
  XLSX = (await import('xlsx')).default;
} catch {
  /* 没装就跳过 */
}

test('真 .xlsx：IMAGE() 公式和超链接里的图片地址都能捞出来', { skip: XLSX ? false : '没装 xlsx（npm i --no-save xlsx）' }, () => {
  const wb = XLSX.read(fs.readFileSync(FIXTURE), { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const body = rows.slice(1);

  // 先确认「只读值」确实会把图片整列丢掉——这正是要修的问题
  assert.equal(body[0][1], null, '图片列的单元格值本来就是空的');
  assert.equal(body[0][2], null, '只有超链接的单元格也是空的');

  // 再确认抽地址这一步能补回来
  const urls = collectCellUrls(ws, body.length, rows[0].length);
  assert.equal(urls[0][1], 'https://img.example.com/a.png', '_xlfn.IMAGE 公式');
  assert.equal(urls[0][2], 'https://www.suruga-ya.jp/product/detail/1', '超链接');
  assert.equal(urls[1][1], 'https://img.example.com/b.png', 'IMAGE 公式');

  // 整条链路：解析出来的物品行上要带着图片和商品链接
  const parsed = parseSheet({ headers: rows[0], rows: body, urls });
  assert.deepEqual(parsed.missingColumns, []);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].title, '手办A');
  assert.equal(parsed.rows[0].imageUrl, 'https://img.example.com/a.png');
  assert.equal(parsed.rows[0].productUrl, 'https://www.suruga-ya.jp/product/detail/1');
  assert.equal(parsed.rows[0].goodsFeeFen, 9850);
  assert.equal(parsed.rows[0].actualPriceJpy, 1800);
  assert.equal(parsed.rows[1].imageUrl, 'https://img.example.com/b.png');
  assert.equal(parsed.rows[1].productUrl, 'https://www.suruga-ya.jp/product/detail/2');
});
