/**
 * 飞书表格导入（国内版 open.feishu.cn）。
 *
 * 用「企业自建应用」的 App ID / App Secret 换 tenant_access_token，再读表：
 *   1. 链接可以是 /sheets/{token} 也可以是知识库里的 /wiki/{token}（先换成表格 token）；
 *      链接里带 ?sheet=xxx 就读那一页，否则读第一页；
 *   2. 读出来的单元格整理成和 Excel 导入一样的 { headers, rows, urls }，后面走同一套预览 / 列对应 / 确认；
 *   3. 单元格里插的图片（和浮动图片）用「下载素材」接口拿原图，直接存进自己服务器，
 *      地址 /img/{key} 填进 urls 对应的格子 —— 不用再去商品页抓图。
 *
 * 表格要在飞书里「…→ 更多 → 添加文档应用」把这个应用加进去，否则会返回没有权限。
 */
import type { Env } from './env.ts';
import { getSetting } from './db.ts';
import { CACHED_PREFIX, imageKey } from './images.ts';

const BASE = 'https://open.feishu.cn/open-apis';
const MAX_ROWS = 2000;
const MAX_COLS = 40;

export class FeishuError extends Error {}

let tokenCache: { appId: string; token: string; expires: number } | null = null;

export async function feishuCredentials(env: Env): Promise<{ appId: string; appSecret: string } | null> {
  const appId = (await getSetting(env, 'feishu_app_id', '')).trim();
  const appSecret = (await getSetting(env, 'feishu_app_secret', '')).trim();
  return appId && appSecret ? { appId, appSecret } : null;
}

/** 飞书返回的错误码翻成人话（只翻常见的）。 */
function explain(code: number, msg: string): string {
  const known: Record<number, string> = {
    10003: 'App ID 不对',
    10014: 'App Secret 不对',
    99991663: 'App ID / Secret 不对，或者应用还没发布',
    99991672: '应用没开通「查看电子表格」权限，去飞书开放平台的「权限管理」开通并发布新版本',
    99991679: '应用没开通需要的权限，去飞书开放平台的「权限管理」开通并发布新版本',
    1310213: '应用没有这张表的权限：在飞书表格右上角「…→ 更多 → 添加文档应用」把应用加进去',
    91403: '应用没有这张表的权限：在飞书表格右上角「…→ 更多 → 添加文档应用」把应用加进去',
    131006: '应用没有这个知识库页面的权限：在页面右上角「…→ 添加文档应用」把应用加进去',
    1310214: '这张表不存在，或者链接复制错了',
    91402: '这张表不存在，或者链接复制错了',
  };
  return known[code] ?? `飞书返回错误 ${code}：${msg}`;
}

async function tenantToken(appId: string, appSecret: string): Promise<string> {
  if (tokenCache && tokenCache.appId === appId && tokenCache.expires > Date.now()) return tokenCache.token;
  let res: Response;
  try {
    res = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new FeishuError('连不上飞书开放平台（open.feishu.cn），稍后再试');
  }
  const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
  if (data.code !== 0 || !data.tenant_access_token) throw new FeishuError(explain(data.code ?? res.status, data.msg ?? ''));
  tokenCache = { appId, token: data.tenant_access_token, expires: Date.now() + Math.max(60, (data.expire ?? 7200) - 300) * 1000 };
  return data.tenant_access_token;
}

async function call<T>(token: string, path: string): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (attempt < 2) continue;
      throw new FeishuError('连不上飞书开放平台，稍后再试');
    }
    const data = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: T };
    // 频率限制：等一下再来
    if ((res.status === 429 || data.code === 99991400) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (data.code !== 0) throw new FeishuError(explain(data.code ?? res.status, data.msg ?? ''));
    return data.data as T;
  }
}

/** 从链接里认出表格 / 知识库 token 和页签。 */
export function parseFeishuUrl(input: string): { kind: 'sheet' | 'wiki'; token: string; sheetId: string | null } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)(feishu\.cn|larkoffice\.com|feishu\.net)$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/\/(sheets|wiki)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  return { kind: m[1] === 'wiki' ? 'wiki' : 'sheet', token: m[2], sheetId: url.searchParams.get('sheet') };
}

/** 0 基列号 → A、B … Z、AA */
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** "Sheet1!B3" / "B3:B3" → 0 基 [行, 列] */
export function cellPosition(ref: string): [number, number] | null {
  const m = /([A-Z]+)(\d+)/.exec(ref.split('!').pop() ?? '');
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, col - 1];
}

type Cell = string | number | boolean | null;

interface Flat {
  text: Cell;
  link: string | null;
  fileToken: string | null;
}

/**
 * 飞书单元格的值有好几种形状：
 *   字符串 / 数字；富文本是一串片段 [{type:'text',text}, {type:'url',text,link}, {type:'mention',...}]；
 *   单元格图片是 {type:'embed-image', fileToken, ...}。统一拍平成文本 + 链接 + 图片 token。
 */
export function flattenCell(value: unknown): Flat {
  if (value === null || value === undefined) return { text: null, link: null, fileToken: null };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { text: value, link: null, fileToken: null };
  }
  const parts = Array.isArray(value) ? value : [value];
  let text = '';
  let link: string | null = null;
  let fileToken: string | null = null;
  for (const part of parts) {
    if (part === null || part === undefined) continue;
    if (typeof part !== 'object') {
      text += String(part);
      continue;
    }
    const p = part as Record<string, unknown>;
    const token = p.fileToken ?? p.file_token ?? p.imageToken ?? p.image_token;
    if (typeof token === 'string' && token) fileToken ??= token;
    const l = p.link ?? p.url;
    if (typeof l === 'string' && /^https?:\/\//i.test(l)) link ??= l;
    if (typeof p.text === 'string') text += p.text;
  }
  return { text: text === '' ? null : text, link, fileToken };
}

/** 下载一张素材存进自己的存储，返回 /img/{key}。存不了就返回 null。 */
async function storeMedia(env: Env, token: string, fileToken: string): Promise<string | null> {
  if (!env.IMAGES) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/drive/v1/medias/${encodeURIComponent(fileToken)}/download`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!res.ok || !type.startsWith('image/')) return null;
      const body = await res.arrayBuffer();
      if (!body.byteLength || body.byteLength > 10 * 1024 * 1024) return null;
      const key = await imageKey(`feishu:${fileToken}`, type);
      await env.IMAGES.put(key, body, {
        httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
        customMetadata: { source: `feishu:${fileToken}` },
      });
      return `${CACHED_PREFIX}${key}`;
    } catch {
      /* 再试 */
    }
  }
  return null;
}

export interface FeishuSheet {
  title: string;
  sheetTitle: string;
  headers: Cell[];
  rows: Cell[][];
  urls: (string | null)[][];
  images: { found: number; stored: number };
}

export async function readFeishuSheet(env: Env, link: string): Promise<FeishuSheet> {
  const creds = await feishuCredentials(env);
  if (!creds) throw new FeishuError('还没填飞书应用的 App ID / App Secret，去「设置 → 飞书表格」填上');
  const parsed = parseFeishuUrl(link);
  if (!parsed) throw new FeishuError('认不出这个链接，要飞书表格的链接（…feishu.cn/sheets/… 或 …feishu.cn/wiki/…）');
  const token = await tenantToken(creds.appId, creds.appSecret);

  let spreadsheetToken = parsed.token;
  if (parsed.kind === 'wiki') {
    const node = await call<{ node: { obj_token: string; obj_type: string } }>(token, `/wiki/v2/spaces/get_node?token=${parsed.token}&obj_type=wiki`);
    if (node.node.obj_type !== 'sheet') throw new FeishuError('这个知识库页面不是电子表格');
    spreadsheetToken = node.node.obj_token;
  }

  const meta = await call<{ spreadsheet: { title: string } }>(token, `/sheets/v3/spreadsheets/${spreadsheetToken}`).catch(() => ({ spreadsheet: { title: '' } }));
  const list = await call<{
    sheets: Array<{ sheet_id: string; title: string; index: number; resource_type?: string; grid_properties?: { row_count: number; column_count: number } }>;
  }>(token, `/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`);
  const sheets = list.sheets.filter((s) => !s.resource_type || s.resource_type === 'sheet').sort((a, b) => a.index - b.index);
  const sheet = (parsed.sheetId && sheets.find((s) => s.sheet_id === parsed.sheetId)) || sheets[0];
  if (!sheet) throw new FeishuError('这张表里没有可以读的工作表');

  const rowCount = Math.min(MAX_ROWS + 1, sheet.grid_properties?.row_count ?? 500);
  const colCount = Math.min(MAX_COLS, sheet.grid_properties?.column_count ?? 26);
  const range = `${sheet.sheet_id}!A1:${columnName(colCount - 1)}${rowCount}`;
  const values = await call<{ valueRange: { values: unknown[][] } }>(
    token,
    `/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}?dateTimeRenderOption=FormattedString`,
  );
  const raw = values.valueRange?.values ?? [];

  const flat = raw.map((row) => (row ?? []).map(flattenCell));
  // 浮动图片：挂在某个格子上，读出来放进那一格（读不到不影响导入）
  try {
    const floats = await call<{ items: Array<{ float_image_token: string; range: string }> }>(
      token,
      `/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/${sheet.sheet_id}/float_images/query`,
    );
    for (const f of floats.items ?? []) {
      const pos = cellPosition(f.range);
      if (!pos || !f.float_image_token) continue;
      const [r, c] = pos;
      while (flat.length <= r) flat.push([]);
      while (flat[r].length <= c) flat[r].push({ text: null, link: null, fileToken: null });
      flat[r][c].fileToken ??= f.float_image_token;
    }
  } catch {
    /* 没权限或没有浮动图片 */
  }

  // 去掉末尾的空行
  const isEmpty = (row: Flat[]) => row.every((x) => (x.text === null || String(x.text).trim() === '') && !x.link && !x.fileToken);
  while (flat.length > 1 && isEmpty(flat[flat.length - 1])) flat.pop();
  if (flat.length < 2) throw new FeishuError('这张表没有数据行（第一行要是表头）');
  if (flat.length > MAX_ROWS + 1) throw new FeishuError(`一次最多导入 ${MAX_ROWS} 行`);

  const width = Math.max(...flat.map((r) => r.length));
  const pad = (row: Flat[]) => Array.from({ length: width }, (_, i) => row[i] ?? { text: null, link: null, fileToken: null });
  const headerRow = pad(flat[0]);
  const body = flat.slice(1).map(pad);

  // 图片一张张下（飞书限 5 次 / 秒），同一张图只下一次
  const stored = new Map<string, string | null>();
  let found = 0;
  for (const row of body) for (const cell of row) if (cell.fileToken) found += 1;
  for (const row of body) {
    for (const cell of row) {
      if (!cell.fileToken || stored.has(cell.fileToken)) continue;
      stored.set(cell.fileToken, await storeMedia(env, token, cell.fileToken));
      await new Promise((r) => setTimeout(r, 220));
    }
  }

  return {
    title: meta.spreadsheet.title || '',
    sheetTitle: sheet.title,
    headers: headerRow.map((c) => c.text),
    rows: body.map((row) => row.map((c) => c.text)),
    urls: body.map((row) => row.map((c) => (c.fileToken ? stored.get(c.fileToken) ?? null : null) ?? c.link)),
    images: { found, stored: [...stored.values()].filter(Boolean).length },
  };
}

/** 设置页的「测试一下」：只换 token，不读表。 */
export async function testFeishu(appId: string, appSecret: string): Promise<void> {
  tokenCache = null;
  await tenantToken(appId, appSecret);
}
