import { ActivityRDFRead } from "./activityRDFRead";
import { AsyncIterator } from "asynciterator";
import { Activity } from "./elevate-types";
import { Auth } from "../../utils/auth";

export class ActivityDao {
  private activityMapping: ActivityRDFRead;

  constructor() {
    this.activityMapping = new ActivityRDFRead();
  }

  private async getDefaultSources(sources?: string[]): Promise<[string, ...string[]]> {
    // If sources provided, use them
    if (sources && sources.length > 0) {
      return sources as [string, ...string[]];
    }
    // Default: return the activity ontology source
    return ["https://solidlabresearch.github.io/activity-ontology/"];
  }

  public async findByDatedSession(startTime: string, endTime: string, options?: { auth?: Auth; aggregator?: { enabled: boolean; podContext: any; enableCache: boolean } }): Promise<AsyncIterator<any> | Activity[] | number> {
    return this.activityMapping.query(await this.getDefaultSources(), {
      filterKeys: [
        { key: "activity_startTime", relationKeyToValue: ">", value: new Date(startTime) },
        { key: "activity_endTime", relationKeyToValue: ">", value: new Date(endTime) }
      ],
      auth: options?.auth,
      aggregator: options?.aggregator
    });
  }

  public async findSorted(descending: boolean, options?: { auth?: Auth; aggregator?: { enabled: boolean; podContext: any; enableCache: boolean } }): Promise<AsyncIterator<any> | Activity[] | number> {
    return this.activityMapping.query(await this.getDefaultSources(), {
      sort: { key: "activity_startTime", ascending: !descending },
      auth: options?.auth,
      aggregator: options?.aggregator
    });
  }

  public async hasActivitiesWithSettingsLacks(options?: { auth?: Auth; aggregator?: { enabled: boolean; podContext: any; enableCache: boolean } }): Promise<AsyncIterator<any> | Activity[] | number> {
    return this.activityMapping.query(await this.getDefaultSources(), {
      keys: ["activity_settingsLack"],
      boundKeys: [{ key: "activity_settingsLack", value: true }],
      type: "ask",
      auth: options?.auth,
      aggregator: options?.aggregator
    });
  }

  public async findActivitiesWithSettingsLacks(keys?: string[], options?: { auth?: Auth; aggregator?: { enabled: boolean; podContext: any; enableCache: boolean } }): Promise<AsyncIterator<any> | Activity[] | number> {
    return this.activityMapping.query(await this.getDefaultSources(), {
      keys,
      boundKeys: [{ key: "activity_settingsLack", value: true }],
      auth: options?.auth,
      aggregator: options?.aggregator
    });
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
      ? (options.sources as [string, ...string[]])
      : await this.getDefaultSources();

    const queryOptions = { ...options };
    delete queryOptions.sources;

    return this.activityMapping.query(sources, queryOptions);
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
    const sources = options?.sources || [activityIri];
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
  }): Promise<AsyncIterator<any> | Activity[] | number> {
    const sources = options?.sources
      ? (options.sources as [string, ...string[]])
      : await this.getDefaultSources();

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
    return this.activityMapping.query(sources, {
      keys: keys,
      boundKeys: options.boundKeys,
      filterKeys: options.filterKeys,
      type: "count",
      auth: options.auth,
      aggregator: options.aggregator
    });
  }
}
