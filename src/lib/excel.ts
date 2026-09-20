/**
 * Excel 行 → 物品。前端用 SheetJS 解析成 { headers, rows }，映射与校验都放在这里，
 * 方便单元测试，也保证预览与真正导入用的是同一套规则。
 */
import { toFen, toJpy } from './money.ts';

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

export interface ParsedRow {
  rowNo: number;
  title: string;
  imageUrl: string | null;
  productUrl: string | null;
  listPriceJpy: number | null;
  actualPriceJpy: number | null;
  cn: string;
  goodsFeeFen: number;
}

export interface SkippedRow {
  rowNo: number;
  reason: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  skipped: SkippedRow[];
  /** 阻止导入的问题行（例如金额看不懂） */
  errors: SkippedRow[];
  missingColumns: string[];
}

interface ColumnSpec {
  field: keyof ParsedRow;
  label: string;
  required: boolean;
  aliases: string[];
}

const COLUMNS: ColumnSpec[] = [
  { field: 'title', label: '名称', required: true, aliases: ['名称', '商品名称', '品名', '商品名'] },
  { field: 'imageUrl', label: '图片', required: false, aliases: ['图片', '图片链接', '封面', '图'] },
  {
    field: 'productUrl',
    label: '商品链接',
    required: false,
    aliases: ['商品链接', '链接', '商品url', 'url', '地址'],
  },
  {
    field: 'listPriceJpy',
    label: '平时价格',
    required: false,
    aliases: ['平时价格', '平时价', '参考价格', '参考价'],
  },
  {
    field: 'actualPriceJpy',
    label: '实际价格',
    required: false,
    aliases: ['实际价格', '实际价', '成交价格', '成交价'],
  },
  { field: 'cn', label: 'cn', required: true, aliases: ['cn', '客户', '归属', '归属人', '买家'] },
  {
    field: 'goodsFeeFen',
    label: '应付人民币金额',
    required: true,
    aliases: ['应付人民币金额', '应付人民币', '应付金额', '人民币金额', '人民币', '应付'],
  },
];

export function normalizeHeader(raw: Cell): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, '')
    .replace(/[（）()：:\-_/\\]/g, '')
    .toLowerCase();
}

export interface HeaderMap {
  index: Partial<Record<keyof ParsedRow, number>>;
  missingColumns: string[];
}

/** 按表头文字定位列，不按列序号。 */
export function mapHeaders(headers: Cell[]): HeaderMap {
  const normalized = headers.map(normalizeHeader);
  const index: Partial<Record<keyof ParsedRow, number>> = {};
  const missingColumns: string[] = [];
  for (const col of COLUMNS) {
    let found = -1;
    for (const alias of col.aliases) {
      const target = normalizeHeader(alias);
      found = normalized.indexOf(target);
      if (found >= 0) break;
    }
    if (found < 0) {
      // 退一步做包含匹配，容忍「应付人民币金额(元)」这类带后缀的表头
      found = normalized.findIndex(
        (h) => h !== '' && col.aliases.some((a) => h.includes(normalizeHeader(a))),
      );
    }
    if (found >= 0) index[col.field] = found;
    else if (col.required) missingColumns.push(col.label);
  }
  return { index, missingColumns };
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
  if (value === '') return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('=')) {
    const match = URL_IN_FORMULA.exec(value);
    if (match && /^https?:\/\//i.test(match[1])) return match[1];
  }
  return null;
}

function text(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  return String(cell).trim();
}

function optionalText(cell: Cell): string | null {
  const t = text(cell);
  return t === '' ? null : t;
}

/**
 * 解析整张表。rowNo 为 Excel 中的行号（表头算第 1 行，数据从第 2 行开始）。
 */
export function parseSheet(sheet: RawSheet): ParseResult {
  const { index, missingColumns } = mapHeaders(sheet.headers);
  if (missingColumns.length > 0) {
    return { rows: [], skipped: [], errors: [], missingColumns };
  }
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const errors: SkippedRow[] = [];

  sheet.rows.forEach((row, i) => {
    const rowNo = i + 2;
    const get = (field: keyof ParsedRow): Cell => {
      const at = index[field];
      return at === undefined ? null : row[at];
    };
    /** 链接类的列：单元格文本 → 公式 / 超链接里的地址 */
    const getUrl = (field: keyof ParsedRow): string | null => {
      const at = index[field];
      if (at === undefined) return null;
      return extractUrlFromText(row[at]) ?? sheet.urls?.[i]?.[at] ?? null;
    };
    const isEmptyRow = row.every((cell) => text(cell) === '');
    if (isEmptyRow) {
      skipped.push({ rowNo, reason: '空行' });
      return;
    }
    const title = text(get('title'));
    if (title === '') {
      skipped.push({ rowNo, reason: '没有「名称」' });
      return;
    }
    const cn = text(get('cn'));
    if (cn === '') {
      errors.push({ rowNo, reason: '没有填「cn」（归属客户）' });
      return;
    }
    const rawFee = get('goodsFeeFen');
    let goodsFeeFen = 0;
    if (text(rawFee) !== '') {
      const parsed = toFen(rawFee);
      if (parsed === null) {
        errors.push({ rowNo, reason: `「应付人民币金额」看不懂：${text(rawFee)}` });
        return;
      }
      goodsFeeFen = parsed;
    } else {
      skipped.push({ rowNo, reason: '「应付人民币金额」为空，按 0 元导入' });
    }
    rows.push({
      rowNo,
      title,
      imageUrl: getUrl('imageUrl'),
      productUrl: getUrl('productUrl'),
      listPriceJpy: toJpy(get('listPriceJpy')),
      actualPriceJpy: toJpy(get('actualPriceJpy')),
      cn,
      goodsFeeFen,
    });
  });

  return { rows, skipped, errors, missingColumns };
}

export interface CnGroup {
  cn: string;
  count: number;
  subtotalFen: number;
  rowNos: number[];
}

/** 按 cn 分组，用于预览。 */
export function groupByCn(rows: ParsedRow[]): CnGroup[] {
  const map = new Map<string, CnGroup>();
  for (const row of rows) {
    const g = map.get(row.cn) ?? { cn: row.cn, count: 0, subtotalFen: 0, rowNos: [] };
    g.count += 1;
    g.subtotalFen += row.goodsFeeFen;
    g.rowNos.push(row.rowNo);
    map.set(row.cn, g);
  }
  return [...map.values()].sort((a, b) => a.cn.localeCompare(b.cn, 'zh-Hans-CN'));
}
