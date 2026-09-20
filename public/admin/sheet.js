/**
 * 从 SheetJS 的工作表对象里，把「藏在单元格背后的地址」抽出来。
 *
 * 在线版 Excel（以及飞书表格）里的图片是 =IMAGE("https://...") 渲染的，存成 xlsx 之后：
 *   - 单元格的值（cell.v）通常是空的，甚至是 #VALUE! 错误；
 *   - 真正的地址只存在公式（cell.f）或超链接（cell.l.Target）里。
 * 所以光读值会把图片全丢掉。这里生成一张和数据区同形状的地址表，
 * 服务端解析「图片」「商品链接」两列时优先用它。
 *
 * 单独放一个文件是为了能在 Node 里直接测（不依赖浏览器和 SheetJS）。
 */

const URL_IN_FORMULA = /(?:_xlfn\.)?(?:IMAGE|HYPERLINK|DISPIMG)\s*\(\s*["']([^"']+)["']/i;

/** 0 基的行列号 → "A1" 这样的单元格地址。 */
export function encodeCell(row, col) {
  let name = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return `${name}${row + 1}`;
}

/** 单个单元格里能找到的地址，找不到返回 null。 */
export function cellUrl(cell) {
  if (!cell) return null;
  let url = null;
  if (typeof cell.f === 'string') {
    const match = URL_IN_FORMULA.exec(cell.f.startsWith('=') ? cell.f : `=${cell.f}`);
    if (match) url = match[1];
  }
  if (!url && typeof cell.v === 'string' && cell.v.trim().startsWith('=')) {
    const match = URL_IN_FORMULA.exec(cell.v.trim());
    if (match) url = match[1];
  }
  if (!url && cell.l && typeof cell.l.Target === 'string') url = cell.l.Target;
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * @param ws         SheetJS 的工作表对象
 * @param rowCount   数据行数（不含表头）
 * @param colCount   列数
 * @param firstDataRow 数据区第一行在表里的 0 基行号，默认 1（第 1 行是表头）
 */
export function collectCellUrls(ws, rowCount, colCount, firstDataRow = 1) {
  const urls = [];
  for (let r = 0; r < rowCount; r += 1) {
    const line = new Array(colCount).fill(null);
    for (let c = 0; c < colCount; c += 1) {
      line[c] = cellUrl(ws[encodeCell(firstDataRow + r, c)]);
    }
    urls.push(line);
  }
  return urls;
}
