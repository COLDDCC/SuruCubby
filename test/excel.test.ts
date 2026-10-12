import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByCn, mapHeaders, parseSheet } from '../src/lib/excel.ts';

const HEADERS = ['名称', '图片', '商品链接', '平时价格', '实际价格', 'cn', '应付人民币金额'];

test('按表头文字定位列，顺序无所谓', () => {
  const map = mapHeaders(['cn', '应付人民币金额(元)', '名称']);
  assert.equal(map.index.cn, 0);
  assert.equal(map.index.goodsFeeFen, 1);
  assert.equal(map.index.title, 2);
  assert.deepEqual(map.missingColumns, []);
});

test('缺必填列时报出缺哪一列', () => {
  const result = parseSheet({ headers: ['名称', '图片'], rows: [] });
  assert.deepEqual(result.missingColumns, ['cn']);
});

test('一行一件，金额换算成分', () => {
  const result = parseSheet({
    headers: HEADERS,
    rows: [
      ['海洋堂手办', 'https://img/1.jpg', 'https://suruga-ya.jp/1', '3,000', '1,800', ' 阿狸 ', '¥98.50'],
      ['同款再来一个', null, null, null, 1800, '阿狸', 98.5],
    ],
  });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].rowNo, 2);
  assert.equal(result.rows[0].cn, '阿狸');
  assert.equal(result.rows[0].listPriceJpy, 3000);
  assert.equal(result.rows[0].actualPriceJpy, 1800);
  assert.equal(result.rows[0].goodsFeeFen, 9850);
  assert.equal(result.rows[1].imageUrl, null);
  assert.equal(result.rows[1].goodsFeeFen, 9850);
});

test('空行、没名称的行跳过并列出来', () => {
  const result = parseSheet({
    headers: HEADERS,
    rows: [
      [null, null, null, null, null, null, null],
      ['', null, null, null, null, '阿狸', '10'],
      ['正常一件', null, null, null, null, '阿狸', '10'],
    ],
  });
  assert.equal(result.rows.length, 1);
  assert.deepEqual(
    result.skipped.map((s) => s.rowNo),
    [2, 3],
  );
});

test('金额看不懂 / 没填 cn 的行进 errors，挡住导入', () => {
  const result = parseSheet({
    headers: HEADERS,
    rows: [
      ['看不懂金额', null, null, null, null, '阿狸', '待定'],
      ['没写归属', null, null, null, null, '', '10'],
    ],
  });
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 2);
});

test('金额为空必须明确填写，避免误算免费订单',()=>{
 const r=parseSheet({headers:['名称','cn','应付人民币金额'],rows:[['手办','A',null]]});
 assert.equal(r.rows.length,0);assert.equal(r.errors.length,1);
});

test('按 cn 分组算小计', () => {
  const result = parseSheet({
    headers: HEADERS,
    rows: [
      ['A', null, null, null, null, '阿狸', '10'],
      ['B', null, null, null, null, '阿狸', '5.55'],
      ['C', null, null, null, null, '小明', '3'],
    ],
  });
  const groups = groupByCn(result.rows);
  assert.equal(groups.length, 2);
  const ali = groups.find((g) => g.cn === '阿狸')!;
  assert.equal(ali.count, 2);
  assert.equal(ali.subtotalFen, 1555);
});

import { extractOgImage } from '../src/lib/ogImage.ts';

test('从商品页里抓 og:image，相对地址会补全', () => {
  const html = '<html><head><meta property="og:image" content="/img/a.jpg"></head></html>';
  assert.equal(extractOgImage(html, 'https://www.suruga-ya.jp/product/1'), 'https://www.suruga-ya.jp/img/a.jpg');
  const reversed = '<meta content="https://cdn/x.png" property="og:image">';
  assert.equal(extractOgImage(reversed, 'https://x/'), 'https://cdn/x.png');
  assert.equal(extractOgImage('<html></html>', 'https://x/'), null);
});

import { extractUrlFromText } from '../src/lib/excel.ts';

test('飞书的 =IMAGE("...") 公式能认出图片地址', () => {
  assert.equal(
    extractUrlFromText('=IMAGE("https://img.feishu.cn/a.png")'),
    'https://img.feishu.cn/a.png',
  );
  assert.equal(extractUrlFromText('=_xlfn.IMAGE("https://x/a.png",1)'), 'https://x/a.png');
  assert.equal(
    extractUrlFromText('=HYPERLINK("https://suruga-ya.jp/p/1","商品页")'),
    'https://suruga-ya.jp/p/1',
  );
  assert.equal(extractUrlFromText('https://x/a.png'), 'https://x/a.png');
  assert.equal(extractUrlFromText('点击查看'), null);
  assert.equal(extractUrlFromText(''), null);
  assert.equal(extractUrlFromText(null), null);
});

test('单元格是空的时候，用公式 / 超链接里抽出来的地址兜底', () => {
  const result = parseSheet({
    headers: HEADERS,
    rows: [
      ['手办', null, '点击查看', null, 1800, '阿狸', '98.5'],
      ['盒蛋', '=IMAGE("https://img/b.png")', null, null, 900, '阿狸', '45'],
    ],
    urls: [
      [null, 'https://img/a.png', 'https://suruga-ya.jp/p/1', null, null, null, null],
      [null, null, null, null, null, null, null],
    ],
  });
  assert.equal(result.rows[0].imageUrl, 'https://img/a.png');
  assert.equal(result.rows[0].productUrl, 'https://suruga-ya.jp/p/1');
  assert.equal(result.rows[1].imageUrl, 'https://img/b.png');
  assert.equal(result.rows[1].productUrl, null);
});

test('数量拆为独立商品，人民币行总额拆分后不丢分',()=>{
 const r=parseSheet({headers:['名称','客户名字','数量','应付人民币金额'],rows:[['手办','A',3,'10.00']]});
 assert.equal(r.errors.length,0);assert.equal(r.rows.length,3);assert.equal(r.rows.reduce((s,i)=>s+i.goodsFeeFen,0),1000);
});
test('只有日元价格时必须给汇率，不能把日元当人民币',()=>{
 const sheet={headers:['名称','客户名字','数量','价格'],rows:[['手办','A',2,1000]]};
 assert.equal(parseSheet(sheet).errors.length,1);
 assert.equal(parseSheet(sheet,0.05).rows.reduce((s,i)=>s+i.goodsFeeFen,0),10000);
});
