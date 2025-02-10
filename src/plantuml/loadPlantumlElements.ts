import fs from "fs/promises";
import path from "path";

import { parse as parsePuml, UMLElement } from "plantuml-parser";

import { filterElements } from "./lib/filterElements";

const getFilepath = (fileName: string): string => {
  return path.join(process.cwd(), "resources/architecture", fileName);
};

export const loadPlantumlElements = async (
  fileName: string,
): Promise<UMLElement[]> => {
  const filepath = getFilepath(fileName);

  let data = await fs.readFile(filepath, "utf8");
  data = data.replaceAll(/, \$tags=(".+?")/g, ", $1").replaceAll('""', '" "');
  const [{ elements }] = parsePuml(data);

  return filterElements(elements);
};
