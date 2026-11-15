import * as v from "valibot";

import type { Format } from "../types";
import { generate } from "./generate";
import { load } from "./load";
import { structurizrDslSyntax } from "./syntax";

/**
 * Structurizr формат. Loader принимает `workspace.json` и `*.dsl`.
 * Generator эмитит `workspace.dsl` (DSL — основной authoring surface;
 * JSON генерируется upstream через `structurizr-cli export`).
 *
 * Fix mechanism: только DSL source. JSON-source refused upstream
 * (check.ts guard) — это generated artifact, authoring через DSL.
 * Fixes записываются обратно в `source.path`. Если нужен JSON
 * в git — регенерируется через `structurizr-cli export` после
 * редактирования DSL.
 *
 * Auto-detect priority: `workspace.json` exact > `*.dsl` extension.
 * Любой DSL-файл (`workspace.dsl`, `architecture.dsl`, `c4.dsl`)
 * подхватывается без явного `type: "structurizr"`.
 */
export const structurizrFormat: Format = {
  name: "structurizr",
  // No load options: the source file is the whole contract.
  loadOptionsSchema: v.strictObject({}),
  defaultPattern: ["workspace.json", "*.dsl"],
  load,
  generate,
  fix: { syntax: structurizrDslSyntax },
};
