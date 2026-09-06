import * as v from "valibot";

import type { Format } from "../types";
import { generate } from "./generate";
import { load } from "./load";
import { plantumlSyntax } from "./syntax";

export const plantumlFormat: Format = {
  name: "plantuml",
  // No load options: the source file is the whole contract.
  loadOptionsSchema: v.strictObject({}),
  defaultPattern: "*.puml",
  load,
  generate,
  fix: { syntax: plantumlSyntax },
};
