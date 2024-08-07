import {
  Stdlib_C4_Boundary,
  Stdlib_C4_Container_Component,
  Stdlib_C4_Context,
  Stdlib_C4_Dynamic_Rel,
  UMLElement,
} from "plantuml-parser";

import { Container, PumlFile, Boundary } from "../entities";

const addDependency = (
  containers: Container[],
  relation: Stdlib_C4_Dynamic_Rel
): void => {
  const containerFrom = containers.find((x) => x.name === relation.from);
  if (!containerFrom) return;
  if (relation.to.endsWith("_db")) return;
  const containerTo = containers.find((x) => x.name === relation.to);
  if (!containerTo) return;
  containerFrom.relations.push({
    to: containerTo,
    technology: relation.techn,
    tags: relation.descr?.split(",").map((t) => t.trim()),
  });
};

// const addBoundary = (
//   containers: Container[],
//   boundary: Stdlib_C4_Boundary
// ): void => {
//   const containerFrom = containers.find((x) => x.name === relation.from);
//   if (!containerFrom) return;
//   if (relation.to.endsWith("_db")) return;
//   const containerTo = containers.find((x) => x.name === relation.to);
//   if (!containerTo) return;
//   containerFrom.relations.push({
//     to: containerTo,
//     technology: relation.techn,
//     tags: relation.descr?.split(",").map((t) => t.trim()),
//   });
// };

export const mapContainersFromPlantumlElements = (
  elements: UMLElement[]
): PumlFile => {
  const containers: Container[] = elements
    .filter(
      (element) =>
        element instanceof Stdlib_C4_Container_Component ||
        element instanceof Stdlib_C4_Context 
    )
    .map((element) => {
      const component = element as Stdlib_C4_Container_Component;
      return {
        name: component.alias,
        label: component.label,
        type: component.type_.name,
        relations: [],
        tags: component.sprite,
        description: component.descr,
      };
    });

  for (const element of elements) {
    if (element instanceof Stdlib_C4_Container_Component) {
      continue;
    }

    if (element instanceof Stdlib_C4_Dynamic_Rel) {
      addDependency(containers, element);
    }
  }

  const boundaries: Boundary[] = elements
    .filter(
      (element) =>
        element instanceof Stdlib_C4_Boundary 
    )
    .map((element) => {
      const component = element as Stdlib_C4_Boundary;
      return {
        name: component.alias,
        label: component.label,
        type: component.type_.name,
        tags: component.tags,
        boundaries: [],
        containers: []
      };
    });

  //  for (const element of elements) {
  //    if (element instanceof Stdlib_C4_Boundary) {
  //      addBoundary(containers, element);
  //    }
  //  }

  return { 
    allContainers: containers.sort((a, b) => a.name.localeCompare(b.name)),
    boundaries: boundaries
  };
};
