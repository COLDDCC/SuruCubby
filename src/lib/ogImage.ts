/**
 * 从商品页面里找封面图。
 * 【待确认】如果 Excel 的「图片」列本身就是图片链接，这一步根本用不上；
 * 只有当图片是嵌在 Excel 里（SheetJS 社区版取不到）时，才用它来补图。
 */
const PATTERNS = [
  /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["']/i,
];

export function extractOgImage(html: string, baseUrl: string): string | null {
  for (const pattern of PATTERNS) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      try {
        return new URL(match[1], baseUrl).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function fetchOgImage(productUrl: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(productUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; SuruCubby/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200_000);
    return extractOgImage(html, url.toString());
  } catch {
    return null;
  }
}
