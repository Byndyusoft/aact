/* eslint-disable unicorn/prevent-abbreviations */
import { UMLElement } from "plantuml-parser";

import {
  ArchitectureElements,
  groupElements,
} from "./plantuml/lib/groupElements";

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

const analyzeElements = (elements: ArchitectureElements): AnalysisReport => {
  const asyncApiCalls = elements.relations.filter((it) =>
    (it.descr ?? "").includes("async"),
  );
  const syncApiCalls = elements.relations.filter(
    // (it) => it.descr !== "async" && (it.techn ?? "").includes("http"),
    (it) => {
      const component = elements.components.find((ct) => ct.alias === it.to);
      return (
        it.descr !== "async" &&
        (component!.type_.name as string) === "System_Ext"
      );
    },
  );

  return {
    elementsCount: elements.components.length,
    syncApiCalls: syncApiCalls.length,
    asyncApiCalls: asyncApiCalls.length,
    databases: analyzeDatabases(elements),
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

export const analyzeArchitecture = (
  elements: UMLElement[],
): AnalyzedArchitecture => {
  const groupedElements = groupElements(elements);

  return {
    elements: groupedElements,
    report: analyzeElements(groupedElements),
  };
};
