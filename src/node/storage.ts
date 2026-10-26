/**
 * Node 上替代 Cloudflare 的两样存储，都放在数据目录下：
 *   - DiskImageCache：替代 caches.default，封面代理的回源结果缓到磁盘，超过上限按最久没用的先删；
 *   - DiskBucket：替代 R2，「整理图片」时把封面永久存进自己服务器。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

interface CacheMeta {
  status: number;
  headers: Array<[string, string]>;
}

export class DiskImageCache implements ImageCache {
  readonly #dir: string;
  readonly #maxBytes: number;
  #lastSweep = 0;

  constructor(dir: string, maxBytes: number) {
    this.#dir = dir;
    this.#maxBytes = maxBytes;
    fs.mkdirSync(dir, { recursive: true });
  }

  #paths(request: Request): { body: string; meta: string } {
    const id = sha(new URL(request.url).pathname);
    return { body: path.join(this.#dir, `${id}.bin`), meta: path.join(this.#dir, `${id}.json`) };
  }

  async match(request: Request): Promise<Response | undefined> {
    const p = this.#paths(request);
    try {
      const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')) as CacheMeta;
      const body = fs.readFileSync(p.body);
      const now = new Date();
      fs.utimesSync(p.body, now, now); // 记一下最近用过，清理时留着它
      return new Response(body, { status: meta.status, headers: meta.headers });
    } catch {
      return undefined;
    }
  }

  async put(request: Request, response: Response): Promise<void> {
    const p = this.#paths(request);
    const body = Buffer.from(await response.arrayBuffer());
    const meta: CacheMeta = { status: response.status, headers: [...response.headers.entries()] };
    fs.writeFileSync(p.body + '.tmp', body);
    fs.renameSync(p.body + '.tmp', p.body);
    fs.writeFileSync(p.meta, JSON.stringify(meta));
    this.#sweep();
  }

  /** 最多每 10 分钟扫一次，总量超了就从最久没访问的开始删。 */
  #sweep(): void {
    const now = Date.now();
    if (now - this.#lastSweep < 600_000) return;
    this.#lastSweep = now;
    const files = fs
      .readdirSync(this.#dir)
      .filter((f) => f.endsWith('.bin'))
      .map((f) => {
        const full = path.join(this.#dir, f);
        const st = fs.statSync(full);
        return { full, size: st.size, used: st.mtimeMs };
      })
      .sort((a, b) => a.used - b.used);
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const f of files) {
      if (total <= this.#maxBytes) break;
      fs.rmSync(f.full, { force: true });
      fs.rmSync(f.full.replace(/\.bin$/, '.json'), { force: true });
      total -= f.size;
    }
  }
}

export class DiskBucket implements R2Bucket {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  #file(key: string): string | null {
    // 键由 images.ts 生成（哈希 + 扩展名），这里再兜一道，不许出目录
    if (!/^[A-Za-z0-9._-]+$/.test(key) || key.startsWith('.')) return null;
    return path.join(this.#dir, key);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const file = this.#file(key);
    if (!file) return null;
    try {
      const body = fs.readFileSync(file);
      let contentType = 'image/jpeg';
      try {
        contentType = (JSON.parse(fs.readFileSync(file + '.meta', 'utf8')) as { contentType?: string }).contentType ?? contentType;
      } catch {
        /* 没有元数据就按 jpeg */
      }
      return {
        body: new Blob([body]).stream(),
        httpMetadata: { contentType },
        httpEtag: `"${sha(key).slice(0, 16)}"`,
      };
    } catch {
      return null;
    }
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: R2PutOptions): Promise<unknown> {
    const file = this.#file(key);
    if (!file) throw new Error('图片键不合法');
    const data = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value));
    fs.writeFileSync(file + '.tmp', data);
    fs.renameSync(file + '.tmp', file);
    fs.writeFileSync(file + '.meta', JSON.stringify({ contentType: options?.httpMetadata?.contentType, ...options?.customMetadata }));
    return { key };
  }
}
