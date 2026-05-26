export class LRUCache<T> {
  private map = new Map<string, { value: T; expiry: number }>();
  private maxSize: number;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  get(key: string): T | null {
    const entry = this.map.get(key);
    if (!entry || entry.expiry < Date.now()) {
      if (entry) this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs = 600_000): void {
    // Evict oldest entry (first inserted) when at capacity
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiry: Date.now() + ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  clear(): void {
    this.map.clear();
  }
}
