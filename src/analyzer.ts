/* eslint-disable unicorn/prevent-abbreviations */

import { Stdlib_C4_Boundary, Stdlib_C4_Container_Component } from "plantuml-parser";

import {
  ArchitectureElements,
  groupElements,
} from "./plantuml/lib/groupElements";
import { loadPlantumlElements } from "./plantuml";

interface AnalyzedArchitecture {
  elements: ArchitectureElements;
  report: AnalysisReport;
}

interface AnalysisReport {
  elementsCount: number;
  syncApiCalls: number;
  asyncApiCalls: number;
  databases: DatabasesInfo;
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

  for (const archBoundary of elements.boundaries) {
    const parentBoundary = elements.boundaries
      .find(b=>b.boundary.elements.some(e=>(e as Stdlib_C4_Boundary).alias === archBoundary.boundary.alias));

    for (const relation of elements.relations) {
      if(archBoundary.boundary.elements.some(e=>(e as Stdlib_C4_Container_Component).alias === relation.from))
      {
        if(archBoundary.boundary.elements.some(e=>(e as Stdlib_C4_Container_Component).alias === relation.to))
          archBoundary.cohesion++;
        else
        {
          if(!parentBoundary || parentBoundary.boundary.elements.some(b=>(b as Stdlib_C4_Boundary)
            .elements.some(e=>(e as Stdlib_C4_Container_Component).alias === relation.to)))
          {
            archBoundary.couplingRelations.push(relation);
            if(parentBoundary) {
              parentBoundary.cohesion++;
            }
          }
          else
            parentBoundary.couplingRelations.push(relation);
        }
      }
    }
  }

  return {
    elementsCount: elements.components.length,
    syncApiCalls: syncApiCalls.length,
    asyncApiCalls: asyncApiCalls.length,
    databases: analyzeDatabases(elements)
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
