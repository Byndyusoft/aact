import {
  Comment,
  Relationship,
  Stdlib_C4_Boundary,
  Stdlib_C4_Container_Component,
  Stdlib_C4_Context,
  Stdlib_C4_Dynamic_Rel,
  UMLElement,
} from "plantuml-parser";

export const filterElements = (elements: UMLElement[]): UMLElement[] => {
  const result: UMLElement[] = [];

  for (const element of elements) {
    if (element instanceof Comment) continue;
    if (
      (element as Stdlib_C4_Container_Component).type_.name === "Container" ||
      (element as Stdlib_C4_Container_Component).type_.name === "ContainerDb" ||
      (element as Stdlib_C4_Context).type_.name === "System_Ext" ||
      element instanceof Stdlib_C4_Dynamic_Rel ||
      element instanceof Relationship
    ) {
      result.push(element);
    }

    const elementAsBoundary = element as Stdlib_C4_Boundary;
    if (
      ["System_Boundary", "Boundary"].includes(elementAsBoundary.type_.name)
    ) {
      result.push(elementAsBoundary);
      const resultFromBoundary = filterElements(elementAsBoundary.elements);
      result.push(...resultFromBoundary);
    }

    if (Array.isArray(element)) {
      const resultFromArray = filterElements(element);
      result.push(...resultFromArray);
    }
  }

  return result;
};
