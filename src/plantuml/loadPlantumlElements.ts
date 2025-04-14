import fs from "fs/promises";
import path from "path";

import { Comment, parse as parsePuml, Stdlib_C4_Dynamic_Rel, UMLElement } from "plantuml-parser";

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

  for (const element of elements) {
    if (element instanceof Comment) continue;
    if((element as Stdlib_C4_Dynamic_Rel).type_.name.startsWith("Rel_Back"))
    {
      const from = (element as Stdlib_C4_Dynamic_Rel).from;
      (element as Stdlib_C4_Dynamic_Rel).from = (element as Stdlib_C4_Dynamic_Rel).to;
      (element as Stdlib_C4_Dynamic_Rel).to = from;
    }
  }

  return filterElements(elements);
};
