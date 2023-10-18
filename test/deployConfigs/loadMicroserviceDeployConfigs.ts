import fs from "fs/promises";
import path from "path";

import YAML from "yaml";

import { DeployConfig } from "./deployConfig";

const getMicroserviceFilepaths = async ():Promise<string[]> => {
  const partialNamesToExclude = ["migrator", "platform", "citest", "tests"];
  const namesToExclude = new Set(["reception-orchestrator.yml"]);

  const deploysPath = path.join(process.cwd(), "kubernetes", "microservices");

  const filenames = (await fs.readdir(deploysPath, "utf8"))
    .filter((filename) => path.extname(filename) === ".yml")
    .filter((filename) => !namesToExclude.has(filename))
    .filter((filename) =>
      partialNamesToExclude.every((toExclude) => !filename.includes(toExclude))
    );

  return filenames.map((filename) => path.join(deploysPath, filename));
};

export const loadMicroserviceDeployConfigs = async (): Promise<
  DeployConfig[]
> => {
  const filepaths = await getMicroserviceFilepaths();
  return Promise.all(
    filepaths.map(async (filePath):Promise<DeployConfig> => YAML.parse(await fs.readFile(filePath, "utf8")))
  );
};
