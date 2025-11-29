import { QueryEngine } from "@comunica/query-sparql";
import { AsyncIterator } from "asynciterator";
import { Bindings, Term } from "@rdfjs/types";
import { ActivitySparqlFieldMap } from "./activitySparqlFieldMap";
import {
  Activity,
  ActivityFlag,
  ConnectorType,
  Lap,
  Peak,
  ZoneModel
} from "./elevate-types";
import { getAggregatorIdStore } from "../../utils/aggregator-id-store";
import { createAggregatorService, getAggregatorService, waitForAggregatorService } from "../../utils/aggregator-functions";
import { PodContext } from "../../data-generator";
import { Auth } from "../../utils/auth";

export class ActivityRDFRead {
  private queryEngine: QueryEngine;

  constructor() {
    this.queryEngine = new QueryEngine();
  }

  // Type guard functions for better type safety
  private isKeyFilterType(
    filterKey: any
  ): filterKey is { key: string; relationKeyToValue: string; value: string | number | Date | boolean } {
    return "key" in filterKey && "relationKeyToValue" in filterKey && "value" in filterKey;
  }

  private isConditionFilterType(filterKey: any): filterKey is { requiredKeys: string[]; condition: string } {
    return "requiredKeys" in filterKey && "condition" in filterKey;
  }

  private parseTerm(term: Term) {
    if (term.termType === "Literal") {
      // Handle literal values
      if (term.datatype && term.datatype.value === "http://www.w3.org/2001/XMLSchema#dateTime") {
        return new Date(term.value).toDateString();
      } else if (term.datatype && term.datatype.value === "http://www.w3.org/2001/XMLSchema#integer") {
        return parseInt(term.value);
      } else if (
        term.datatype &&
        (term.datatype.value === "http://www.w3.org/2001/XMLSchema#double" ||
          term.datatype.value === "http://www.w3.org/2001/XMLSchema#float")
      ) {
        return parseFloat(term.value);
      } else if (term.datatype && term.datatype.value === "http://www.w3.org/2001/XMLSchema#boolean") {
        return term.value === "true";
      }
    }
    return term.value;
  }

  private encodeTerm(value: string | number | Date | boolean): string {
    if (typeof value === "string") {
      if (value.startsWith("http://") || value.startsWith("https://")) {
        return `<${value}>`;
      }
      if (value.startsWith("<") && value.endsWith(">")) {
        return value;
      }
      return `"${value.replace(/"/g, '\\"')}"`;
    } else if (typeof value === "number") {
      return `"${value}"^^<http://www.w3.org/2001/XMLSchema#double>`;
    } else if (typeof value === "boolean") {
      return `"${value}"^^<http://www.w3.org/2001/XMLSchema#boolean>`;
    } else if (value instanceof Date) {
      return `"${value.toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;
    }
    throw new Error("Unsupported term type for encoding: " + typeof value);
  }

  public async query(
    sources: [string, ...string[]],
    options?: {
      keys?: string[];
      boundKeys?: { key: string; value: string | number | Date | boolean }[];
      filterKeys?: (
        | { key: string; relationKeyToValue: string; value: string | number | Date | boolean }
        | {
            requiredKeys: string[];
            condition: string;
          }
      )[];
      sort?: { key: string; ascending: boolean };
      slice?: { limit: number; offset?: number };
      type?: "select" | "count" | "ask";
      aggregator?: {
        enabled: boolean;
        podContext: PodContext;
        enableCache: boolean;
      };
      auth?: Auth;
    }
  ): Promise<AsyncIterator<any> | Activity[] | number> {
    if (!options) {
      options = {};
    }

    let query = `
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX activo: <https://solidlabresearch.github.io/activity-ontology#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
`;

    if (options.type === "count") {
      query += "SELECT (COUNT(?activity) AS ?count) WHERE {\n";
    } else if (options.type === "ask") {
      query += "ASK {\n";
    } else {
      query += "SELECT * WHERE {\n";
    }

    let completeActivity = false;
    let needsFlags = false;
    if (!options.keys || options.keys.length === 0) {
      options.keys = Object.keys(ActivitySparqlFieldMap);
      completeActivity = true;
    } else {
      let keysSet = new Set(options.keys);
      options.filterKeys?.forEach(filterKey => {
        if (this.isKeyFilterType(filterKey)) {
          keysSet.add(filterKey.key);
        }
        if (this.isConditionFilterType(filterKey)) {
          filterKey.requiredKeys.forEach(requiredKey => {
            keysSet.add(requiredKey);
          });
        }
      });
      options.boundKeys?.forEach(boundKey => {
        if (boundKey.key) {
          keysSet.add(boundKey.key);
        }
      });
      if (options.sort?.key) {
        keysSet.add(options.sort?.key);
      }
      keysSet.delete("activity");
      keysSet.delete("activity_id");
      if (keysSet.has("activity_flags")) {
        needsFlags = true;
        keysSet.delete("activity_flags");
      }
      options.keys = Array.from(keysSet);
    }

    let queryTree = {
      graphPattern: "?activity a activo:Activity .\n",
      children: {}
    };

    for (const key of options.keys) {
      if (ActivitySparqlFieldMap[key] === undefined) {
        console.trace();
        console.error("Activity component mapping for key: " + key + " is not defined.");
        break;
      }
      const component = ActivitySparqlFieldMap[key];
      const provenance = [key];
      let workingComponent = component;
      while (workingComponent.requiredVariable != "activity") {
        if (provenance[provenance.length - 1] === workingComponent.requiredVariable) {
          console.error("Circular dependency detected in activity component mapping for key: " + key);
        }
        provenance.push(workingComponent.requiredVariable);
        workingComponent = ActivitySparqlFieldMap[workingComponent.requiredVariable];
      }
      let workingNode = queryTree;
      for (let i = provenance.length - 1; i >= 0; i--) {
        const variable = provenance[i];
        // @ts-ignore
        if (!workingNode.children[variable]) {
          // @ts-ignore
          workingNode.children[variable] = {
            graphPattern: ActivitySparqlFieldMap[variable].graphPattern,
            required: ActivitySparqlFieldMap[variable].required,
            children: {}
          };
        }
        // @ts-ignore
        workingNode = workingNode.children[variable];
      }
    }

    // Add bound keys to the query tree
    for (const boundKey of options.boundKeys ?? []) {
      const key = boundKey.key;
      const value = boundKey.value;
      query += `BIND(${this.encodeTerm(value)} AS ?${key})\n`;
    }

    // Construct query from tree
    const constructQuery = (node: any): string => {
      let queryPart = node.graphPattern;
      for (const childKey in node.children) {
        const nestedQuery = constructQuery(node.children[childKey]);
        if (nestedQuery == "") {
          continue;
        }
        if (node.children[childKey].required) {
          queryPart += nestedQuery + "\n";
        } else {
          queryPart += "OPTIONAL {\n";
          queryPart += nestedQuery + "\n";
          queryPart += "}\n";
        }
      }
      return queryPart;
    };
    query += constructQuery(queryTree);

    // Add filter keys to the query
    for (const filterKey of options.filterKeys ?? []) {
      if (this.isKeyFilterType(filterKey)) {
        query += `FILTER(?${filterKey.key} ${filterKey.relationKeyToValue} ${this.encodeTerm(filterKey.value)})\n`;
      }
      if (this.isConditionFilterType(filterKey)) {
        query += `FILTER(${filterKey.condition})\n`;
      }
    }

    query += "\n}\n";

    // add logic for sorting and slicing
    if (options.sort) {
      if (options.sort.ascending) {
        query += "ORDER BY ?" + options.sort.key + "\n";
      } else {
        query += "ORDER BY DESC(?" + options.sort.key + ")\n";
      }
    }
    if (options.slice) {
      if (options.slice.limit) {
        query += "LIMIT " + options.slice.limit + "\n";
      }
      if (options.slice.offset) {
        query += "OFFSET " + options.slice.offset + "\n";
      }
    }

    if (options.type === "ask") {
      throw new Error("ASK queries are not yet implemented in ActivityRDFMapper.");
    }

    // Check if aggregator is enabled
    if (options.aggregator?.enabled && options.aggregator.podContext) {
      const store = getAggregatorIdStore();
      const serviceKey = store.buildActivityQueryKey(sources, {
        keys: options.keys,
        boundKeys: options.boundKeys,
        filterKeys: options.filterKeys,
        sort: options.sort,
        slice: options.slice,
        type: options.type
      });
      if (!options.auth) {
        throw new Error("Auth is required when using aggregator.");
      }

      // Get results from aggregator
      const aggregatorResults = await this.queryViaAggregator(options.auth, query, [...sources, "https://solidlabresearch.github.io/activity-ontology/"], serviceKey);

      // Return count directly if count query
      if (options.type === "count") {
        const count = aggregatorResults.results?.bindings?.[0]?.count?.value || 0;
        return parseInt(count);
      }

      // Convert JSON bindings to Activity objects and return directly
      const bindings = aggregatorResults.results?.bindings || [];
      const activities: Activity[] = [];

      for (const binding of bindings) {
        const activity = new Activity();

        // Convert binding format
        const bindingsMap = new Map();
        for (const [key, value] of Object.entries(binding)) {
          bindingsMap.set(key, value);
        }

        const mockBindings = {
          has: (key: string | Term) => {
            const keyStr = typeof key === 'string' ? key : key.value;
            return bindingsMap.has(keyStr);
          },
          get: (key: string | Term) => {
            const keyStr = typeof key === 'string' ? key : key.value;
            const val: any = bindingsMap.get(keyStr);
            if (!val) return undefined;
            return {
              value: val.value,
              termType: val.type === 'uri' ? 'NamedNode' : val.type === 'literal' ? 'Literal' : val.type,
              datatype: val.datatype ? { value: val.datatype } : undefined
            };
          },
          keys: () => Array.from(bindingsMap.keys()).map(k => ({ value: k }))
        } as any as Bindings;

        // Extract activity ID
        const activityIri = mockBindings.get("activity")?.value;
        if (activityIri) {
          const activityIriParts = activityIri.split("/");
          activity.id = activityIriParts[activityIriParts.length - 1].split("#")[0];
        }
        activity.connector = ConnectorType.SOLID;

        // Map all requested keys
        for (const key of options.keys) {
          if (ActivitySparqlFieldMap[key].ignore) {
            continue;
          }
          const activityAttributes = key.split("_").slice(1);
          let workingObject = activity;
          for (let i = 0; i < activityAttributes.length; i++) {
            const attribute = activityAttributes[i];
            if (i === activityAttributes.length - 1) {
              // last attribute, set value
              let value = null;
              if (ActivitySparqlFieldMap[key].formatValue) {
                value = ActivitySparqlFieldMap[key].formatValue(mockBindings);
              } else if (mockBindings.has(key)) {
                value = this.parseTerm(mockBindings.get(key)!);
              }
              // @ts-ignore
              workingObject[attribute] = value;
            } else {
              // not the last attribute, ensure the object exists
              // @ts-ignore
              if (!workingObject[attribute]) {
                // @ts-ignore
                workingObject[attribute] = {};
              }
              // @ts-ignore
              workingObject = workingObject[attribute];
            }
          }
        }

        // Handle subqueries (flags, laps, peaks, zones) if needed
        const completeActivity = !options.keys || options.keys.length === 0;
        const needsFlags = options.keys?.some((key: string) => key === "activity_flags");

        if (completeActivity || needsFlags) {
          activity.flags = await this.queryFlags(activityIri!, sources, options);
        }

        if (completeActivity) {
          // Query laps
          const laps = await this.queryLaps(activityIri!, sources, options);
          if (laps) {
            activity.laps = laps;
          }

          // Query peaks and zones for various stats if they exist
          // (This would need to be extended based on what stats are present)
          // For now, we'll leave this simplified
        }

        activities.push(activity);
      }

      return activities;
    }

    // Use Comunica query engine (original path)
    let bindingsStream = await this.queryEngine.queryBindings(query, {
      sources: [...sources, "https://solidlabresearch.github.io/activity-ontology/"],
      fetch: options.auth ? options.auth.fetch.bind(options.auth) : undefined
    });

    if (options.type === "count") {
      return bindingsStream.map((bindings: Bindings) => {
        return parseInt(bindings.get("count")!.value);
      });
    }

    return bindingsStream
        .transform({
          transform: async (bindings: Bindings, done: () => void, push: (activity: Activity) => void) => {
            const activity = new Activity();
            const activityIriParts = bindings.get("activity")!.value.split("/");
            activity.id = activityIriParts[activityIriParts.length - 1].split("#")[0];
            activity.connector = ConnectorType.SOLID;

            for (const key of options!.keys!) {
              if (ActivitySparqlFieldMap[key].ignore) {
                continue;
              }
              const activityAttributes = key.split("_").slice(1);
              let workingObject = activity;
              for (let i = 0; i < activityAttributes.length; i++) {
                const attribute = activityAttributes[i];
                if (i === activityAttributes.length - 1) {
                  // last attribute, set value
                  let value = null;
                  if (ActivitySparqlFieldMap[key].formatValue) {
                    value = ActivitySparqlFieldMap[key].formatValue(bindings);
                  } else if (bindings.has(key)) {
                    value = this.parseTerm(bindings.get(key)!);
                  }
                  // @ts-ignore
                  workingObject[attribute] = value;
                } else {
                  // not the last attribute, ensure the object exists
                  // @ts-ignore
                  if (!workingObject[attribute]) {
                    // @ts-ignore
                    workingObject[attribute] = {};
                  }
                  // @ts-ignore
                  workingObject = workingObject[attribute];
                }
              }
            }

            const promises = [];
            if (completeActivity || needsFlags) {
              promises.push(
                this.queryFlags(bindings.get("activity")!.value, sources, options).then(result => {
                  activity.flags = result;
                })
              );
            }

            if (completeActivity) {
              // We also need to query Peak, Zones, Lap, and Flag data
              promises.push(
                this.queryLaps(bindings.get("activity")!.value, sources, options).then(result => {
                  // @ts-ignore
                  activity.laps = result;
                })
              );

              // Stats
              if (bindings.get("activity_stats_speed")) {
                promises.push(
                  this.queryPeaks(bindings.get("activity_stats_speed")!.value, sources, options).then(result => {
                    if (result) {
                      activity.stats.speed.peaks = result;
                    }
                  })
                );
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_stats_speed")!.value, sources, options).then(result => {
                    if (result) {
                      activity.stats.speed.zones = result;
                    }
                  })
                );
              }

              if (bindings.get("activity_stats_pace")) {
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_stats_pace")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.stats.pace.zones = result;
                  })
                );
              }

              if (bindings.get("activity_stats_power")) {
                promises.push(
                  this.queryPeaks(bindings.get("activity_stats_power")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.stats.power.peaks = result;
                  })
                );
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_stats_power")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.stats.power.zones = result;
                  })
                );
              }

              if (bindings.get("activity_stats_heartRate")) {
                promises.push(
                  this.queryPeaks(bindings.get("activity_stats_heartRate")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.stats.heartRate.peaks = result;
                  })
                );
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_stats_heartRate")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.stats.heartRate.zones = result;
                  })
                );
              }

              if (bindings.get("activity_stats_cadence")) {
                promises.push(
                  this.queryPeaks(bindings.get("activity_stats_cadence")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.stats.cadence.peaks = result;
                  })
                );
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_stats_cadence")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.stats.cadence.zones = result;
                  })
                );
              }

              if (bindings.get("activity_stats_grade")) {
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_stats_grade")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.stats.grade.zones = result;
                  })
                );
              }

              if (bindings.get("activity_stats_elevation")) {
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_stats_elevation")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.stats.elevation.elevationZones = result;
                  })
                );
              }

              // srcStats
              if (bindings.get("activity_srcStats_speed")) {
                promises.push(
                  this.queryPeaks(bindings.get("activity_srcStats_speed")!.value, sources, options).then(result => {
                    if (result) {
                      // @ts-ignore
                      activity.srcStats.speed.peaks = result;
                    }
                  })
                );
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_srcStats_speed")!.value, sources, options).then(result => {
                    if (result) {
                      // @ts-ignore
                      activity.srcStats.speed.zones = result;
                    }
                  })
                );
              }

              if (bindings.get("activity_srcStats_pace")) {
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_srcStats_pace")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.srcStats.pace.zones = result;
                  })
                );
              }

              if (bindings.get("activity_srcStats_power")) {
                promises.push(
                  this.queryPeaks(bindings.get("activity_srcStats_power")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.srcStats.power.peaks = result;
                  })
                );
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_srcStats_power")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.srcStats.power.zones = result;
                  })
                );
              }

              if (bindings.get("activity_srcStats_heartRate")) {
                promises.push(
                  this.queryPeaks(bindings.get("activity_srcStats_heartRate")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.srcStats.heartRate.peaks = result;
                  })
                );
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_srcStats_heartRate")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.srcStats.heartRate.zones = result;
                  })
                );
              }

              if (bindings.get("activity_srcStats_cadence")) {
                promises.push(
                  this.queryPeaks(bindings.get("activity_srcStats_cadence")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.srcStats.cadence.peaks = result;
                  })
                );
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_srcStats_cadence")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.srcStats.cadence.zones = result;
                  })
                );
              }

              if (bindings.get("activity_srcStats_grade")) {
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_srcStats_grade")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.srcStats.grade.zones = result;
                  })
                );
              }

              if (bindings.get("activity_srcStats_elevation")) {
                promises.push(
                  this.complicatedQueryZones(bindings.get("activity_srcStats_elevation")!.value, sources, options).then(result => {
                    // @ts-ignore
                    activity.srcStats.elevation.elevationZones = result;
                  })
                );
              }
            }

            await Promise.all(promises);

            push(activity);
            done();
          }
        });
  }

  private async queryLaps(
    activityId: string,
    sources: [string, ...string[]],
    options?: {
      aggregator?: {
        enabled: boolean;
        podContext: PodContext;
        enableCache: boolean;
      };
      auth?: Auth;
    }
  ): Promise<Lap[] | null> {
    const queryString = `
PREFIX activo: <https://solidlabresearch.github.io/activity-ontology#>
SELECT
?lapIndex
?lapStart
?lapEnd
?isActive
?distance
?elapsedTime
?movingTime
?calories
?swolf25m
?swolf50m
?avgSpeed
?maxSpeed
?avgPace
?maxPace
?avgCadence
?avgHr
?maxHr
?avgWatts
?elevationGain
WHERE {
  <${activityId}> activo:hasLap ?lap .
  ?lap activo:lapIndex ?lapIndex .
  ?lap activo:lapStart ?lapStart .
  ?lap activo:lapEnd ?lapEnd .
  ?lap activo:isActive ?isActive .

  ?lap activo:hasStats ?stats .
  OPTIONAL { ?stats activo:distance ?distance . }
  OPTIONAL { ?stats activo:elapsedTime ?elapsedTime . }
  OPTIONAL { ?stats activo:movingTime ?movingTime . }
  OPTIONAL { ?stats activo:calories ?calories . }
  OPTIONAL {
    ?stats activo:hasScores ?scores .
    OPTIONAL { ?scores activo:swolf25 ?swolf25m . }
    OPTIONAL { ?scores activo:swolf50 ?swolf50m . }
  }
  OPTIONAL {
    ?stats activo:hasSpeedStats ?speedStats .
    OPTIONAL { ?speedStats activo:average ?avgSpeed . }
    OPTIONAL { ?speedStats activo:max ?maxSpeed . }
  }
  OPTIONAL {
    ?stats activo:hasPaceStats ?paceStats .
    OPTIONAL { ?paceStats activo:average ?avgPace . }
    OPTIONAL { ?paceStats activo:max ?maxPace . }
  }
  OPTIONAL {
    ?stats activo:hasCadenceStats ?cadenceStats .
    ?cadenceStats activo:average ?avgCadence .
  }
  OPTIONAL {
    ?stats activo:hasHeartRateStats ?heartRateStats .
    OPTIONAL { ?heartRateStats activo:average ?avgHr . }
    OPTIONAL { ?heartRateStats activo:max ?maxHr . }
  }
  OPTIONAL {
    ?stats activo:hasPowerStats ?powerStats .
    ?powerStats activo:average ?avgWatts .
  }
  OPTIONAL {
    ?stats activo:hasElevationStats ?elevationStats .
    ?elevationStats activo:ascent ?elevationGain .
  }
}
ORDER BY ?lapIndex
    `;

    if (options?.aggregator?.enabled && options?.auth) {
      // Use aggregator path - directly convert to Lap[]
      const store = getAggregatorIdStore();
      const serviceKey = store.buildSubQueryKey(activityId, sources, "laps");
      const aggregatorResults = await this.queryViaAggregator(
        options.auth,
        queryString,
        sources,
        serviceKey
      );

      const bindings = aggregatorResults.results?.bindings || [];
      const laps: Lap[] = bindings.map((binding: any) => {
        const lap: Lap = {
          id: parseInt(binding.lapIndex?.value),
          indexes: [parseInt(binding.lapStart?.value), parseInt(binding.lapEnd?.value)],
          active: binding.isActive?.value === "true"
        };

        // Add optional fields
        for (const [key, value] of Object.entries(binding)) {
          if (key === "lapIndex" || key === "lapStart" || key === "lapEnd" || key === "isActive") {
            continue; // Skip already handled keys
          }
          const val: any = value;
          if (val && val.value !== undefined) {
            // Parse the value based on datatype
            if (val.datatype === "http://www.w3.org/2001/XMLSchema#integer") {
              // @ts-ignore
              lap[key] = parseInt(val.value);
            } else if (val.datatype === "http://www.w3.org/2001/XMLSchema#double" ||
                       val.datatype === "http://www.w3.org/2001/XMLSchema#float") {
              // @ts-ignore
              lap[key] = parseFloat(val.value);
            } else if (val.datatype === "http://www.w3.org/2001/XMLSchema#boolean") {
              // @ts-ignore
              lap[key] = val.value === "true";
            } else {
              // @ts-ignore
              lap[key] = val.value;
            }
          }
        }

        return lap;
      });

      return laps.length > 0 ? laps : null;
    } else {
      // Use Comunica query engine
      const bindingsStream = await this.queryEngine.queryBindings(queryString, {
        sources,
        fetch: options?.auth ? options.auth.fetch.bind(options.auth) : undefined
      });

      const laps = await bindingsStream
        .map((bindings: Bindings) => {
          const lap: Lap = {
            id: parseInt(bindings.get("lapIndex")!.value),
            indexes: [parseInt(bindings.get("lapStart")!.value), parseInt(bindings.get("lapEnd")!.value)],
            active: bindings.get("isActive")!.value === "true"
          };

          for (const key of bindings.keys()) {
            if (
              key.value === "lapIndex" ||
              key.value === "lapStart" ||
              key.value === "lapEnd" ||
              key.value === "isActive"
            ) {
              continue; // Skip these keys as they are already handled
            }
            let term = bindings.get(key);
            if (term) {
              // @ts-ignore
              lap[key.value] = this.parseTerm(term);
            }
          }

          return lap;
        })
        .toArray();

      return laps.length > 0 ? laps : null;
    }
  }

  private async queryFlags(
    activityId: string,
    sources: [string, ...string[]],
    options?: {
      aggregator?: {
        enabled: boolean;
        podContext: PodContext;
        enableCache: boolean;
      };
      auth?: Auth;
    }
  ): Promise<ActivityFlag[] | null> {
    const queryString = `
PREFIX activo: <https://solidlabresearch.github.io/activity-ontology#>
SELECT ?index WHERE {
  <${activityId}> activo:hasFlag ?flag .

  # Define mapping between flag URIs and enum indices
  VALUES (?flag ?index) {
    (activo:MOVING_TIME_GREATER_THAN_ELAPSED 0)
    (activo:SPEED_AVG_ABNORMAL 1)
    (activo:SPEED_STD_DEV_ABNORMAL 2)
    (activo:ASCENT_SPEED_ABNORMAL 3)
    (activo:PACE_AVG_FASTER_THAN_GAP 4)
    (activo:POWER_AVG_KG_ABNORMAL 5)
    (activo:POWER_THRESHOLD_ABNORMAL 6)
    (activo:HR_AVG_ABNORMAL 7)
    (activo:SCORE_HRSS_PER_HOUR_ABNORMAL 8)
    (activo:SCORE_PSS_PER_HOUR_ABNORMAL 9)
    (activo:SCORE_RSS_PER_HOUR_ABNORMAL 10)
    (activo:SCORE_SSS_PER_HOUR_ABNORMAL 11)
  }
}
    `;

    if (options?.aggregator?.enabled && options?.auth) {
      // Use aggregator path - directly convert to ActivityFlag[]
      const store = getAggregatorIdStore();
      const serviceKey = store.buildSubQueryKey(activityId, sources, "flags");
      const aggregatorResults = await this.queryViaAggregator(
        options.auth,
        queryString,
        ["https://solidlabresearch.github.io/activity-ontology/", ...sources],
        serviceKey
      );

      const bindings = aggregatorResults.results?.bindings || [];
      const result: ActivityFlag[] = bindings.map((binding: any) => {
        return parseInt(binding.index?.value) as ActivityFlag;
      });

      return result.length > 0 ? result : null;
    } else {
      // Use Comunica query engine
      const bindingsStream = await this.queryEngine.queryBindings(queryString, {
        sources: ["https://solidlabresearch.github.io/activity-ontology/", ...sources],
        fetch: options?.auth ? options.auth.fetch.bind(options.auth) : undefined
      });

      const result = await bindingsStream
        .map((bindings: Bindings) => {
          return parseInt(bindings.get("index")!.value) as ActivityFlag;
        })
        .toArray();

      return result.length > 0 ? result : null;
    }
  }

  private async queryPeaks(
    statId: string,
    sources: [string, ...string[]],
    options?: {
      aggregator?: {
        enabled: boolean;
        podContext: PodContext;
        enableCache: boolean;
      };
      auth?: Auth;
    }
  ): Promise<Peak[] | null> {
    const queryString = `
PREFIX activo: <https://solidlabresearch.github.io/activity-ontology#>
SELECT * WHERE {
  <${statId}> activo:hasPeak ?peak .
  ?peak activo:peakStart ?peakStart .
  ?peak activo:peakDuration ?peakDuration .
  ?peak activo:peakValue ?peakValue .
}
ORDER BY ?peakDuration
    `;

    if (options?.aggregator?.enabled && options?.auth) {
      // Use aggregator path - directly convert to Peak[]
      const store = getAggregatorIdStore();
      const serviceKey = store.buildSubQueryKey(statId, sources, "peaks");
      const aggregatorResults = await this.queryViaAggregator(
        options.auth,
        queryString,
        sources,
        serviceKey
      );

      const bindings = aggregatorResults.results?.bindings || [];
      const result: Peak[] = bindings.map((binding: any) => {
        const peakStart = parseInt(binding.peakStart?.value);
        const peakDuration = parseInt(binding.peakDuration?.value);
        return {
          start: peakStart,
          range: peakDuration,
          end: peakStart + peakDuration,
          result: parseFloat(binding.peakValue?.value)
        };
      });

      return result.length > 0 ? result : null;
    } else {
      // Use Comunica query engine
      const bindingsStream = await this.queryEngine.queryBindings(queryString, {
        sources,
        fetch: options?.auth ? options.auth.fetch.bind(options.auth) : undefined
      });

      const result = await bindingsStream
        .map((bindings: Bindings) => {
          return {
            start: parseInt(bindings.get("peakStart")!.value),
            range: parseInt(bindings.get("peakDuration")!.value),
            end: parseInt(bindings.get("peakStart")!.value) + parseInt(bindings.get("peakDuration")!.value),
            result: parseFloat(bindings.get("peakValue")!.value)
          };
        })
        .toArray();

      return result.length > 0 ? result : null;
    }
  }

  private async simpleQueryZones(
    statId: string,
    sources: [string, ...string[]],
    options?: {
      aggregator?: {
        enabled: boolean;
        podContext: PodContext;
        enableCache: boolean;
      };
      auth?: Auth;
    }
  ): Promise<ZoneModel[] | null> {
    const queryString = `
PREFIX activo: <https://solidlabresearch.github.io/activity-ontology#>
SELECT * WHERE {
  <${statId}> activo:hasZone ?zone .
  ?zone activo:zoneStart ?zoneStart .
  ?zone activo:zoneIndex ?zoneIndex .
  ?zone activo:time ?time .
}
    `;

    if (options?.aggregator?.enabled && options?.auth) {
      // Use aggregator path - directly convert to ZoneModel[]
      const store = getAggregatorIdStore();
      const serviceKey = store.buildSubQueryKey(statId, sources, "zones");
      const aggregatorResults = await this.queryViaAggregator(
        options.auth,
        queryString,
        sources,
        serviceKey
      );

      const bindings = aggregatorResults.results?.bindings || [];
      let totalTime = 0;
      const zones: ZoneModel[] = [];

      // Process bindings
      bindings.forEach((binding: any) => {
        const partialZone = {
          from: parseInt(binding.zoneStart?.value),
          s: parseFloat(binding.time?.value),
          to: null as number | null,
          percent: 0
        };
        const index = parseInt(binding.zoneIndex?.value);
        while (zones.length <= index) {
          // @ts-ignore
          zones.push(null);
        }
        // @ts-ignore
        zones[index] = partialZone;
        totalTime += partialZone.s;
      });

      // Calculate derived fields
      for (let i = 0; i < zones.length; i++) {
        if (zones[i]) {
          zones[i].to = i === zones.length - 1 ? null : zones[i + 1].from;
          // @ts-ignore
          zones[i].percent = (zones[i].s / totalTime) * 100;
        }
      }

      return zones.length > 0 ? zones : null;
    } else {
      // Use Comunica query engine
      const bindingsStream = await this.queryEngine.queryBindings(queryString, {
        sources,
        fetch: options?.auth ? options.auth.fetch.bind(options.auth) : undefined
      });

      let totalTime = 0;
      const zones: ZoneModel[] = [];
      bindingsStream.on("data", (bindings: Bindings) => {
        const partialZone = {
          from: parseInt(bindings.get("zoneStart")!.value),
          s: parseFloat(bindings.get("time")!.value)
        };
        const index = parseInt(bindings.get("zoneIndex")!.value);
        while (zones.length <= index) {
          // @ts-ignore
          zones.push(null);
        }
        // @ts-ignore
        zones[index] = partialZone;
        totalTime += partialZone.s;
      });

      await new Promise(resolve => bindingsStream.on("end", resolve));

      for (let i = 0; i < zones.length; i++) {
        if (zones[i]) {
          zones[i].to = i === zones.length - 1 ? null : zones[i + 1].from;
          // @ts-ignore
          zones[i].percent = (zones[i].s / totalTime) * 100; // Calculate percentage of total time
        }
      }

      return zones.length > 0 ? zones : null;
    }
  }

  private async complicatedQueryZones(
    statId: string,
    sources: [string, ...string[]],
    options?: {
      aggregator?: {
        enabled: boolean;
        podContext: PodContext;
        enableCache: boolean;
      };
      auth?: Auth;
    }
  ): Promise<ZoneModel[] | null> {
    const queryString = `
PREFIX activo: <https://solidlabresearch.github.io/activity-ontology#>
SELECT ?zoneStart ?zoneIndex ?time ?percent ?to WHERE {
  # Calculate total time for percentage
  {
    SELECT (SUM(?allTime) AS ?totalTime) WHERE {
      <${statId}> activo:hasZone ?allZone .
      ?allZone activo:time ?allTime .
    }
  }

  <${statId}> activo:hasZone ?zone .
  ?zone activo:zoneStart ?zoneStart .
  ?zone activo:zoneIndex ?zoneIndex .
  ?zone activo:time ?time .

  # Calculate percentage
  BIND((?time / ?totalTime * 100) AS ?percent)

  # Pre-calculate the next zone index
  BIND((?zoneIndex + 1) AS ?nextIndex)

  # Calculate "to" value using the pre-calculated next index
  OPTIONAL {
    <${statId}> activo:hasZone ?nextZone .
    ?nextZone activo:zoneIndex ?nextIndex .
    ?nextZone activo:zoneStart ?to .
  }
}
ORDER BY ?zoneIndex
    `;

    if (options?.aggregator?.enabled && options?.auth) {
      // Use aggregator path - directly convert to ZoneModel[]
      const store = getAggregatorIdStore();
      const serviceKey = store.buildSubQueryKey(statId, sources, "zones");
      const aggregatorResults = await this.queryViaAggregator(
        options.auth,
        queryString,
        sources,
        serviceKey
      );

      const bindings = aggregatorResults.results?.bindings || [];
      const zones: ZoneModel[] = [];

      bindings.forEach((binding: any) => {
        const zone = {
          from: parseInt(binding.zoneStart?.value),
          s: parseFloat(binding.time?.value),
          percent: parseFloat(binding.percent?.value),
          to: binding.to ? parseInt(binding.to.value) : null
        };
        const index = parseInt(binding.zoneIndex?.value);
        while (zones.length <= index) {
          // @ts-ignore
          zones.push(null);
        }
        zones[index] = zone;
      });

      return zones.length > 0 ? zones : null;
    } else {
      // Use Comunica query engine
      const bindingsStream = await this.queryEngine.queryBindings(queryString, {
        sources,
        fetch: options?.auth ? options.auth.fetch.bind(options.auth) : undefined
      });

      const zones: ZoneModel[] = [];
      bindingsStream.on("data", (bindings: Bindings) => {
        const zone = {
          from: parseInt(bindings.get("zoneStart")!.value),
          s: parseFloat(bindings.get("time")!.value),
          percent: parseFloat(bindings.get("percent")!.value),
          to: bindings.has("to") ? parseInt(bindings.get("to")!.value) : null
        };
        const index = parseInt(bindings.get("zoneIndex")!.value);
        while (zones.length <= index) {
          // @ts-ignore
          zones.push(null);
        }
        zones[index] = zone;
      });

      await new Promise(resolve => bindingsStream.on("end", resolve));

      return zones.length > 0 ? zones : null;
    }
  }

  /**
   * Build FNO configuration for SPARQL evaluation via aggregator
   */
  private buildFnoConfig(queryString: string, sources: string[]): string {
    const prefixes = `
@prefix trans: <http://localhost:5000/config/transformations#> .
@prefix fno: <https://w3id.org/function/ontology#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

    const sourcesString = sources.map(s => `"${s}"^^xsd:string`).join(" ");

    return `${prefixes}
_:Query
    a fno:Execution ;
    fno:executes trans:SPARQLEvaluation ;
    trans:queryString """${queryString}"""^^xsd:string ;
    trans:sources ( ${sourcesString} ) .
`;
  }

  /**
   * Get or create aggregator service for the given query
   */
  private async getOrCreateAggregatorService(
    auth: Auth,
    queryString: string,
    sources: string[],
    serviceKey: string
  ): Promise<string> {
    const store = getAggregatorIdStore();

    // Check if we already have this service
    let serviceId = store.get(serviceKey);

    if (!serviceId) {
      // Create new aggregator service
      const fnoConfig = this.buildFnoConfig(queryString, sources);
      serviceId = await createAggregatorService(auth, fnoConfig);

      // Wait for the service to be up-to-date
      await waitForAggregatorService(auth, serviceId);

      // Store the service ID for future use
      store.set(serviceKey, serviceId);
    }

    return serviceId;
  }

  /**
   * Execute query via aggregator
   */
  private async queryViaAggregator(
    auth: Auth,
    queryString: string,
    sources: string[],
    serviceKey: string
  ): Promise<any> {
    const serviceId = await this.getOrCreateAggregatorService(auth, queryString, sources, serviceKey);
    return await getAggregatorService(auth, serviceId);
  }
}
