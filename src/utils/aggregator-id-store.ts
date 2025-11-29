import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/**
 * Global aggregator ID store that persists query subscriptions across ActivityRDFRead instances.
 * Maps normalized query keys to aggregator service IDs (UUIDs).
 */
class AggregatorIdStore {
  private store: Map<string, string> = new Map();
  private storePath: string;
  private isDirty: boolean = false;

  constructor(storePath?: string) {
    this.storePath = storePath || path.join(process.cwd(), ".aggregators.json");
    this.load();
  }

  /**
   * Normalize sources by lowercasing and removing trailing slashes for consistent hashing
   */
  private normalizeSources(sources: string[]): string[] {
    return sources.map(source => {
      let normalized = source.toLowerCase().trim();
      if (normalized.endsWith("/")) {
        normalized = normalized.slice(0, -1);
      }
      return normalized;
    }).sort();
  }

  /**
   * Normalize query options for consistent key generation
   */
  private normalizeOptions(options: any): any {
    const normalized: any = {};

    if (options.keys) {
      normalized.keys = [...options.keys].sort();
    }

    if (options.boundKeys) {
      normalized.boundKeys = options.boundKeys
        .map((bk: any) => ({
          key: bk.key,
          value: String(bk.value)
        }))
        .sort((a: any, b: any) => a.key.localeCompare(b.key));
    }

    if (options.filterKeys) {
      normalized.filterKeys = options.filterKeys
        .map((fk: any) => {
          if ("key" in fk) {
            return {
              key: fk.key,
              relationKeyToValue: fk.relationKeyToValue,
              value: String(fk.value)
            };
          } else {
            return {
              requiredKeys: [...fk.requiredKeys].sort(),
              condition: fk.condition
            };
          }
        })
        .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }

    if (options.sort) {
      normalized.sort = {
        key: options.sort.key,
        ascending: options.sort.ascending
      };
    }

    if (options.slice) {
      normalized.slice = {
        limit: options.slice.limit,
        offset: options.slice.offset || 0
      };
    }

    if (options.type) {
      normalized.type = options.type;
    }

    return normalized;
  }

  /**
   * Build a stable hash key from query string and sources
   */
  buildServiceKey(queryString: string, sources: string[], queryType?: string): string {
    const normalizedSources = this.normalizeSources(sources);
    const keyData = {
      query: queryString.trim().replace(/\s+/g, " "),
      sources: normalizedSources,
      type: queryType || "activity"
    };
    const keyString = JSON.stringify(keyData);
    return crypto.createHash("sha256").update(keyString).digest("hex");
  }

  /**
   * Build a key specifically for activity queries with options
   */
  buildActivityQueryKey(sources: string[], options: any): string {
    const normalizedSources = this.normalizeSources(sources);
    const normalizedOptions = this.normalizeOptions(options);
    const keyData = {
      sources: normalizedSources,
      options: normalizedOptions,
      type: "activity-query"
    };
    const keyString = JSON.stringify(keyData);
    return crypto.createHash("sha256").update(keyString).digest("hex");
  }

  /**
   * Build a key for subqueries (flags, laps, peaks, zones)
   */
  buildSubQueryKey(activityId: string, sources: string[], queryType: "flags" | "laps" | "peaks" | "zones", statId?: string): string {
    const normalizedSources = this.normalizeSources(sources);
    const keyData = {
      activityId: activityId,
      statId: statId || null,
      sources: normalizedSources,
      type: `subquery-${queryType}`
    };
    const keyString = JSON.stringify(keyData);
    return crypto.createHash("sha256").update(keyString).digest("hex");
  }

  /**
   * Get aggregator service ID for a given key
   */
  get(serviceKey: string): string | undefined {
    return this.store.get(serviceKey);
  }

  /**
   * Set aggregator service ID for a given key
   */
  set(serviceKey: string, serviceId: string): void {
    this.store.set(serviceKey, serviceId);
    this.isDirty = true;
    this.save();
  }

  /**
   * Check if a service key exists
   */
  has(serviceKey: string): boolean {
    return this.store.has(serviceKey);
  }

  /**
   * Load the store from disk
   */
  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, "utf-8");
        const obj = JSON.parse(data);
        this.store = new Map(Object.entries(obj));
      }
    } catch (error) {
      console.warn("Failed to load aggregator ID store:", error);
      this.store = new Map();
    }
  }

  /**
   * Save the store to disk
   */
  save(): void {
    if (!this.isDirty) {
      return;
    }

    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const obj = Object.fromEntries(this.store);
      fs.writeFileSync(this.storePath, JSON.stringify(obj, null, 2), "utf-8");
      this.isDirty = false;
    } catch (error) {
      console.error("Failed to save aggregator ID store:", error);
    }
  }

  /**
   * Clear all stored mappings
   */
  clear(): void {
    this.store.clear();
    this.isDirty = true;
    this.save();
  }
}

// Global singleton instance
let globalStore: AggregatorIdStore | null = null;

/**
 * Get the global aggregator ID store instance
 */
export function getAggregatorIdStore(storePath?: string): AggregatorIdStore {
  if (!globalStore) {
    globalStore = new AggregatorIdStore(storePath);
  }
  return globalStore;
}

