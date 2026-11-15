import { promises as fs } from "node:fs";

import path from "pathe";
import type { Node } from "yaml";
import { isScalar, parseAllDocuments } from "yaml";

import type { ModelIssue, SourceLocation } from "../../model";
import type { OffsetTable } from "../_shared/yamlSourceMap";
import { findKeyPair, rangeToLocation } from "../_shared/yamlSourceMap";
import { resolveKustomization } from "./kustomize";
import type { ParsedManifest, ParsedMetadata } from "./types";

/**
 * Filesystem traversal + multi-doc YAML parsing для k8s manifests.
 *
 * Entry point — file ИЛИ directory:
 *  - Файл: parse as multi-doc YAML, каждый doc → `ParsedManifest`.
 *  - Директория: recursive walk по `*.yaml` / `*.yml`, skip скрытых
 *    папок (`.git`, `.helm` etc.) и `kustomization.yaml` (Phase C
 *    обрабатывает kustomize отдельно).
 *
 * Helm templates (файл содержит `{{`) — fail-fast с понятной
 * ошибкой. Helm — отдельная история (Phase 3), user должен
 * сначала `helm template` сам.
 */

export interface WalkResult {
  readonly manifests: readonly ParsedManifest[];
  /** Файлы-warning'и (skipped kustomization, parse errors etc.). */
  readonly issues: readonly ModelIssue[];
}

const YAML_EXT = new Set([".yaml", ".yml"]);

const HIDDEN_DIR_PREFIX = ".";

/** Helm template marker. Phase 3 — добавим helm-template renderer. */
const HELM_MARKER = /\{\{/;

/**
 * Walk entry path (file или dir) → flat list manifests.
 *
 * Kustomization chase: если встретили `kustomization.yaml` (как
 * entry-point ИЛИ в директории) — читаем `resources` поле и chase'им
 * каждый path рекурсивно. Cycle protection через `visited` set по
 * absolute paths — kustomize allows overlay-references на base
 * directories, потенциальный source циклов.
 */
export const walkManifests = async (entryPath: string): Promise<WalkResult> => {
  const resolved = path.resolve(entryPath);
  const stat = await fs.stat(resolved);

  const manifests: ParsedManifest[] = [];
  const issues: ModelIssue[] = [];
  const visited = new Set<string>();

  if (stat.isFile()) {
    await parseEntry(resolved, manifests, issues, visited);
  } else if (stat.isDirectory()) {
    await walkDirectory(resolved, manifests, issues, visited);
  } else {
    throw new Error(
      `Kubernetes source must be a file or directory: ${entryPath}.`,
    );
  }

  return {
    manifests: Object.freeze(manifests),
    issues: Object.freeze(issues),
  };
};

/**
 * Entry-point dispatcher: kustomization.yaml → resources chase,
 * regular YAML → parse как manifest file. Используется И на entry
 * level, И когда recursive directory walk натыкается на отдельный
 * файл.
 */
const parseEntry = async (
  absPath: string,
  manifests: ParsedManifest[],
  issues: ModelIssue[],
  visited: Set<string>,
): Promise<void> => {
  if (visited.has(absPath)) return;
  visited.add(absPath);

  const base = path.basename(absPath).toLowerCase();
  if (base === "kustomization.yaml" || base === "kustomization.yml") {
    const result = await resolveKustomization(absPath);
    issues.push(...result.issues);
    for (const resourcePath of result.resourcePaths) {
      try {
        const stat = await fs.stat(resourcePath);
        if (stat.isDirectory()) {
          await walkDirectory(resourcePath, manifests, issues, visited);
        } else if (stat.isFile()) {
          await parseEntry(resourcePath, manifests, issues, visited);
        }
      } catch {
        issues.push({
          kind: "loader-warning",
          source: "kubernetes",
          code: "kustomize-resource-missing",
          message: `Kustomize resource not found: ${resourcePath} (referenced from ${absPath}).`,
        });
      }
    }
    return;
  }

  await parseFile(absPath, manifests, issues);
};

/**
 * Recursive YAML walker. Если в директории есть `kustomization.yaml`,
 * следуем ТОЛЬКО за её `resources` field (kustomize convention —
 * sibling файлы НЕ авто-applied, только referenced). Если нет —
 * walk siblings + recurse в поддиректории как обычно.
 */
const walkDirectory = async (
  dir: string,
  manifests: ParsedManifest[],
  issues: ModelIssue[],
  visited: Set<string>,
): Promise<void> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const kustomization = entries.find(
    (e) =>
      e.isFile() &&
      (e.name === "kustomization.yaml" || e.name === "kustomization.yml"),
  );
  if (kustomization) {
    await parseEntry(
      path.join(dir, kustomization.name),
      manifests,
      issues,
      visited,
    );
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(HIDDEN_DIR_PREFIX)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(full, manifests, issues, visited);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!YAML_EXT.has(ext)) continue;
    await parseEntry(full, manifests, issues, visited);
  }
};

const parseFile = async (
  filePath: string,
  manifests: ParsedManifest[],
  issues: ModelIssue[],
): Promise<void> => {
  const content = await fs.readFile(filePath, "utf8");
  if (HELM_MARKER.test(content)) {
    // Throw plain Error — `loadModel.ts` catches и пользователь видит
    // понятный совет (`helm template > rendered.yaml`). Не делаем
    // partial-success здесь: helm-templated файл не парсится в
    // valid YAML, и tail manifests могут оказаться garbage.
    throw new Error(
      `Helm template detected at ${filePath}. aact's k8s loader does not render Helm; run \`helm template <release> <chart> > rendered.yaml\` and point aact at the rendered output.`,
    );
  }

  const docs = parseAllDocuments(content);
  const table = { source: content, file: filePath };
  for (const [docIndex, doc] of docs.entries()) {
    const json: unknown = doc.toJSON();
    if (!json || typeof json !== "object") continue; // empty doc
    const manifest = toManifest(
      filePath,
      docIndex,
      json as Record<string, unknown>,
      manifestLocation(table, doc.contents ?? undefined),
    );
    if (manifest === undefined) {
      issues.push({
        kind: "loader-warning",
        source: "kubernetes",
        code: "missing-kind-or-name",
        message: `Manifest at ${filePath} doc[${docIndex}] missing required apiVersion/kind/metadata.name — skipped.`,
      });
      continue;
    }
    manifests.push(manifest);
  }
};

/**
 * Validate minimal k8s manifest shape + extract typed slots.
 * Возвращает `undefined` если manifest нерас распознаваемый
 * (missing apiVersion / kind / metadata.name) — caller'у issue
 * выставлять.
 */
/**
 * Where a manifest is declared: the `metadata.name` value (the line a reader
 * looks for), falling back to the start of the document. Node ranges from
 * `parseAllDocuments` are offsets into the whole file, so multi-document
 * files resolve to the right line.
 */
const manifestLocation = (
  table: OffsetTable,
  contents: Node | undefined,
): SourceLocation | undefined => {
  const nameNode = findKeyPair(
    findKeyPair(contents, "metadata")?.value as Node | undefined,
    "name",
  )?.value;
  if (isScalar(nameNode) && Array.isArray(nameNode.range)) {
    return rangeToLocation(table, nameNode.range);
  }
  return Array.isArray(contents?.range)
    ? rangeToLocation(table, contents.range)
    : undefined;
};

const toManifest = (
  filePath: string,
  docIndex: number,
  raw: Record<string, unknown>,
  sourceLocation: SourceLocation | undefined,
): ParsedManifest | undefined => {
  const apiVersion = raw.apiVersion;
  const kind = raw.kind;
  if (typeof apiVersion !== "string" || apiVersion.length === 0)
    return undefined;
  if (typeof kind !== "string" || kind.length === 0) return undefined;

  const meta = extractMetadata(raw.metadata);
  if (meta === undefined) return undefined;

  const spec =
    raw.spec && typeof raw.spec === "object"
      ? (raw.spec as Record<string, unknown>)
      : undefined;

  return Object.freeze({
    filePath,
    docIndex,
    apiVersion,
    kind,
    metadata: meta,
    spec,
    raw,
    ...(sourceLocation ? { sourceLocation } : {}),
  } satisfies ParsedManifest);
};

const extractMetadata = (raw: unknown): ParsedMetadata | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const name = r.name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  const namespace = typeof r.namespace === "string" ? r.namespace : undefined;
  const labels = extractStringRecord(r.labels);
  const annotations = extractStringRecord(r.annotations);
  return Object.freeze({
    name,
    ...(namespace ? { namespace } : {}),
    labels,
    annotations,
  });
};

const extractStringRecord = (
  raw: unknown,
): Readonly<Record<string, string>> => {
  if (!raw || typeof raw !== "object") return Object.freeze({});
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean")
      out[k] = String(v);
  }
  return Object.freeze(out);
};
