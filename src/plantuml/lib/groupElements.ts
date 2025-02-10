import {
  Relationship,
  Stdlib_C4_Container_Component,
  Stdlib_C4_Dynamic_Rel,
  UMLElement,
} from "plantuml-parser";
import { Stdlib_C4_Boundary } from "plantuml-parser/dist/types";

export interface ArchitectureElements {
  components: Stdlib_C4_Container_Component[];
  relations: Stdlib_C4_Dynamic_Rel[];
  boundaries: Stdlib_C4_Boundary[];
}

export const groupElements = (elements: UMLElement[]) => {
  const result: ArchitectureElements = {
    components: [],
    boundaries: [],
    relations: [],
  };

  for (const element of elements) {
    if (
      element instanceof Stdlib_C4_Dynamic_Rel ||
      element instanceof Relationship
    ) {
      result.relations.push(element as Stdlib_C4_Dynamic_Rel);
    } else if (
      ["System_Boundary", "Boundary"].includes(
        (element as Stdlib_C4_Boundary).type_.name,
      )
    ) {
      result.boundaries.push(element as Stdlib_C4_Boundary);
    } else {
      result.components.push(element as Stdlib_C4_Container_Component);
    }
  }

  return result;
};
