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
  boundaries: ArchitectureBoundary[];
}

export interface ArchitectureBoundary {
  boundary: Stdlib_C4_Boundary;
  coupling: number;
  cohesion: number;
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
      ["System_Boundary", "Container_Boundary", "Boundary"].includes(
        (element as Stdlib_C4_Boundary).type_.name,
      )
    ) {
      result.boundaries.push({
        boundary: element as Stdlib_C4_Boundary,
        coupling: 0,
        cohesion: 0
      });
    } else {
      result.components.push(element as Stdlib_C4_Container_Component);
    }
  }

  return result;
};
