/* eslint-disable no-console */
import fs from "fs/promises";
import path from "path";

import { Stdlib_C4_Dynamic_Rel } from "plantuml-parser";

import { Container } from "./containers";
import {
  DeployConfig,
  loadMicroserviceDeployConfigs,
  mapFromConfigs,
} from "./deployConfigs";
import {
  loadPlantumlElements,
  mapContainersFromPlantumlElements,
} from "./plantuml";

const SystemExternalType = "System_Ext";
const ContainerType = "Container";
const AsyncTag = "async";
const RestTag = "REST";

describe("Architecture", () => {
  let deployConfigs: DeployConfig[];
  let containersFromPuml: Container[];
  let deployConfigsForContainers: DeployConfig[];

  beforeAll(async () => {
    deployConfigs = mapFromConfigs(await loadMicroserviceDeployConfigs());

    const pumlElements = await loadPlantumlElements();
    containersFromPuml = mapContainersFromPlantumlElements(pumlElements);

    deployConfigsForContainers = deployConfigs.filter((x) =>
      containersFromPuml.find((y) => x.name === y.name),
    );
  });

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, n/global-require
    global.console = require("console");
  });

  afterEach(() => {
    global.console = console;
  });

  it("find diff in configs and uml containers", () => {
    const namesFromDeploy = deployConfigs.map((x) => x.name);
    const containerNamesFromPuml = containersFromPuml
      .filter((x) => x.type === ContainerType)
      .map((x) => x.name);

    expect(namesFromDeploy).toStrictEqual(containerNamesFromPuml);
  });

  it("find diff in configs and uml dependencies", () => {
    let firstFailedConfig: DeployConfig = {
      name: "",
      sections: [],
    };
    for (const config of deployConfigsForContainers) {
      const containerFromPuml = getPumlContainer(config.name);
      if (!containerFromPuml) continue;

      let log = `Container name ${config.name} `;
      if (checkSections(config, containerFromPuml, containersFromPuml))
        log = `${log}✅`;
      else {
        log = `${log}❌`;
        if (!firstFailedConfig.name) firstFailedConfig = config;
      }

      console.log(log);
    }

    const pumlContainer = getPumlContainer(firstFailedConfig.name);
    if (!pumlContainer) return;
    console.log(`--------------------------------------------------------`);
    console.log(`First failed container name ${firstFailedConfig.name}`);
    console.log(`--------------------------------------------------------`);
    expect(
      checkSections(firstFailedConfig, pumlContainer, containersFromPuml, true),
    ).toBeTruthy();

    function getPumlContainer(name: string): Container | undefined {
      return containersFromPuml.find((x) => x.name === name);
    }
  });

  it("check that urls and topics from relations exist in config", () => {
    let pass = true;
    for (const container of containersFromPuml) {
      const config = deployConfigsForContainers.find(
        (x) => x.name === container.name,
      );
      if (!config) continue;
      let log = `Container name ${container.name} `;
      for (const relation of container.relations) {
        const items = relation.technology?.split(", ");
        if (
          items &&
          !items.every((i: string) =>
            config.sections.some((s) => s.prod_value === i),
          )
        ) {
          log = `${log}❌ ${relation.to.name} ${items}`;
          pass = false;
        }
      }
      console.log(log);
    }
    expect(pass).toBeTruthy();
  });

  it("only acl can depend on external systems", () => {
    let pass = 0;
    for (const container of containersFromPuml) {
      let log = `Container name ${container.name} `;
      const externalRelations = container.relations.filter(
        (r) => r.to.type === SystemExternalType,
      );
      if (!container.tags?.includes("acl") && externalRelations.length > 0) {
        log = `${log}❌ ${externalRelations.map((x) => x.to.name).toString()}`;
        pass = pass + externalRelations.length;
      } else log = `${log}✅`;
      console.log(log);
    }
    expect(pass).toBe(0);
  });

  it("connect to external systems only by API Gateway or kafka", () => {
    let pass = true;
    for (const container of containersFromPuml) {
      let log = `Container name ${container.name} `;
      for (const r of container.relations.filter(
        (relation) => relation.to.type === SystemExternalType,
      )) {
        if (
          !r.technology
            ?.split(", ")
            .every(
              (i: string) =>
                i.startsWith("https://gateway.int.com:443/") || /-v\d$/.exec(i),
            )
        ) {
          log = `${log}❌ ${r.to.name}`;
          pass = false;
        }
      }
      console.log(log);
    }
    expect(pass).toBeTruthy();
  });

  function checkSections(
    config: DeployConfig,
    containerFromPuml: Container,
    allContainersFromPuml: Container[],
    verbose = false,
  ): boolean {
    return (
      config.sections.every((section) => {
        const result =
          containerFromPuml.relations.some((r) => {
            let result = false;
            if (r.tags?.includes(AsyncTag))
              result = r.technology?.includes(section.prod_value) === true;
            if (!result && (!r.tags || r.tags.includes(RestTag)))
              result =
                r.to.name === section.name &&
                (r.technology?.includes(section.prod_value) ||
                  r.to.type !== SystemExternalType);
            return result;
          }) ||
          allContainersFromPuml.some((pumlc) =>
            pumlc.relations.some(
              (r) =>
                r.to.name === config.name &&
                section.prod_value &&
                r.technology?.includes(section.prod_value),
            ),
          );
        if (!result && verbose)
          console.log(
            `In Config But Not In PUML: ${section.name} ${section.prod_value}`,
          );
        return result;
      }) &&
      [
        ...containerFromPuml.relations,
        ...allContainersFromPuml.flatMap((x) =>
          x.relations.filter(
            (r) => r.to.name === config.name && r.tags?.includes(AsyncTag),
          ),
        ),
      ].every((relation) => {
        const result = config.sections.some(
          (configSection) =>
            configSection.name === relation.to.name ||
            (configSection.prod_value &&
              relation.technology?.includes(configSection.prod_value)),
        );

        if (!result && verbose)
          console.log(
            `In PUML But Not In Config: ${relation.technology} ${relation.to.name}`,
          );
        return result;
      })
    );
  }

  it("generate puml from configs", async () => {
    const filepath = path.join(process.cwd(), "architecture", "generated.puml");
    let data = `@startuml "Demo Generated"
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml
LAYOUT_WITH_LEGEND()
AddRelTag("async",  $lineStyle = DottedLine())
AddElementTag("acl",  $bgColor = "#6F9355")
Boundary(project, "Our system"){
`;

    const rels: Stdlib_C4_Dynamic_Rel[] = [];
    const extSystems: string[] = [];
    const intContainers: string[] = [];

    for (const config of deployConfigsForContainers) {
      data += `Container(${config.name}, "${config.name.replaceAll("_", " ")}"`;
      if (config.name.endsWith("acl")) data += `, "", "", $tags="acl"`;
      data += `)
`;
      intContainers.push(config.name);

      if (config.environment?.PG_CONNECTION_STRING) {
        const dbName = config.name + "_db";
        data += `ContainerDb(${dbName}, "DB")
`;
        intContainers.push(dbName);
        addRel(config.name, dbName, "", false);
      }
    }
    data += `}
`;

    for (const config of deployConfigsForContainers) {
      for (const section of config.sections) {
        if (section.name.startsWith("kafka")) {
          const containers = deployConfigsForContainers.filter(
            (x) =>
              x.name !== config.name &&
              x.sections.some((s) => s.prod_value === section.prod_value),
          );
          for (const rel of containers) {
            addRel(config.name, rel.name, "", true);
          }
          if (containers.length == 0) {
            addRel(
              config.name,
              section.name.replaceAll("kafka_", "").replaceAll("_topic", ""),
              section.prod_value,
              true,
            );
          }
        } else {
          addRel(config.name, section.name, section.prod_value, false);
        }
      }
    }
    data += "@enduml";
    await fs.writeFile(filepath, data);

    function addRel(
      fromName: string,
      toName: string,
      transport: string,
      async: boolean,
    ): void {
      if (
        !rels.some(
          (x) =>
            (x.from === fromName && x.to === toName) ||
            (x.to === fromName && x.from === toName),
        )
      ) {
        var transportAttribute = "";
        if (
          !intContainers.includes(toName) &&
          !extSystems.includes(toName)
        ) {
          data += `System_Ext(${toName}, "${toName}", " ")
`;
          extSystems.push(toName);
          transportAttribute = `, "${transport}"`;
        }

        data += `Rel(${fromName}, ${toName}, ""${transportAttribute}`;
        if (async) data += `, $tags="async"`;
        data += `)
`;

        rels.push({
          from: fromName,
          to: toName,
        } as Stdlib_C4_Dynamic_Rel);
      }
    }
  });
});
