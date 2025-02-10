import { analyzeArchitecture } from "../src/analyzer";

/**
 * Core diagrams https://github.com/plantuml-stdlib/C4-PlantUML/blob/master/samples/C4CoreDiagrams.md
 */
describe("Cascade coupling reduction", () => {
  it("test1", async () => {
    const L1Report = await analyzeArchitecture("banking/C4L1.puml");
    const L2Report = await analyzeArchitecture("banking/C4L2.puml");
    const L3Report = await analyzeArchitecture("banking/C4L3.puml");

    console.log(L1Report, L2Report, L3Report);
  });
});
