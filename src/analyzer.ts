/* eslint-disable unicorn/prevent-abbreviations */

import {
  ArchitectureElements,
  groupElements,
} from "./plantuml/lib/groupElements";
import { loadPlantumlElements } from "./plantuml";
import { Stdlib_C4_Container_Component } from "plantuml-parser";

interface AnalyzedArchitecture {
  elements: ArchitectureElements;
  report: AnalysisReport;
}

interface AnalysisReport {
  elementsCount: number;
  syncApiCalls: number;
  asyncApiCalls: number;
  databases: DatabasesInfo;
  coupling: number;
  cohesion: number;
}

interface DatabasesInfo {
  count: number;
  consumes: number;
}

const apiTechnologies = ["http", "grpc", "tcp"];

const analyzeElements = (elements: ArchitectureElements): AnalysisReport => {
  const asyncApiCalls = elements.relations.filter((it) =>
    (it.descr ?? "").includes("async"),
  );
  const syncApiCalls = elements.relations.filter((it) => {
    const component = elements.components.find((ct) => ct.alias === it.to);
    const isExternalApi = (component!.type_.name as string) === "System_Ext";
    const isApiTechnology = apiTechnologies.some((apiTechn) =>
      (it.techn ?? "").toLowerCase().includes(apiTechn),
    );

    return it.descr !== "async" && (isExternalApi || isApiTechnology);
  });

  elements.boundaries.forEach(archBoundary => {
    archBoundary.cohesion = elements.relations.filter((it) => { 
        return archBoundary.boundary.elements.some(e=>(e as Stdlib_C4_Container_Component).alias === it.from) &&
          archBoundary.boundary.elements.some(e=>(e as Stdlib_C4_Container_Component).alias === it.to)
    }).length;
    archBoundary.coupling = elements.relations.filter((it) => { 
        return archBoundary.boundary.elements.some(e=>(e as Stdlib_C4_Container_Component).alias === it.from) &&
          !archBoundary.boundary.elements.some(e=>(e as Stdlib_C4_Container_Component).alias === it.to)
    }).length;
  });

  return {
    elementsCount: elements.components.length,
    syncApiCalls: syncApiCalls.length,
    asyncApiCalls: asyncApiCalls.length,
    databases: analyzeDatabases(elements),
    coupling: 0,
    cohesion: 0
  };
};

const analyzeDatabases = (elements: ArchitectureElements): DatabasesInfo => {
  const dbContainers = elements.components.filter(
    (it) => it.type_.name === "ContainerDb",
  );

  const dbRelations = elements.relations.filter((it) =>
    dbContainers.some((ct) => [it.from, it.to].includes(ct.alias)),
  );

  return {
    count: dbContainers.length,
    consumes: dbRelations.length,
  };
};

export const analyzeArchitecture = async (
  filename: string,
): Promise<AnalyzedArchitecture> => {
  const pumlElements = await loadPlantumlElements(filename);
  const groupedElements = groupElements(pumlElements);

  return {
    elements: groupedElements,
    report: analyzeElements(groupedElements),
  };
};
