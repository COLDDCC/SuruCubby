/**
 * 把导入页要用的 SheetJS 下载到 public/vendor/，页面从自己域名加载，国内不用碰境外 CDN。
 *
 *   npm run vendor
 *
 * 在 VPS 上（香港 / 东京）跑一次即可；deploy/setup.sh 和 deploy/update.sh 会自动跑。
 * 已经有这个文件就跳过，加 --force 重新下载。
 */
import fs from 'node:fs';
import path from 'node:path';

const VERSION = '0.20.3';
const URL_ = `https://cdn.sheetjs.com/xlsx-${VERSION}/package/dist/xlsx.full.min.js`;
const target = path.resolve('public/vendor/xlsx.full.min.js');

if (fs.existsSync(target) && !process.argv.includes('--force')) {
  console.log(`已有 ${path.relative(process.cwd(), target)}，跳过（--force 可重新下载）`);
  process.exit(0);
}

const res = await fetch(URL_, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) {
  console.error(`下载失败：${res.status} ${URL_}`);
  process.exit(1);
}
const text = await res.text();
if (!text.includes('XLSX') || text.length < 100_000) {
  console.error('下载到的内容不像 SheetJS，放弃写入');
  process.exit(1);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, text);
console.log(`SheetJS ${VERSION} 已保存到 ${path.relative(process.cwd(), target)}（${(text.length / 1024).toFixed(0)} KB）`);
