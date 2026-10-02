/** Least-recently-used cache bounded by total size (bytes by default) as well as entry count. */
export class LruCache<V> {
  private map = new Map<string, { value: V; size: number }>();
  private total = 0;

  constructor(private readonly opts: { maxSize: number; maxEntries?: number; sizeOf?: (v: V) => number }) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // Re-insert to mark as most recently used (Map keeps insertion order).
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    const size = this.opts.sizeOf ? this.opts.sizeOf(value) : ((value as { byteLength?: number }).byteLength ?? 1);
    if (size > this.opts.maxSize) return;
    this.delete(key);
    this.map.set(key, { value, size });
    this.total += size;
    const maxEntries = this.opts.maxEntries ?? Number.POSITIVE_INFINITY;
    while (this.total > this.opts.maxSize || this.map.size > maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const hit = this.map.get(key);
    if (!hit) return;
    this.total -= hit.size;
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.total;
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}
