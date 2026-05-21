import { ElevateSport } from "./elevate-types";

export const ACTIVO_NS = "https://solidlabresearch.github.io/activity-ontology#";
export const OAACTIVITY_NS = "https://openactive.io/activity-list#";

const exactMatches: Partial<Record<ElevateSport, string[]>> = {
  [ElevateSport.Ride]: [`${OAACTIVITY_NS}4a19873e-118e-43f4-b86e-05acba8fb1de`],
  [ElevateSport.Run]: [`${OAACTIVITY_NS}72ddb2dc-7d75-424e-880a-d90eabe91381`],
  [ElevateSport.Swim]: [`${OAACTIVITY_NS}2750229d-b725-4171-9276-376be913957c`],
  [ElevateSport.Hike]: [`${OAACTIVITY_NS}619f374a-c1b6-48d2-aabe-a01b6dedb9fd`],
  [ElevateSport.Walk]: [`${OAACTIVITY_NS}95092977-5a20-4d6e-b312-8fddabe71544`]
};

const elevateSportByActivityTypeIri: Record<string, ElevateSport> = Object.values(ElevateSport).reduce(
  (accumulator, sport) => {
    accumulator[activityTypeIriForElevateSport(sport)] = sport;
    for (const iri of exactMatches[sport] ?? []) {
      accumulator[iri] = sport;
    }
    return accumulator;
  },
  {} as Record<string, ElevateSport>
);

export function activityTypeIriForElevateSport(sport: string | null | undefined): string {
  const mappedSport = Object.values(ElevateSport).includes(sport as ElevateSport)
    ? (sport as ElevateSport)
    : "Other";
  return `${ACTIVO_NS}${mappedSport}`;
}

export function elevateSportForActivityTypeIri(iri: string | null | undefined): ElevateSport | string | null {
  if (!iri) {
    return null;
  }

  const mappedSport = elevateSportByActivityTypeIri[iri];
  if (mappedSport) {
    return mappedSport;
  }

  if (iri.startsWith(ACTIVO_NS)) {
    return iri.slice(ACTIVO_NS.length);
  }

  return null;
}
