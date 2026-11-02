import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * /tools/weigh-bill.html 是单文件工具（也要能原样放到 toolfavor 上），
 * 计费逻辑写在页面里 CORE-START / CORE-END 之间，这里把那一段原样取出来测。
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'public/tools/weigh-bill.html'), 'utf8');
const src = html.split('/*CORE-START*/')[1].split('/*CORE-END*/')[0];
const Core = new Function(`${src}; return Core;`)();

const RULES = {
  mode: 'perkg', unitPrice: 15, firstWeight: 1, firstPrice: 20, addStep: 0.5, addPrice: 8,
  weightStep: '0.1', minCharge: 0, surcharge: 0, groupMode: 'item',
  quoteCur: 'CNY', collectCur: 'CNY', rate: 21, finalRound: '0.01',
};
const run = (text, rules = {}, unit = 'auto') => {
  const parsed = Core.parse(text, unit);
  return { parsed, res: Core.compute(parsed.pieces, { ...RULES, ...rules }) };
};
const due = (r) => Object.fromEntries(r.res.rows.map((x) => [x.name, x.due]));

const TABLE = '客户\t运单号\t毛重\n小A\tSF1029384756\t1.32\n小A\tSF1029384757\t0.48\n\tSF1029384758\t2.05\n阿梅\tYT8812345678\t0.86';

test('表头识别、客户格留空沿用上一行', () => {
  const r = run(TABLE);
  assert.equal(r.parsed.pieces.length, 4);
  assert.deepEqual(r.parsed.warnings, []);
  assert.deepEqual(r.res.rows.map((x) => [x.name, x.count]), [['小A', 3], ['阿梅', 1]]);
});

test('逐件计费：每件先进位到 0.1kg 再乘单价', () => {
  // 1.32→1.4、0.48→0.5、2.05→2.1，共 4.0kg × 15 = 60；0.86→0.9 × 15 = 13.5
  assert.deepEqual(due(run(TABLE)), { 小A: 60, 阿梅: 13.5 });
});

test('整数重量不会因为浮点被多进一档', () => {
  assert.equal(run('客户\t运单号\t毛重\n甲\tSF1\t0.30').res.rows[0].billW, 0.3);
  assert.equal(run('客户\t运单号\t毛重\n甲\tSF1\t0.7\n甲\tSF2\t0.1').res.rows[0].billW, 0.8);
  assert.equal(run('客户\t运单号\t毛重\n甲\tSF1\t1.5', { weightStep: '0.5' }).res.rows[0].billW, 1.5);
});

test('合并称重：一个客户的毛重加起来算一次', () => {
  const r = run(TABLE, { groupMode: 'merge', weightStep: '0.5' });
  assert.deepEqual(r.res.rows.map((x) => [x.name, x.gross, x.billW, x.due]), [
    ['小A', 3.85, 4, 60],
    ['阿梅', 0.86, 1, 15],
  ]);
});

test('首重续重 + 最低收费 + 每件附加费', () => {
  // 首重 1kg 20 元，续重每 0.5kg 8 元，最低 25 元，每件附加 2 元
  // 小A：1.4kg=20+8=28；0.5kg=20→最低 25；2.1kg=20+3×8=44；+3×2 → 103
  const r = run(TABLE, { mode: 'firstadd', minCharge: 25, surcharge: 2 });
  assert.deepEqual(due(r), { 小A: 103, 阿梅: 27 });
});

test('人民币报价、日元收款，尾数进位到 10 円', () => {
  const r = run(TABLE, { collectCur: 'JPY', finalRound: '10' });
  assert.deepEqual(due(r), { 小A: 1260, 阿梅: 290 }); // 13.5 × 21 = 283.5 → 290
});

test('日元报价、人民币收款，尾数进位到元', () => {
  const r = run(TABLE, { quoteCur: 'JPY', unitPrice: 2000, finalRound: '1' });
  assert.deepEqual(due(r), { 小A: 381, 阿梅: 86 }); // 8000/21=380.95→381；1800/21=85.71→86
});

test('人民币进位到角', () => {
  const r = run('客户\t运单号\t毛重\n甲\tSF1\t0.11', { unitPrice: 13, finalRound: '0.1' });
  assert.equal(r.res.rows[0].due, 2.6); // 0.11 → 0.2kg × 13 = 2.6，本来就是整角，不再多进
  const r2 = run('客户\t运单号\t毛重\n甲\tSF1\t0.1', { unitPrice: 12.34, finalRound: '0.1' });
  assert.equal(r2.res.rows[0].due, 1.3); // 1.234 → 1.3
});

test('没有客户列时用「客户：昵称」分组，g 和 kg 混写都认', () => {
  const r = run('客户：小B\nYT8812345678\t860g\nYT8812345679\t1.2kg\n客户：小C\nZZ12345678 1500');
  assert.deepEqual(r.res.rows.map((x) => [x.name, x.count, x.gross]), [['小B', 2, 2.06], ['小C', 1, 1.5]]);
});

test('表头写了 (g) 就按克', () => {
  const r = run('客户\t运单号\t重量(g)\n丁\tSF11112222\t1320');
  assert.equal(r.parsed.pieces[0].grossKg, 1.32);
  assert.equal(r.parsed.assumedUnit, null);
});

test('认不出的行不悄悄漏算，而是列出来', () => {
  const r = run('运单号\t毛重\nSF11112222\t1.3\n小E SF99990000 abc');
  const msgs = r.parsed.warnings.map((w) => `${w.line}:${w.msg}`);
  assert.equal(r.parsed.pieces.length, 0);
  assert.ok(msgs.some((m) => m.startsWith('2:') && m.includes('哪个客户')));
  assert.ok(msgs.some((m) => m.startsWith('3:')));
});

test('运单号重复会提醒', () => {
  const r = run('客户\t运单号\t毛重\n甲\tSF1234567\t1\n乙\tSF1234567\t1');
  assert.ok(r.parsed.warnings.some((w) => w.msg.includes('运单号重复')));
});

test('合计等于各人之和', () => {
  const r = run(TABLE, { collectCur: 'JPY', finalRound: '10' });
  assert.equal(r.res.total.due, r.res.rows.reduce((s, x) => s + x.due, 0));
  assert.equal(r.res.total.count, 4);
});
