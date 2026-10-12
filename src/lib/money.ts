/**
 * 金额处理：对外一律使用整数「分」（人民币）或整数「円」（日元）。
 * 解析 Excel 单元格时要能吃下 "¥1,234.50"、"１２３４"、"1234.5 元"、数字等写法。
 */

const FULLWIDTH_OFFSET = 0xfee0;

/** 全角数字/符号转半角，并去掉各种货币符号、千分位、空白。 */
export function normalizeNumberText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  s = s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - FULLWIDTH_OFFSET));
  s = s.replace(/　/g, ' ');
  s = s.replace(/[,\s]/g, '');
  s = s.replace(/[¥￥$円元人民币日元]/g, '');
  return s.trim();
}

/**
 * 把十进制字符串按 scale 位小数换算成整数，四舍五入（half-up）。
 * 用字符串做，避免浮点误差（0.615 * 100 = 61.49999...）。
 */
export function decimalToScaledInt(text: string, scale: number): number | null {
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return null;
  const negative = text.startsWith('-');
  const body = text.replace(/^[+-]/, '');
  const [intPart, fracPartRaw = ''] = body.split('.');
  const frac = fracPartRaw.padEnd(scale + 1, '0');
  const kept = frac.slice(0, scale);
  const nextDigit = frac.charCodeAt(scale) - 48;
  let value = Number(intPart) * 10 ** scale + (kept === '' ? 0 : Number(kept));
  if (nextDigit >= 5) value += 1;
  return Number.isSafeInteger(value) ? (negative ? -value : value) : null;
}

/** 单元格 → 分。空值返回 null（调用方决定当 0 还是报错）。 */
export function toFen(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return decimalToScaledInt(raw.toFixed(6), 2);
  }
  const s = normalizeNumberText(raw);
  if (s === '') return null;
  return decimalToScaledInt(s, 2);
}

/** 单元格 → 円（整数）。 */
export function toJpy(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return decimalToScaledInt(raw.toFixed(6), 0);
  }
  const s = normalizeNumberText(raw);
  if (s === '') return null;
  return decimalToScaledInt(s, 0);
}

/** 分 → "12.34"，用于展示。 */
export function fenToYuan(fen: number): string {
  const negative = fen < 0;
  const abs = Math.abs(Math.trunc(fen));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${s}` : s;
}
