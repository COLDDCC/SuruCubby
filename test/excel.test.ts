import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByCn, mapHeaders, parseSheet } from "../src/lib/excel.ts";

const HEADERS = [
  "名称",
  "图片",
  "商品链接",
  "平时价格",
  "实际价格",
  "cn",
  "应付日元金额",
];

test("按表头文字定位列，顺序无所谓", () => {
  const map = mapHeaders(["cn", "应付日元金额(円)", "名称"]);
  assert.equal(map.index.cn, 0);
  assert.equal(map.index.goodsFeeJpy, 1);
  assert.equal(map.index.title, 2);
  assert.deepEqual(map.missingColumns, []);
});

test("表头带币种后缀（円）时，价格列不能被短别名「円」抢成货款列", () => {
  const map = mapHeaders(["名称", "平时价格（円）", "实际价格（円）", "cn"]);
  assert.equal(map.index.listPriceJpy, 1);
  assert.equal(map.index.actualPriceJpy, 2);
  assert.equal(map.index.goodsFeeJpy, undefined);
  const result = parseSheet({
    headers: ["名称", "平时价格（円）", "实际价格（円）", "cn"],
    rows: [["手办", 3000, 1800, "阿狸"]],
  });
  assert.equal(result.errors.length, 0);
  assert.equal(
    result.rows[0].goodsFeeJpy,
    1800,
    "货款取实际价格，不是平时价格",
  );
});

test("缺必填列时报出缺哪一列", () => {
  const result = parseSheet({ headers: ["名称", "图片"], rows: [] });
  assert.deepEqual(result.missingColumns, ["cn"]);
});

test("一行一件，货款就是日元实际价格", () => {
  const result = parseSheet({
    headers: HEADERS,
    rows: [
      [
        "海洋堂手办",
        "https://img/1.jpg",
        "https://suruga-ya.jp/1",
        "3,000",
        "1,800",
        " 阿狸 ",
        "1800",
      ],
      ["同款再来一个", null, null, null, 900, "阿狸", 900],
    ],
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].rowNo, 2);
  assert.equal(result.rows[0].cn, "阿狸");
  assert.equal(result.rows[0].listPriceJpy, 3000);
  assert.equal(result.rows[0].actualPriceJpy, 1800);
  assert.equal(result.rows[0].goodsFeeJpy, 1800);
  assert.equal(result.rows[1].imageUrl, null);
  assert.equal(result.rows[1].goodsFeeJpy, 900);
});

test("没有日元金额列时，按「实际价格」记货款，全程不碰汇率", () => {
  const result = parseSheet({
    headers: ["名称", "图片", "商品链接", "平时价格", "实际价格", "cn"],
    rows: [
      [
        "駿河屋 - 中古 A",
        null,
        "https://www.suruga-ya.jp/product/detail/ZHONA1",
        1500,
        1100,
        "默默",
      ],
      [
        "駿河屋 - 中古 B",
        null,
        "https://www.suruga-ya.jp/product/detail/ZHONA2",
        450,
        400,
        "念念",
      ],
    ],
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].goodsFeeJpy, 1100);
  assert.equal(result.rows[0].listPriceJpy, 1500);
  assert.equal(result.rows[1].goodsFeeJpy, 400);
});

test("空行、没名称的行跳过并列出来", () => {
  const result = parseSheet({
    headers: HEADERS,
    rows: [
      [null, null, null, null, null, null, null],
      ["", null, null, null, null, "阿狸", "1000"],
      ["正常一件", null, null, null, null, "阿狸", "1000"],
    ],
  });
  assert.equal(result.rows.length, 1);
  assert.deepEqual(
    result.skipped.map((s) => s.rowNo),
    [2, 3],
  );
});

test("金额看不懂 / 没填 cn 的行进 errors，挡住导入", () => {
  const result = parseSheet({
    headers: HEADERS,
    rows: [
      ["看不懂金额", null, null, null, null, "阿狸", "待定"],
      ["没写归属", null, null, null, null, "", "1000"],
    ],
  });
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 2);
});

test("有日元金额列却没填数：必须明确填写，避免把免费订单算漏", () => {
  const r = parseSheet({
    headers: ["名称", "cn", "应付日元金额"],
    rows: [["手办", "A", null]],
  });
  assert.equal(r.rows.length, 0);
  assert.equal(r.errors.length, 1);
});

test("按 cn 分组算小计（円）", () => {
  const result = parseSheet({
    headers: HEADERS,
    rows: [
      ["A", null, null, null, null, "阿狸", "1000"],
      ["B", null, null, null, null, "阿狸", "555"],
      ["C", null, null, null, null, "小明", "300"],
    ],
  });
  const groups = groupByCn(result.rows);
  assert.equal(groups.length, 2);
  const ali = groups.find((g) => g.cn === "阿狸")!;
  assert.equal(ali.count, 2);
  assert.equal(ali.subtotalJpy, 1555);
});

import { extractOgImage } from "../src/lib/ogImage.ts";

test("从商品页里抓 og:image，相对地址会补全", () => {
  const html =
    '<html><head><meta property="og:image" content="/img/a.jpg"></head></html>';
  assert.equal(
    extractOgImage(html, "https://www.suruga-ya.jp/product/1"),
    "https://www.suruga-ya.jp/img/a.jpg",
  );
  const reversed = '<meta content="https://cdn/x.png" property="og:image">';
  assert.equal(extractOgImage(reversed, "https://x/"), "https://cdn/x.png");
  assert.equal(extractOgImage("<html></html>", "https://x/"), null);
});

import { extractUrlFromText } from "../src/lib/excel.ts";

test('飞书的 =IMAGE("...") 公式能认出图片地址', () => {
  assert.equal(
    extractUrlFromText('=IMAGE("https://img.feishu.cn/a.png")'),
    "https://img.feishu.cn/a.png",
  );
  assert.equal(
    extractUrlFromText('=_xlfn.IMAGE("https://x/a.png",1)'),
    "https://x/a.png",
  );
  assert.equal(
    extractUrlFromText('=HYPERLINK("https://suruga-ya.jp/p/1","商品页")'),
    "https://suruga-ya.jp/p/1",
  );
  assert.equal(extractUrlFromText("https://x/a.png"), "https://x/a.png");
  assert.equal(extractUrlFromText("点击查看"), null);
  assert.equal(extractUrlFromText(""), null);
  assert.equal(extractUrlFromText(null), null);
});

test("单元格是空的时候，用公式 / 超链接里抽出来的地址兜底", () => {
  const result = parseSheet({
    headers: HEADERS,
    rows: [
      ["手办", null, "点击查看", null, 1800, "阿狸", "1800"],
      ["盒蛋", '=IMAGE("https://img/b.png")', null, null, 900, "阿狸", "900"],
    ],
    urls: [
      [
        null,
        "https://img/a.png",
        "https://suruga-ya.jp/p/1",
        null,
        null,
        null,
        null,
      ],
      [null, null, null, null, null, null, null],
    ],
  });
  assert.equal(result.rows[0].imageUrl, "https://img/a.png");
  assert.equal(result.rows[0].productUrl, "https://suruga-ya.jp/p/1");
  assert.equal(result.rows[1].imageUrl, "https://img/b.png");
  assert.equal(result.rows[1].productUrl, null);
});

test("数量拆为独立商品，日元行总额拆分后一日不丢", () => {
  const r = parseSheet({
    headers: ["名称", "客户名字", "数量", "应付日元金额"],
    rows: [["手办", "A", 3, "1000"]],
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(
    r.rows.map((i) => i.goodsFeeJpy),
    [334, 333, 333],
  );
});

test("表头写着「数量」但装的是价格：整批拦下来说清楚，不当成 1500 件入库", () => {
  const sheet = {
    headers: ["名称", "图片", "商品链接", "数量", "价格", "cn"],
    rows: [
      ["A", null, "https://x/1", 1500, 1100, "默默"],
      ["B", null, "https://x/2", 450, 400, "默默"],
      ["C", null, "https://x/3", 4230, 3100, "念念"],
    ],
  };
  const blocked = parseSheet(sheet);
  assert.equal(blocked.rows.length, 0);
  assert.equal(blocked.errors.length, 1);
  assert.equal(blocked.errors[0].rowNo, 0);
  assert.match(blocked.errors[0].reason, /数量/);
  assert.match(blocked.errors[0].reason, /平时价格/);
});

test("把「数量」列指认成平时价格后，同一张表能正常导入", () => {
  const sheet = {
    headers: ["名称", "图片", "商品链接", "数量", "价格", "cn"],
    rows: [
      ["A", null, "https://x/1", 1500, 1100, "默默"],
      ["B", null, "https://x/2", 450, 400, "默默"],
      ["C", null, "https://x/3", 4230, 3100, "念念"],
    ],
  };
  const ok = parseSheet(sheet, { columns: { "3": "listPriceJpy" } });
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.rows.length, 3);
  assert.equal(
    ok.rows.reduce((s, i) => s + i.goodsFeeJpy, 0),
    4600,
  );
  assert.equal(ok.rows[0].listPriceJpy, 1500);
  assert.equal(ok.columns.find((c) => c.index === 3)?.field, "listPriceJpy");
  assert.equal(ok.columns.find((c) => c.index === 3)?.manual, true);
  assert.equal(ok.columns.find((c) => c.index === 4)?.field, "actualPriceJpy");
});

test("指认成「不使用」的列不再被表头猜走", () => {
  const sheet = {
    headers: ["名称", "数量", "实际价格", "cn"],
    rows: [["A", 3, 1000, "甲"]],
  };
  const r = parseSheet(sheet, { columns: { "1": null } });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].goodsFeeJpy, 1000);
});

test("发货方式：直邮 / 拼团 / 空着 = 拼团，看不懂的拦下", () => {
  const result = parseSheet({
    headers: ["名称", "实际价格", "cn", "发货方式", "收货地址"],
    rows: [
      ["A", 100, "阿狸", "直邮", "上海市 某路 1 号 张三 13800000000"],
      ["B", 100, "阿狸", "拼团", "这个地址不该留"],
      ["C", 100, "小明", "", null],
      ["D", 100, "小明", "EMS", null],
      ["E", 100, "小红", "随便", null],
    ],
  });
  assert.deepEqual(
    result.rows.map((r) => [r.title, r.route, r.directAddress]),
    [
      ["A", "direct", "上海市 某路 1 号 张三 13800000000"],
      ["B", "group", null],
      ["C", "group", null],
      ["D", "direct", null],
    ],
  );
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].reason, /发货方式/);
});

test("「收货地址」列认成直邮地址，不会被当成商品链接", () => {
  const map = mapHeaders(["名称", "cn", "实际价格", "收货地址", "商品链接"]);
  assert.equal(map.index.directAddress, 3);
  assert.equal(map.index.productUrl, 4);
});

test("没有发货方式这一列的旧表照常导入，全部是拼团", () => {
  const result = parseSheet({ headers: ["名称", "实际价格", "cn"], rows: [["A", 1, "x"], ["B", 2, "y"]] });
  assert.ok(result.rows.every((r) => r.route === "group" && r.directAddress === null));
});
