// Structurizr JSON/DSL vocabulary — values as they appear in workspace.json
export const STRUCTURIZR_LOCATION_EXTERNAL = "External";

/**
 * Tags that mark a software system external, matched case-insensitively.
 * Real workspaces write `External`, `external`, `External System`; the
 * loader recognises all of them so a model never needs re-tagging for
 * aact. `location External` (JSON export) always counts.
 */
export const EXTERNAL_TAGS: ReadonlySet<string> = new Set([
  "external",
  "external system",
]);

export const hasExternalTag = (tags: readonly string[]): boolean =>
  tags.some((t) => EXTERNAL_TAGS.has(t.toLowerCase()));
export const STRUCTURIZR_INTERACTION_ASYNC = "Asynchronous";
export const STRUCTURIZR_TAG_ASYNC = "async";

export interface StructurizrWorkspace {
  id?: number;
  name: string;
  description?: string;
  model: StructurizrModel;
}

interface StructurizrModel {
  enterprise?: { name: string };
  people?: StructurizrPerson[];
  softwareSystems?: StructurizrSoftwareSystem[];
}

export interface StructurizrProperties {
  "structurizr.dsl.identifier"?: string;
  [key: string]: string | undefined;
}

/**
 * Multi-viewpoint annotations на элементе/relation'е (Solution Architect
 * use case — добавить security/scalability/operational view к одной модели).
 * Каждый perspective: { description, value? }. Сохраняем как-есть в properties
 * с prefix'ом `perspective.<name>` для round-trip без потерь.
 */
interface StructurizrPerspective {
  description: string;
  value?: string;
}

export interface StructurizrPerson {
  id: string;
  name: string;
  description?: string;
  tags?: string;
  url?: string;
  group?: string;
  properties?: StructurizrProperties;
  perspectives?: Record<string, StructurizrPerspective>;
  relationships?: StructurizrRelationship[];
}

export interface StructurizrSoftwareSystem {
  id: string;
  name: string;
  description?: string;
  location?: "External" | "Internal" | "Unspecified";
  tags?: string;
  url?: string;
  group?: string;
  properties?: StructurizrProperties;
  perspectives?: Record<string, StructurizrPerspective>;
  containers?: StructurizrContainer[];
  relationships?: StructurizrRelationship[];
}

export interface StructurizrContainer {
  id: string;
  name: string;
  description?: string;
  technology?: string;
  tags?: string;
  url?: string;
  group?: string;
  properties?: StructurizrProperties;
  perspectives?: Record<string, StructurizrPerspective>;
  components?: StructurizrComponent[];
  relationships?: StructurizrRelationship[];
}

export interface StructurizrComponent {
  id: string;
  name: string;
  description?: string;
  technology?: string;
  tags?: string;
  url?: string;
  group?: string;
  properties?: StructurizrProperties;
  perspectives?: Record<string, StructurizrPerspective>;
  relationships?: StructurizrRelationship[];
}

export interface StructurizrRelationship {
  id: string;
  description?: string;
  sourceId: string;
  destinationId: string;
  linkedRelationshipId?: string;
  technology?: string;
  interactionStyle?: "Synchronous" | "Asynchronous";
  tags?: string;
  url?: string;
  properties?: StructurizrProperties;
  perspectives?: Record<string, StructurizrPerspective>;
}
