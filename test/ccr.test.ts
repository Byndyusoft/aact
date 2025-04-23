import { Stdlib_C4_Boundary, Stdlib_C4_Container_Component } from "plantuml-parser";

import { analyzeArchitecture } from "../src/analyzer";

/**
 * Core diagrams https://github.com/plantuml-stdlib/C4-PlantUML/blob/master/samples/C4CoreDiagrams.md
 */
describe("Cascade coupling reduction", () => {
  it("test1", async () => {
    // const L2Report = await analyzeArchitecture("banking/C4L2.puml");
    // const L3Report = await analyzeArchitecture("banking/C4L3.puml");

    const BoundariesReport = await analyzeArchitecture("boundaries.puml");

    // console.log(L2Report, L3Report, BoundariesReport);

    for (const b of BoundariesReport.elements.boundaries) {
      console.log(b.boundary.label, `, cohesion: ${b.cohesion}`, `, coupling: ${b.couplingRelations.length}`);
      
      const parentBoundary = BoundariesReport.elements.boundaries
            .find(pb=>pb.boundary.elements.some(e=>(e as Stdlib_C4_Boundary).alias === b.boundary.alias));

      if(parentBoundary)
      {
        const parentCoupling = parentBoundary.couplingRelations
          .filter(r => b.boundary.elements.some(e => (e as Stdlib_C4_Container_Component).alias === r.from)).length;
          
        expect(b.cohesion).toBeGreaterThanOrEqual(b.couplingRelations.length);
        expect(b.couplingRelations.length).toBeGreaterThanOrEqual(parentCoupling);

        console.log(`${b.cohesion} ≥ ${b.couplingRelations.length} ≥ ${parentCoupling}`);
      }
    }

    // console.log(BoundariesReport);
    // console.log(BoundariesReport.elements.boundaries[0]);

  });
});
