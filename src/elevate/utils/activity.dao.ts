import { ActivityRDFRead } from "./activityRDFRead";
import { AsyncIterator } from "asynciterator";
import { Activity } from "./elevate-types";
import { Auth } from "../../utils/auth";

export class ActivityDao {
  private activityMapping: ActivityRDFRead;

  constructor() {
    this.activityMapping = new ActivityRDFRead();
  }

  public async find(options?: {
    sources?: string[];
    keys?: string[];
    boundKeys?: { key: string; value: string | number | Date | boolean }[];
    filterKeys?: (
      | { key: string; relationKeyToValue: string; value: string | number | Date | boolean }
      | { requiredKeys: string[]; condition: string }
    )[];
    sort?: { key: string; ascending: boolean };
    slice?: { limit: number; offset?: number };
    type?: "select" | "count" | "ask";
    auth?: Auth;
    aggregator?: { enabled: boolean; podContext: any; enableCache: boolean };
  }): Promise<AsyncIterator<any> | Activity[] | number> {
    const sources = options?.sources
    if (sources === undefined || sources.length === 0) {
      throw new Error("No sources provided for activity query.");
    }

    const queryOptions = { ...options };
    delete queryOptions.sources;

    return this.activityMapping.query(sources as [string, ...string[]], queryOptions);
  }

  public async getById(
    id: number | string,
    options?: {
      sources?: any[];
      auth?: Auth;
      aggregator?: {
        enabled: boolean;
        podContext: any;
        enableCache: boolean;
      }
    }
  ): Promise<AsyncIterator<any> | Activity[] | number> {
    const activityIri = typeof id === 'string' ? id : String(id);
    const sources = options?.sources || [activityIri, "https://solidlabresearch.github.io/activity-ontology/"];
    return await this.activityMapping.query(sources as [string, ...string[]], {
        boundKeys: [
          {
            key: "activity",
            value: activityIri
          }
        ],
        slice: {
          limit: 1
        },
        aggregator: options?.aggregator,
        auth: options?.auth
      })
  }

  /**
   * Count elements in datastore
   */
  public async count(options?: {
    sources?: string[];
    boundKeys?: { key: string; value: any }[];
    filterKeys?: { key: string; relationKeyToValue: string; value: string | number | boolean | Date }[];
    auth?: Auth;
    aggregator?: { enabled: boolean; podContext: any; enableCache: boolean };
  }): Promise<number> {
    const sources = options?.sources
    if (sources === undefined || sources.length === 0) {
      throw new Error("No sources provided for activity query.");
    }

    const queryOptions = { ...options };
    delete queryOptions.sources;
    if (!options) {
      options = {
        boundKeys: [],
        filterKeys: []
      };
    }
    let keys = ["activity"];
    if (options.boundKeys) {
      options.boundKeys.forEach(boundKey => {
        if (!keys.includes(boundKey.key)) {
          keys.push(boundKey.key);
        }
      });
    }
    if (options.filterKeys) {
      options.filterKeys.forEach(filterKey => {
        if (!keys.includes(filterKey.key)) {
          keys.push(filterKey.key);
        }
      });
    }
    return this.activityMapping.query(sources as [string, ...string[]], {
      keys: keys,
      boundKeys: options.boundKeys,
      filterKeys: options.filterKeys,
      type: "count",
      auth: options.auth,
      aggregator: options.aggregator
    }) as Promise<number>;
  }
}
