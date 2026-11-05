import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellPosition, columnName, flattenCell, parseFeishuUrl } from '../src/lib/feishu.ts';

test('认飞书链接：表格 / 知识库 / 带页签', () => {
  assert.deepEqual(parseFeishuUrl('https://abc.feishu.cn/sheets/shtcnXYZ123?sheet=0b12cd'), { kind: 'sheet', token: 'shtcnXYZ123', sheetId: '0b12cd' });
  assert.deepEqual(parseFeishuUrl('https://abc.feishu.cn/wiki/wikcnAbC9'), { kind: 'wiki', token: 'wikcnAbC9', sheetId: null });
  assert.equal(parseFeishuUrl('https://example.com/sheets/abc'), null, '别的网站不认');
  assert.equal(parseFeishuUrl('不是链接'), null);
  assert.equal(parseFeishuUrl('https://abc.feishu.cn/docx/abc'), null, '文档不是表格');
});

test('列名和格子位置', () => {
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.deepEqual(cellPosition('0b12cd!C5:C5'), [4, 2]);
  assert.deepEqual(cellPosition('AB10'), [9, 27]);
});

test('拍平飞书单元格：文本、数字、富文本链接、单元格图片', () => {
  assert.deepEqual(flattenCell(null), { text: null, link: null, fileToken: null });
  assert.deepEqual(flattenCell(1800), { text: 1800, link: null, fileToken: null });
  assert.deepEqual(
    flattenCell([{ type: 'text', text: '看 ' }, { type: 'url', text: '商品页', link: 'https://www.suruga-ya.jp/product/detail/602170001' }]),
    { text: '看 商品页', link: 'https://www.suruga-ya.jp/product/detail/602170001', fileToken: null },
  );
  assert.deepEqual(flattenCell({ type: 'embed-image', fileToken: 'boxcnIMG', width: 100, height: 100 }), {
    text: null,
    link: null,
    fileToken: 'boxcnIMG',
  });
});
