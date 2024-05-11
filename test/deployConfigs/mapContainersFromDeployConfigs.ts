import { Section } from "../containers";

import { DeployConfig } from ".";

const mapFromConfig = (deployConfig: DeployConfig): DeployConfig => {
  const envWhitelist = [
    "BASE_URL",
    "PROTOCOL",
    /[A-Z_]+(?<!ERROR)_TOPIC/,
    "__BaseAddress",
    "__BaseAddress",
    "__Endpoint",
    "__SmtpServer",
    "QueueName",
  ];
  const envNamePartsToCleanup = [
    "_BASE_URL",
    "_API",
    "_CLIENT",
    "_PROTOCOL",
    /_KAFKA_[A-Z_]+_TOPIC/,
  ];

  const synonymes = new Map<string, string[]>([]);

  const environment = deployConfig?.environment ?? {};
  const envKeys = Object.keys(environment);
  const filteredEnvKeys = envKeys.filter((envName) =>
    envWhitelist.some((white) => envName.match(white)),
  );

  const sections: Section[] = filteredEnvKeys
    .map((envName) => {
      const value = environment[envName] as any;
      return {
        prod_value: value.prod ?? value.default,
        name: envNamePartsToCleanup
          .reduce(
            (acc, partToCleanup) => acc.toString().replace(partToCleanup, ""),
            envName,
          )
          .toString(),
      };
    })
    .map((relation) => {
      relation.name = relation.name.toLowerCase();
      for (const entry of synonymes.entries()) {
        if (entry[1].includes(relation.name)) relation.name = entry[0];
      }
      return relation;
    });
  deployConfig.name = (deployConfig.name ?? deployConfig.fileName).replace(/[\s-\(\)]/g, "_");
  deployConfig.sections = sections;

  return deployConfig;
};

export const mapFromConfigs = (
  deployConfigs: DeployConfig[],
): DeployConfig[] => {
  return deployConfigs
    .map(mapFromConfig)
    .sort((a, b) => a.name.localeCompare(b.name));
};
