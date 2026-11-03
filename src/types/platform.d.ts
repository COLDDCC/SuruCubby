/**
 * 代码里用到的那一小块 Cloudflare 运行时接口。
 *
 * 以前直接依赖 @cloudflare/workers-types；现在同一份代码既跑在 Workers 上，
 * 也跑在 Node（VPS）上，所以只声明真正用到的部分：
 *   - Workers 上，真正的 D1 / R2 / ASSETS 结构上完全满足这些接口；
 *   - Node 上，src/node/ 里的适配层实现同样的接口。
 * 类型检查不再需要装 workers-types。
 */

interface D1Meta {
  changes: number;
  last_row_id: number;
  [key: string]: unknown;
}

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T = unknown>(column: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface R2HTTPMetadata {
  contentType?: string;
  cacheControl?: string;
}

interface R2ObjectBody {
  body: ReadableStream;
  httpMetadata?: R2HTTPMetadata;
  httpEtag: string;
}

interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: R2PutOptions): Promise<unknown>;
}

interface Fetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

/** caches.default 的子集；Node 上由磁盘缓存实现。 */
interface ImageCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
