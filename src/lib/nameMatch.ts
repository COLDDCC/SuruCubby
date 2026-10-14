/**
 * 认人：团购表里 cn 列写的是客户随口起的名字，同一个人在不同表里可能写成
 * 「阿狸」「阿狸 」「Ａ狸」，也可能因为群主改过昵称而对不上号。
 * 这里把「名字 → 客户」做成一张带归一化索引的表，导入时先自动认，认不准才让人挑。
 */

export interface NameCustomer {
  id: number;
  qq: string;
  nickname: string;
  token: string;
}

export interface NameMatch {
  customer: NameCustomer | null;
  /** exact=表头写法一模一样；normalized=去掉空格/全角/大小写差异后唯一命中；
   *  ambiguous=归一化之后撞在好几个客户身上；none=完全没印象 */
  by: 'exact' | 'normalized' | 'ambiguous' | 'none';
  candidates: NameCustomer[];
}

export interface NameIndex {
  exact: Map<string, NameCustomer>;
  normalized: Map<string, NameCustomer[]>;
}

/** 全角转半角、去掉所有空白、统一大小写。不动括号等标点：那是区分两个人的线索。 */
export function normalizeName(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, '')
    .toLowerCase();
}

const PAGE = 100;

/** D1 一次查询给的行数有限，客户多了要翻页 */
async function page<T>(db: D1Database, sql: string, offset: number): Promise<T[]> {
  const result = await db.prepare(`${sql} LIMIT ${PAGE} OFFSET ${offset}`).all<T & Record<string, unknown>>();
  return result.results as unknown as T[];
}

export async function buildNameIndex(db: D1Database): Promise<NameIndex> {
  const exact = new Map<string, NameCustomer>();
  const normalized = new Map<string, NameCustomer[]>();
  const add = (name: string, customer: NameCustomer) => {
    exact.set(name, customer);
    const key = normalizeName(name);
    if (!key) return;
    const list = normalized.get(key) ?? [];
    if (!list.some((c) => c.id === customer.id)) normalized.set(key, [...list, customer]);
  };

  for (let offset = 0; ; offset += PAGE) {
    const rows = await page<{ alias: string } & NameCustomer>(
      db,
      `SELECT a.alias, c.id, c.qq, c.nickname, c.token
         FROM customer_aliases a JOIN customers c ON c.id = a.customer_id
        ORDER BY a.alias`,
      offset,
    );
    for (const row of rows)
      add(row.alias, {
        id: row.id,
        qq: row.qq,
        nickname: row.nickname,
        token: row.token,
      });
    if (rows.length < PAGE) break;
  }

  // 昵称本身也当一次名字用：万一历史数据里有人改过昵称没登记别名，还能认出来
  for (let offset = 0; ; offset += PAGE) {
    const rows = await page<NameCustomer>(db, 'SELECT id, qq, nickname, token FROM customers ORDER BY id', offset);
    for (const row of rows) {
      const customer = {
        id: row.id,
        qq: row.qq,
        nickname: row.nickname,
        token: row.token,
      };
      const key = normalizeName(row.nickname);
      const list = normalized.get(key) ?? [];
      if (!list.some((c) => c.id === customer.id)) normalized.set(key, [...list, customer]);
      if (!exact.has(row.nickname)) exact.set(row.nickname, customer);
    }
    if (rows.length < PAGE) break;
  }

  return { exact, normalized };
}

export function matchName(index: NameIndex, cn: string): NameMatch {
  const hit = index.exact.get(cn);
  if (hit) return { customer: hit, by: 'exact', candidates: [hit] };
  const candidates = index.normalized.get(normalizeName(cn)) ?? [];
  if (candidates.length === 1) return { customer: candidates[0], by: 'normalized', candidates };
  if (candidates.length > 1) return { customer: null, by: 'ambiguous', candidates };
  return { customer: null, by: 'none', candidates: [] };
}
