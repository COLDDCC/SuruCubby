/**
 * Excel 行 → 物品。前端用 SheetJS 解析成 { headers, rows }，映射与校验都放在这里，
 * 方便单元测试，也保证预览与真正导入用的是同一套规则。
 *
 * 钱的口径：货款一律记日元（円），不按汇率折成人民币——汇率波动由客户付款时自己承担，
 * 群主预先折算只会在结算时吃差价。人民币只出现在国际运费和国内运费上。
 */
import { toJpy } from "./money.ts";

export type Cell = string | number | boolean | null | undefined;

export interface RawSheet {
  headers: Cell[];
  rows: Cell[][];
  /**
   * 与 rows 同形状的「单元格里藏着的地址」。
   * 在线版 Excel / 飞书表格用 =IMAGE("https://...") 渲染图片，存成 xlsx 后单元格本身往往是空的，
   * 地址只存在于公式或超链接里；前端把它们抽出来放这里，图片 / 商品链接两列优先用。
   */
  urls?: (string | null)[][];
}

export type FieldKey =
  | "title"
  | "imageUrl"
  | "productUrl"
  | "listPriceJpy"
  | "actualPriceJpy"
  | "goodsFeeJpy"
  | "quantity"
  | "cn"
  | "route"
  | "directAddress"
  | "jpTrackingNo"
  | "orderedAt";

export interface ParsedRow {
  rowNo: number;
  title: string;
  imageUrl: string | null;
  productUrl: string | null;
  listPriceJpy: number | null;
  actualPriceJpy: number | null;
  cn: string;
  /** 这一件应付的货款，单位：円 */
  goodsFeeJpy: number;
  /** 发货方式：表里没写就是拼团 */
  route: "group" | "direct";
  /** 直邮地址（只有直邮行才留） */
  directAddress: string | null;
  /** 这一件在哪个日本快递箱（日本运单号），表里没写就是 null，分拣时再记 */
  jpTrackingNo: string | null;
  /** 下单日期 YYYY-MM-DD，表里没写就是 null（用导入时填的订单日期） */
  orderedAt: string | null;
}

export interface SkippedRow {
  rowNo: number;
  reason: string;
}

export interface ColumnInfo {
  index: number;
  header: string;
  field: FieldKey | null;
  /** 这一列由管理员手动指认过，不再自作主张 */
  manual: boolean;
}

export interface ParseResult {
  rows: ParsedRow[];
  skipped: SkippedRow[];
  /** 阻止导入的问题行（例如金额看不懂） */
  errors: SkippedRow[];
  missingColumns: string[];
  columns: ColumnInfo[];
  /** 表头在表里第几行（1 起）。表格上面常有一两行标题（「10月骏河屋拼团」），表头不一定在第 1 行 */
  headerRow: number;
}

interface ColumnSpec {
  field: FieldKey;
  label: string;
  required: boolean;
  aliases: string[];
}

const COLUMNS: ColumnSpec[] = [
  {
    field: "goodsFeeJpy",
    label: "应付日元金额",
    required: false,
    // 故意不收「金额 / 小计 / 应付人民币金额」这类写法：人民币金额列不能当货款用
    aliases: [
      "应付日元金额",
      "日元金额",
      "应付日元",
      "应付円",
      "円金额",
      "应付金额",
      "円",
    ],
  },
  {
    field: "listPriceJpy",
    label: "平时价格",
    required: false,
    aliases: ["平时价格", "平时价", "原价", "参考价格", "参考价", "定价"],
  },
  {
    field: "actualPriceJpy",
    label: "实际价格",
    required: false,
    aliases: [
      "实际价格",
      "实际价",
      "成交价格",
      "成交价",
      "实付",
      "价格",
      "单价",
    ],
  },
  {
    field: "quantity",
    label: "数量",
    required: false,
    aliases: ["数量", "件数", "个数", "quantity", "qty"],
  },
  {
    field: "title",
    label: "名称",
    required: true,
    aliases: ["名称", "商品名称", "品名", "商品名"],
  },
  {
    field: "imageUrl",
    label: "图片",
    required: false,
    aliases: ["图片", "图片链接", "封面", "图"],
  },
  {
    field: "route",
    label: "发货方式",
    required: false,
    aliases: ["发货方式", "寄送方式", "邮寄方式", "配送方式", "发货", "路线", "直邮拼团"],
  },
  {
    field: "directAddress",
    label: "直邮地址",
    required: false,
    // 排在「商品链接」前面：它的别名里有「地址」两个字，不能让「收货地址」被当成商品链接
    aliases: ["直邮地址", "收货地址", "收件地址", "寄送地址", "邮寄地址", "收件人地址"],
  },
  {
    field: "jpTrackingNo",
    label: "日本运单号",
    required: false,
    aliases: [
      "日本运单号",
      "日本单号",
      "日本物流单号",
      "日本快递单号",
      "运单号",
      "追踪号",
      "伝票番号",
      "問い合わせ番号",
      "お問い合わせ番号",
    ],
  },
  {
    field: "orderedAt",
    label: "下单时间",
    required: false,
    aliases: ["下单时间", "下单日期", "订单日期", "购买日期", "购买时间", "注文日", "注文日時"],
  },
  {
    field: "productUrl",
    label: "商品链接",
    required: false,
    aliases: ["商品链接", "链接", "商品url", "url", "地址"],
  },
  {
    field: "cn",
    label: "cn",
    required: true,
    aliases: ["cn", "客户", "客户名字", "归属", "归属人", "买家"],
  },
];

/** 给前端做「Excel 列 → 用途」下拉用，顺序与 label 保持一致。 */
export const FIELD_LABELS: Array<{ field: FieldKey; label: string }> =
  COLUMNS.map((c) => ({
    field: c.field,
    label: c.label,
  }));

const SPEC_BY_FIELD = new Map(COLUMNS.map((c) => [c.field, c]));

export function normalizeHeader(raw: Cell): string {
  if (raw === null || raw === undefined) return "";
  return String(raw)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, "")
    .replace(/[（）()：:\-_/\\]/g, "")
    .toLowerCase();
}

export interface HeaderMap {
  index: Partial<Record<FieldKey, number>>;
  missingColumns: string[];
  columns: ColumnInfo[];
}

/**
 * 按表头文字定位列，不按列序号。
 * edits 是管理员在预览里改过的列：key 是 Excel 列序号，value 是用途，null 表示「这列不用」。
 * 没出现在 edits 里的列仍然按表头自动认，所以「管理员点过」和「程序猜的」能区分开。
 */
export function mapHeaders(
  headers: Cell[],
  edits?: Record<string, FieldKey | null>,
): HeaderMap {
  const normalized = headers.map(normalizeHeader);
  const headerText = headers.map((h) => text(h));
  const fieldAt = new Map<number, FieldKey>();
  const manual = new Set<number>();

  const claim = (field: FieldKey, at: number, byHand: boolean) => {
    for (const [otherIndex, otherField] of fieldAt) {
      if (otherField === field && otherIndex !== at) fieldAt.delete(otherIndex);
    }
    fieldAt.set(at, field);
    if (byHand) manual.add(at);
  };

  for (const [raw, field] of Object.entries(edits ?? {})) {
    const at = Number(raw);
    if (!Number.isInteger(at) || at < 0 || at >= headers.length) continue;
    if (field === null || field === undefined) {
      fieldAt.delete(at);
      manual.add(at);
      continue;
    }
    if (!SPEC_BY_FIELD.has(field) || normalized[at] === "") continue;
    claim(field, at, true);
  }

  const claimable = (i: number) =>
    normalized[i] !== "" && !fieldAt.has(i) && !manual.has(i);
  const unfilled = (col: ColumnSpec) =>
    ![...fieldAt.values()].includes(col.field);

  // 分全局两轮：先让每个字段抢「表头整词等于别名」的列，剩下的才做包含匹配。
  // 不能一个字段一轮抢到底，否则「实际价格（円）」会被排在前面的短别名「円」截走。
  for (const col of COLUMNS) {
    if (!unfilled(col)) continue;
    const targets = col.aliases.map(normalizeHeader);
    const found = normalized.findIndex(
      (h, i) => claimable(i) && targets.includes(h),
    );
    if (found >= 0) claim(col.field, found, false);
  }

  for (const col of COLUMNS) {
    if (!unfilled(col)) continue;
    // 单字别名不做包含匹配：「平时价格（円）」含「円」，按原价列当货款会让客户多付
    const loose = col.aliases.map(normalizeHeader).filter((a) => a.length >= 2);
    // 退一步做包含匹配，容忍「应付人民币金额(元)」这类带后缀的表头
    const found = normalized.findIndex(
      (h, i) => claimable(i) && loose.some((a) => h.includes(a)),
    );
    if (found >= 0) claim(col.field, found, false);
  }

  const index: Partial<Record<FieldKey, number>> = {};
  for (const [at, field] of fieldAt) index[field] = at;

  const missingColumns: string[] = [];
  for (const col of COLUMNS) {
    if (col.required && index[col.field] === undefined)
      missingColumns.push(col.label);
  }

  const columns: ColumnInfo[] = headerText.map((header, i) => ({
    index: i,
    header,
    field: fieldAt.get(i) ?? null,
    manual: manual.has(i),
  }));

  return { index, missingColumns, columns };
}

const URL_IN_FORMULA =
  /(?:_xlfn\.)?(?:IMAGE|HYPERLINK|DISPIMG|_xlfn\.DISPIMG)\s*\(\s*["']([^"']+)["']/i;

/**
 * 从单元格文本里找出地址：
 *   - 直接是 http(s) 链接
 *   - 是 =IMAGE("...") / =HYPERLINK("...","显示文字") 这类公式（有些导出会把公式当文本写出来）
 * 普通文字（「点击查看」之类）返回 null。
 */
export function extractUrlFromText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (value === "") return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("=")) {
    const match = URL_IN_FORMULA.exec(value);
    if (match && /^https?:\/\//i.test(match[1])) return match[1];
  }
  return null;
}

/**
 * 表里的日期 → YYYY-MM-DD。SheetJS 按原值读，日期单元格是 Excel 序列号（45000 上下）；
 * 文本的「2026/10/20」「2026-10-20 13:00」「2026年10月20日」也认。看不懂返回 null（不拦导入，用订单日期兜底）。
 */
export function parseDateCell(raw: Cell): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") {
    if (raw < 20000 || raw > 80000) return null;
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const value = String(raw).trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 运单号：去掉空格和横线（日本邮便的单号常写成 4908-1234-5678），太长的不认。 */
export function normalizeTrackingNo(raw: Cell): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).replace(/[\s\-－ー]/g, "").trim();
  if (value === "" || value.length > 40) return null;
  return value;
}

const DIRECT_WORDS = /直邮|直发|直寄|直送|单独寄|单独发|ems|epacket|e包裹|小包|航空|sal/i;
const GROUP_WORDS = /拼团|拼邮|拼箱|集运|合箱|合包|回国|转运|团/;

/** 发货方式单元格 → group / direct；空 = 拼团；看不懂返回 null。 */
export function parseRoute(raw: Cell): "group" | "direct" | null {
  const value = text(raw);
  if (value === "") return "group";
  if (DIRECT_WORDS.test(value)) return "direct";
  if (GROUP_WORDS.test(value)) return "group";
  return null;
}

function text(cell: Cell): string {
  if (cell === null || cell === undefined) return "";
  // 控制字符（复制网页时夹带的 \x00、\x0b 之类）去掉：存进库里会让导出和复制都出怪字
  return String(cell).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
}

/** 往下最多找几行表头 */
const HEADER_SCAN_ROWS = 10;

/**
 * 表头不在第 1 行时往下找：第 1 行认不出「名称」「cn」，就看接下来几行，
 * 第一行能把必需的列都认出来的就是表头，它上面的标题行丢掉、下面才是数据。
 * 只看自动识别、不看手动指认：这样预览和导入、改列前和改列后认的都是同一行表头
 * （手动指认按列号算，表头挪了列号也不变）。
 */
export function locateHeader(sheet: RawSheet): { sheet: RawSheet; headerRow: number } {
  if (!mapHeaders(sheet.headers).missingColumns.length) return { sheet, headerRow: 1 };
  const limit = Math.min(HEADER_SCAN_ROWS - 1, sheet.rows.length);
  for (let k = 0; k < limit; k += 1) {
    const candidate = sheet.rows[k];
    if (!candidate || mapHeaders(candidate).missingColumns.length) continue;
    return {
      sheet: { headers: candidate, rows: sheet.rows.slice(k + 1), urls: sheet.urls?.slice(k + 1) },
      headerRow: k + 2,
    };
  }
  return { sheet, headerRow: 1 };
}

/**
 * 「数量」列里全是大于 10 的整数时，基本可以断定这列装的是价格（骏河屋的表就长这样：
 * 表头写着数量，底下是 210、4230 这样的平时价格）。这时候绝不能按 210 件入库，
 * 整批拦下来让管理员去指认列的用途。管理员手动指定过这一列的话就不再猜。
 */
function quantityLooksLikePrice(rows: Cell[][], at: number): boolean {
  const values: number[] = [];
  for (const row of rows) {
    const cell = row[at];
    if (cell === null || cell === undefined || text(cell) === "") continue;
    const n = toJpy(cell);
    if (n === null || !Number.isSafeInteger(n)) return false;
    values.push(n);
  }
  if (values.length < 2) return false;
  return values.every((v) => v > 10);
}

export interface ParseOptions {
  /** 管理员改过的列：key 是 Excel 列序号，value 是用途，null 表示这列不用 */
  columns?: Record<string, FieldKey | null>;
}

/**
 * 解析整张表。rowNo 为 Excel 中的行号（表头算第 1 行，数据从第 2 行开始）。
 */
export function parseSheet(
  rawSheet: RawSheet,
  options: ParseOptions = {},
): ParseResult {
  const located = locateHeader(rawSheet);
  const sheet = located.sheet;
  const headerRow = located.headerRow;
  const { index, missingColumns, columns } = mapHeaders(
    sheet.headers,
    options.columns,
  );
  if (missingColumns.length > 0) {
    return { rows: [], skipped: [], errors: [], missingColumns, columns, headerRow };
  }

  if (
    index.quantity !== undefined &&
    !columns.find((c) => c.index === index.quantity)?.manual &&
    quantityLooksLikePrice(sheet.rows, index.quantity)
  ) {
    const header =
      columns.find((c) => c.index === index.quantity)?.header ?? "数量";
    return {
      rows: [],
      skipped: [],
      errors: [
        {
          rowNo: 0,
          reason:
            `「${header}」列里的数全都大于 10，不像是数量，更像是价格。` +
            `请在上面的「列对应关系」里把这列改成「平时价格」（数量就按 1 件算），或者把 Excel 里的数量填对。`,
        },
      ],
      missingColumns: [],
      columns,
      headerRow,
    };
  }

  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const errors: SkippedRow[] = [];

  sheet.rows.forEach((row, i) => {
    const rowNo = i + headerRow + 1;
    const get = (field: FieldKey): Cell => {
      const at = index[field];
      return at === undefined ? null : row[at];
    };
    /** 链接类的列：单元格文本 → 公式 / 超链接里的地址 */
    const getUrl = (field: FieldKey): string | null => {
      const at = index[field];
      if (at === undefined) return null;
      return extractUrlFromText(row[at]) ?? sheet.urls?.[i]?.[at] ?? null;
    };
    const isEmptyRow = row.every((cell) => text(cell) === "");
    if (isEmptyRow) {
      skipped.push({ rowNo, reason: "空行" });
      return;
    }
    const title = text(get("title"));
    if (title === "") {
      skipped.push({ rowNo, reason: "没有「名称」" });
      return;
    }
    if (title.length > 500) {
      errors.push({ rowNo, reason: `「名称」太长了（${title.length} 个字，最多 500），多半是把整页内容粘进了一格` });
      return;
    }
    const cn = text(get("cn"));
    if (cn === "") {
      errors.push({ rowNo, reason: "没有填「cn」（归属客户）" });
      return;
    }
    if (cn.length > 60) {
      errors.push({ rowNo, reason: `「cn」太长了（${cn.length} 个字，最多 60）` });
      return;
    }

    const route = parseRoute(get("route"));
    if (route === null) {
      errors.push({
        rowNo,
        reason: `「发货方式」看不懂：${text(get("route"))}（写「直邮」或「拼团」，空着就是拼团）`,
      });
      return;
    }
    const directAddress = route === "direct" ? text(get("directAddress")) || null : null;
    if (directAddress && directAddress.length > 300) {
      errors.push({ rowNo, reason: "直邮地址太长了，最多 300 个字" });
      return;
    }

    let quantity = 1;
    if (index.quantity !== undefined) {
      const raw = get("quantity");
      if (text(raw) !== "") {
        const parsed = toJpy(raw);
        if (
          parsed === null ||
          !Number.isSafeInteger(parsed) ||
          parsed < 1 ||
          parsed > 1000
        ) {
          errors.push({
            rowNo,
            reason: `「数量」必须是 1 至 1000 的整数，这一行是：${text(raw)}`,
          });
          return;
        }
        quantity = parsed;
      }
    }

    let goodsFeeJpy: number | null = null;
    const rawFee = get("goodsFeeJpy");
    if (index.goodsFeeJpy !== undefined && text(rawFee) !== "") {
      const parsed = toJpy(rawFee);
      if (parsed === null || parsed < 0 || !Number.isSafeInteger(parsed)) {
        errors.push({ rowNo, reason: `日元金额看不懂：${text(rawFee)}` });
        return;
      }
      goodsFeeJpy = parsed;
    } else if (index.goodsFeeJpy === undefined) {
      const price = toJpy(get("actualPriceJpy"));
      if (price === null || price < 0) {
        errors.push({
          rowNo,
          reason:
            "这一行没有日元价格，请填「实际价格」，或把某一列指认成「应付日元金额」",
        });
        return;
      }
      goodsFeeJpy = price * quantity;
    } else {
      errors.push({ rowNo, reason: "日元金额不能为空，免费物品填 0" });
      return;
    }
    if (!Number.isSafeInteger(goodsFeeJpy) || goodsFeeJpy > 1_000_000_000) {
      errors.push({ rowNo, reason: "金额超出范围" });
      return;
    }

    for (let unit = 0; unit < quantity; unit++) {
      rows.push({
        rowNo,
        title,
        imageUrl: getUrl("imageUrl"),
        productUrl: getUrl("productUrl"),
        listPriceJpy: toJpy(get("listPriceJpy")),
        actualPriceJpy: toJpy(get("actualPriceJpy")),
        cn,
        // 一行多件时按件拆分，除不尽的零头摊在前几件上，合计与表里填的总额一分不差
        goodsFeeJpy:
          Math.floor(goodsFeeJpy / quantity) +
          (unit < goodsFeeJpy % quantity ? 1 : 0),
        route,
        directAddress,
        jpTrackingNo: normalizeTrackingNo(get("jpTrackingNo")),
        orderedAt: parseDateCell(get("orderedAt")),
      });
    }
  });

  return { rows, skipped, errors, missingColumns, columns, headerRow };
}

export interface CnGroup {
  cn: string;
  count: number;
  subtotalJpy: number;
  rowNos: number[];
}

/** 按 cn 分组，用于预览。 */
export function groupByCn(rows: ParsedRow[]): CnGroup[] {
  const map = new Map<string, CnGroup>();
  for (const row of rows) {
    const g = map.get(row.cn) ?? {
      cn: row.cn,
      count: 0,
      subtotalJpy: 0,
      rowNos: [],
    };
    g.count += 1;
    g.subtotalJpy += row.goodsFeeJpy;
    g.rowNos.push(row.rowNo);
    map.set(row.cn, g);
  }
  return [...map.values()].sort((a, b) =>
    a.cn.localeCompare(b.cn, "zh-Hans-CN"),
  );
}
