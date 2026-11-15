import * as v from "valibot";

/**
 * Shared valibot pieces for per-format `source.options` schemas.
 * `ElementKind` picklist mirrors `model/types.ts` — keep in sync.
 */
export const elementKindSchema = v.picklist([
  "Person",
  "System",
  "Container",
  "ContainerDb",
  "ContainerQueue",
  "Component",
  "ComponentDb",
  "ComponentQueue",
]);

/** `imageHeuristic: { "*postgres*": "ContainerDb" }` — image pattern → kind. */
export const imageHeuristicSchema = v.record(v.string(), elementKindSchema);
