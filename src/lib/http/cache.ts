export interface CachedResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: Date;
  expiresAt: Date;
}

export interface HttpCacheStore {
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, value: CachedResponse): Promise<void>;
}

export class MemoryCacheStore implements HttpCacheStore {
  readonly entries = new Map<string, CachedResponse>();

  async get(key: string) {
    return this.entries.get(key) ?? null;
  }

  async set(key: string, value: CachedResponse) {
    this.entries.set(key, value);
  }
}
