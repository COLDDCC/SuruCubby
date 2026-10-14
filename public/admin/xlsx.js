/** 读 Excel 用的 SheetJS：优先自托管（国内快），没有再退回官方 CDN。 */

const LOCAL_XLSX = '/vendor/xlsx.full.min.js';
const CDN_XLSX = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`加载失败：${src}`));
    document.head.appendChild(el);
  });
}

export async function loadXlsx() {
  if (window.XLSX) return window.XLSX;
  try {
    await loadScript(LOCAL_XLSX);
  } catch {
    await loadScript(CDN_XLSX);
  }
  if (!window.XLSX) throw new Error('SheetJS 没加载成功，检查网络或把 xlsx.full.min.js 放到 /vendor/ 下');
  return window.XLSX;
}

/**
 * CSV 是纯文本，SheetJS 按 array 读会把 UTF-8 的中文字节当成 latin-1，名字全变成乱码。
 * Excel 中文「另存为 CSV」又常常是 GBK，所以先按 UTF-8 严解，解不动才当 GBK。
 */
function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gbk').decode(bytes);
  }
}

/**
 * 第一张工作表 → { headers, rows }。
 * blankrows: true —— 中间的空行也要占位，否则后面所有行的「Excel 行号」和
 * 从公式里抽出来的地址都会对不上号。末尾整行空着的可以砍掉。
 */
export async function readSheet(file) {
  const XLSX = await loadXlsx();
  const buffer = await file.arrayBuffer();
  const options = { cellFormula: true, cellHyperlinks: true };
  const wb = /\.csv|\.txt|\.tsv$/i.test(file.name)
    ? XLSX.read(decodeText(buffer), { ...options, type: 'string' })
    : XLSX.read(buffer, { ...options, type: 'array' });
  const name = wb.SheetNames[0];
  const ws = wb.Sheets[name];
  const all = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  if (all.length < 2) throw new Error(`${name}：这张表除了表头没有内容`);
  const headers = all[0];
  const rows = all.slice(1);
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === null || String(cell).trim() === '')) {
    rows.pop();
  }
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length));
  return {
    sheetName: name,
    workbook: wb,
    worksheet: ws,
    headers: headers.map((h, i) =>
      h === null || h === undefined || String(h).trim() === '' ? `第 ${i + 1} 列` : String(h).trim(),
    ),
    rows: rows.map((r) => Array.from({ length: colCount }, (_, i) => r[i] ?? null)),
    colCount,
  };
}
