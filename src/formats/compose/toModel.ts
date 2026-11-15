import path from "pathe";

import type { Element, Model, ModelIssue, Relation } from "../../model";
import { buildModel } from "../../model";
import { humanizeName } from "../_shared/humanize";
import {
  compileImageHeuristic,
  inferKindFromImage,
  matchesGlob,
  parseImage,
  technologyLabel,
} from "../_shared/imageHeuristic";
import { parseCsvTags } from "../_shared/tags";
import type { Document, OffsetTable } from "../_shared/yamlSourceMap";
import {
  findKeyPair,
  keyLocation,
  valueLocationFor,
} from "../_shared/yamlSourceMap";
import { normalizeDependsOn } from "./dependsOn";
import type { IncludedFile } from "./include";
import { normalizeLabels, resolveLabelKeys } from "./labels";
import { buildAiModelElement, buildAiModelRelation } from "./models";
import { resolveNamingTransform } from "./naming";
import { buildProviderElement } from "./providers";
import type {
  ComposeLoadOptions,
  ParsedAiModel,
  ParsedService,
  ResolvedOptions,
} from "./types";

/**
 * Merge список IncludedFile → один логический ParsedComposeFile.
 * Compose Spec: current-file ключи overridden included-file ключи на
 * коллизии. `resolveIncludes` уже отдаёт DFS post-order — entry file
 * последний — поэтому простой Object.assign по services / models
 * достаточен.
 */
const mergeFiles = (
  files: readonly IncludedFile[],
): {
  readonly services: Record<string, ParsedService>;
  readonly models: Record<string, ParsedAiModel>;
  readonly name?: string;
  readonly version?: string;
} => {
  const services: Record<string, ParsedService> = {};
  const models: Record<string, ParsedAiModel> = {};
  let name: string | undefined;
  let version: string | undefined;
  for (const file of files) {
    if (file.parsed.services) {
      for (const [k, v] of Object.entries(file.parsed.services))
        services[k] = v;
    }
    if (file.parsed.models) {
      for (const [k, v] of Object.entries(file.parsed.models)) models[k] = v;
    }
    if (file.parsed.name !== undefined) name = file.parsed.name;
    if (file.parsed.version !== undefined) version = file.parsed.version;
  }
  return { services, models, name, version };
};

interface FileLookup {
  readonly tableByFile: ReadonlyMap<string, OffsetTable>;
  readonly docByFile: ReadonlyMap<string, Document>;
}

const buildFileLookup = (files: readonly IncludedFile[]): FileLookup => {
  const tableByFile = new Map<string, OffsetTable>();
  const docByFile = new Map<string, Document>();
  for (const f of files) {
    tableByFile.set(f.file, Object.freeze({ source: f.source, file: f.file }));
    docByFile.set(f.file, f.documentFactory());
  }
  return { tableByFile, docByFile };
};

/**
 * Каждый service объявлен в каком-то included file (а не в логическом
 * merge'е). Найти владельца чтобы выставить точный sourceLocation.
 * При коллизии (service переопределён в more-current file) — возвращаем
 * последнее объявление (last-write-wins).
 */
const findServiceOrigin = (
  files: readonly IncludedFile[],
  serviceName: string,
): IncludedFile | undefined => {
  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i];
    if (file.parsed.services && serviceName in file.parsed.services)
      return file;
  }
  return undefined;
};

const findModelOrigin = (
  files: readonly IncludedFile[],
  modelName: string,
): IncludedFile | undefined => {
  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i];
    if (file.parsed.models && modelName in file.parsed.models) return file;
  }
  return undefined;
};

const DEFAULT_PROVIDER_TAGS: readonly string[] = Object.freeze(["provider"]);
const DEFAULT_MODEL_TAGS: readonly string[] = Object.freeze(["ai", "model"]);
const DEFAULT_MODEL_RELATION_DESC = "uses AI model";

const resolveOptions = (
  user: ComposeLoadOptions | undefined,
): ResolvedOptions => {
  const labels = resolveLabelKeys(user?.labels);
  const imageHeuristic = compileImageHeuristic(user?.imageHeuristic);
  return Object.freeze({
    applyNaming: resolveNamingTransform(user?.naming),
    labels,
    imageHeuristic,
    skip: Object.freeze([...(user?.skip ?? [])]),
    overrides: Object.freeze([...(user?.overrides ?? [])]),
    profiles: Object.freeze([...(user?.profiles ?? [])]),
    providers: Object.freeze({
      defaultTags: Object.freeze([
        ...(user?.providers?.defaultTags ?? DEFAULT_PROVIDER_TAGS),
      ]),
    }),
    models: Object.freeze({
      defaultTags: Object.freeze([
        ...(user?.models?.defaultTags ?? DEFAULT_MODEL_TAGS),
      ]),
      relationDescription:
        user?.models?.relationDescription ?? DEFAULT_MODEL_RELATION_DESC,
    }),
  });
};

interface ToModelInput {
  readonly entryFile: string;
  readonly files: readonly IncludedFile[];
  readonly options: ComposeLoadOptions | undefined;
}

interface ToModelOutput {
  readonly model: Model;
  readonly issues: readonly ModelIssue[];
}

interface ServiceContext {
  readonly rawName: string;
  readonly service: ParsedService;
  readonly origin: IncludedFile | undefined;
  readonly table: OffsetTable | undefined;
  readonly servicePair: ReturnType<typeof findKeyPair>;
  readonly serviceLocation: ReturnType<typeof keyLocation>;
}

const findServiceContext = (
  files: readonly IncludedFile[],
  lookup: FileLookup,
  rawName: string,
  service: ParsedService,
): ServiceContext => {
  const origin = findServiceOrigin(files, rawName);
  const table = origin ? lookup.tableByFile.get(origin.file) : undefined;
  const doc = origin ? lookup.docByFile.get(origin.file) : undefined;
  const servicesMap = doc?.contents
    ? findKeyPair(doc.contents, "services")?.value
    : undefined;
  const servicePair = servicesMap
    ? findKeyPair(servicesMap as never, rawName)
    : undefined;
  const serviceLocation =
    table && servicePair ? keyLocation(table, servicePair) : undefined;
  return { rawName, service, origin, table, servicePair, serviceLocation };
};

const buildRelations = (
  ctx: ServiceContext,
  resolved: ResolvedOptions,
): readonly Relation[] => {
  const dependsOnNames = normalizeDependsOn(ctx.service.depends_on);
  const dependsOnMapNode = ctx.servicePair
    ? findKeyPair(ctx.servicePair.value as never, "depends_on")?.value
    : undefined;
  const relations: Relation[] = dependsOnNames.map((rawTo) => {
    // Apply naming transform к target тоже — иначе depends_on
    // `landing-app` указывает на element которого нет (потому что
    // мы зарегистрировали его как `landingApp`).
    const to = resolved.applyNaming(rawTo);
    const relLocation =
      ctx.table && dependsOnMapNode
        ? valueLocationFor(ctx.table, dependsOnMapNode as never, rawTo)
        : undefined;
    return Object.freeze({
      to,
      description: "depends on",
      tags: Object.freeze([] as readonly string[]),
      ...(relLocation === undefined ? {} : { sourceLocation: relLocation }),
    } satisfies Relation);
  });
  for (const modelRef of ctx.service.models ?? []) {
    relations.push(
      buildAiModelRelation(resolved.applyNaming(modelRef), resolved),
    );
  }
  return Object.freeze(relations);
};

const buildServiceElement = (
  ctx: ServiceContext,
  resolved: ResolvedOptions,
  labelsMap: ReturnType<typeof normalizeLabels>,
  name: string,
): Element => {
  const imageRaw =
    typeof ctx.service.image === "string" ? ctx.service.image : "";
  const parsedImg = parseImage(imageRaw);
  const inferredKind = inferKindFromImage(
    parsedImg.baseName,
    parsedImg.repo,
    resolved.imageHeuristic,
  );
  const overrideKind = labelsMap.map[resolved.labels.kind]?.trim();
  const kind = (
    overrideKind && overrideKind.length > 0 ? overrideKind : inferredKind
  ) as Element["kind"];
  const overrideTech = labelsMap.map[resolved.labels.technology]?.trim();
  const technology =
    overrideTech && overrideTech.length > 0
      ? overrideTech
      : technologyLabel(parsedImg) || undefined;
  const overrideLabel = labelsMap.map[resolved.labels.label]?.trim();
  const externalRaw = labelsMap.map[resolved.labels.external]?.trim();
  const external = externalRaw === "true" || externalRaw === "1";
  const descriptionLabel = labelsMap.map[resolved.labels.description] ?? "";
  const link = labelsMap.map[resolved.labels.link];
  const tags = parseCsvTags(labelsMap.map[resolved.labels.tags] ?? "");
  const relations = buildRelations(ctx, resolved);

  return Object.freeze({
    name,
    label:
      overrideLabel && overrideLabel.length > 0
        ? overrideLabel
        : humanizeName(name),
    kind,
    external,
    description: descriptionLabel,
    ...(technology ? { technology } : {}),
    tags: Object.freeze(tags),
    relations,
    ...(link && link.length > 0 ? { link } : {}),
    ...(ctx.serviceLocation === undefined
      ? {}
      : { sourceLocation: ctx.serviceLocation }),
  } satisfies Element);
};

interface ServiceProcessOutput {
  readonly element: Element | undefined;
  readonly issues: readonly ModelIssue[];
}

const isSkipped = (
  rawName: string,
  labelsMap: ReturnType<typeof normalizeLabels>,
  resolved: ResolvedOptions,
): boolean => {
  // Per-service label override beats config-level skip patterns.
  const skipLabel = labelsMap.map[resolved.labels.skip]?.trim().toLowerCase();
  if (skipLabel === "true" || skipLabel === "1") return true;
  for (const pattern of resolved.skip) {
    if (matchesGlob(rawName, pattern)) return true;
  }
  return false;
};

const processService = (
  ctx: ServiceContext,
  resolved: ResolvedOptions,
): ServiceProcessOutput => {
  const issues: ModelIssue[] = [];
  const labelsMap = normalizeLabels(ctx.service.labels);
  for (const i of labelsMap.malformedIndices) {
    issues.push({
      kind: "loader-warning",
      source: "compose",
      code: "malformed-label",
      message: `Service "${ctx.rawName}" label entry [${i}] is missing "=" and was skipped`,
      element: ctx.rawName,
    });
  }

  if (isSkipped(ctx.rawName, labelsMap, resolved)) {
    return { element: undefined, issues: Object.freeze(issues) };
  }

  // Explicit element-name label OVERRIDES naming transform — оба
  // механизма decoupled: naming для массового convention'а, label
  // для одного-двух edge case'ов.
  const overrideName = labelsMap.map[resolved.labels.element]?.trim();
  const name =
    overrideName && overrideName.length > 0
      ? overrideName
      : resolved.applyNaming(ctx.rawName);

  if (ctx.service.extends) {
    issues.push({
      kind: "loader-warning",
      source: "compose",
      code: "extends-unsupported",
      message: `Service "${name}" uses "extends" which is not yet supported; base service skipped`,
      element: name,
    });
  }

  if (ctx.service.provider) {
    const element = buildProviderElement(
      {
        name,
        label:
          labelsMap.map[resolved.labels.label]?.trim() || humanizeName(name),
        description: labelsMap.map[resolved.labels.description] ?? "",
        provider: ctx.service.provider,
        extraTags: parseCsvTags(labelsMap.map[resolved.labels.tags] ?? ""),
        link: labelsMap.map[resolved.labels.link],
        sourceLocation: ctx.serviceLocation,
      },
      resolved,
    );
    return { element, issues: Object.freeze(issues) };
  }

  const imageRaw =
    typeof ctx.service.image === "string" ? ctx.service.image : "";
  if (!imageRaw && !ctx.service.build) {
    issues.push({
      kind: "loader-warning",
      source: "compose",
      code: "no-image-or-build",
      message: `Service "${name}" declares neither "image" nor "build" — defaulting to Container`,
      element: name,
    });
  }

  return {
    element: buildServiceElement(ctx, resolved, labelsMap, name),
    issues: Object.freeze(issues),
  };
};

const processModel = (
  files: readonly IncludedFile[],
  lookup: FileLookup,
  modelName: string,
  modelDef: ParsedAiModel,
  resolved: ResolvedOptions,
): Element => {
  const origin = findModelOrigin(files, modelName);
  const table = origin ? lookup.tableByFile.get(origin.file) : undefined;
  const doc = origin ? lookup.docByFile.get(origin.file) : undefined;
  const modelsMap = doc?.contents
    ? findKeyPair(doc.contents, "models")?.value
    : undefined;
  const modelPair = modelsMap
    ? findKeyPair(modelsMap as never, modelName)
    : undefined;
  const modelLocation =
    table && modelPair ? keyLocation(table, modelPair) : undefined;

  const transformedName = resolved.applyNaming(modelName);
  return buildAiModelElement(
    {
      name: transformedName,
      label: humanizeName(transformedName),
      parsed: modelDef,
      sourceLocation: modelLocation,
    },
    resolved,
  );
};

export const toModel = (input: ToModelInput): ToModelOutput => {
  const issues: ModelIssue[] = [];
  const resolved = resolveOptions(input.options);
  const merged = mergeFiles(input.files);
  const lookup = buildFileLookup(input.files);

  if (merged.version !== undefined) {
    issues.push({
      kind: "loader-warning",
      source: "compose",
      code: "version-obsolete",
      message: `Compose top-level "version" field is obsolete in Compose Spec and ignored`,
    });
  }

  const elements: Element[] = [];

  for (const [rawName, rawService] of Object.entries(merged.services ?? {})) {
    const ctx = findServiceContext(input.files, lookup, rawName, rawService);
    const result = processService(ctx, resolved);
    if (result.element) elements.push(result.element);
    issues.push(...result.issues);
  }

  for (const [modelName, modelDef] of Object.entries(merged.models ?? {})) {
    elements.push(
      processModel(input.files, lookup, modelName, modelDef, resolved),
    );
  }

  const workspaceName =
    merged.name ??
    path.basename(path.dirname(path.resolve(input.entryFile))) ??
    "compose";

  const built = buildModel({
    elements,
    boundaries: [],
    rootBoundaryNames: [],
    workspace: { name: workspaceName },
  });

  return {
    model: built.model,
    issues: Object.freeze([...issues, ...built.issues]),
  };
};
