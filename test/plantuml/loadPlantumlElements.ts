import fs from "fs/promises";
import path from "path";

import {
  parse as parsePuml,
  Relationship,
  Stdlib_C4_Boundary,
  Stdlib_C4_Container_Component,
  Stdlib_C4_Context,
  Stdlib_C4_Dynamic_Rel,
  UMLElement,
} from "plantuml-parser";

const filterElements = (elements: UMLElement[]): UMLElement[] => {
  const result: UMLElement[] = [];

  for (const element of elements) {
    if (
      (element as Stdlib_C4_Container_Component).type_.name === "Container" ||
      (element as Stdlib_C4_Container_Component).type_.name === "ContainerDb" ||
      (element as Stdlib_C4_Context).type_.name === "System_Ext"
    ) {
      result.push(element);
    }

    const elementAsBoundary = element as Stdlib_C4_Boundary;
    if (elementAsBoundary.type_.name === "Boundary") {
      result.push(elementAsBoundary);
      const resultFromBoundary = filterElements(elementAsBoundary.elements);
      result.push(...resultFromBoundary);
    }

    if (Array.isArray(element)) {
      const resultFromArray = filterElements(element);
      result.push(...resultFromArray);
    }

    if (
      element instanceof Stdlib_C4_Dynamic_Rel ||
      element instanceof Relationship
    ) {
      result.push(element);
    }
  }

  return result;
};

const getFilepath = (fileName: string): string => {
  return path.join(process.cwd(), "architecture", fileName);
};

export const loadPlantumlElements = async (fileName: string): Promise<UMLElement[]> => {
  const filepath = getFilepath(fileName);

  let data = await fs.readFile(filepath, "utf8");
  data = data
    .replaceAll(/, \$tags=(".+?")/g, ", $1")
    .replaceAll('""', '" "');
  const [{ elements }] = parsePuml(data);

  return filterElements(elements);
};
