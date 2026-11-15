import { loadConfig } from "c12";
import { createJiti } from "jiti";
import { basename, dirname, isAbsolute, join, resolve } from "pathe";
import * as v from "valibot";

import type { AactConfig } from "../config";
import { AactConfigSchema } from "../config";
import { knownFormatNames, loadFormat } from "../formats/registry";
import { canLoad } from "../formats/types";
import type { RuleDefinition } from "../rules/types";
import { ToolError } from "./output";

/**
 * Simple two-shape matcher для format.defaultPattern:
 *   - "*.puml" → extension match (ends with ".puml")
 *   - "workspace.json" → basename exact match
 *
 * Полноценный glob-engine не нужен — patterns в registry короткие и
 * предсказуемые. Format может объявить массив patterns (compose
 * shipит 4 канонических имени), iterate'ируем и матчим первый
 * подходящий.
 */
const matchesPattern = (
  filePath: string,
  pattern: string | readonly string[],
): boolean => {
  const patterns = typeof pattern === "string" ? [pattern] : pattern;
  return patterns.some((p) =>
    p.startsWith("*")
      ? filePath.endsWith(p.slice(1))
      : basename(filePath) === p,
  );
};

/**
 * Validate каждый customRules entry — это `RuleDefinition` (name/description/
 * check required; fix optional). valibot v.array(v.any()) принимает любую
 * структуру; shape-check здесь даёт actionable error до того как rule
 * попытается выполниться.
 *
 * Conflict detection (name vs built-in / другой custom) — отдельно в check.ts
 * на activation time, потому что требует registry knowledge.
 */
const validateCustomRules = (
  entries: readonly unknown[],
): readonly RuleDefinition[] => {
  const validated: RuleDefinition[] = [];
  for (const [i, raw] of entries.entries()) {
    if (!raw || typeof raw !== "object") {
      throw new ToolError(
        "config.invalidCustomRule",
        `customRules[${i}]: expected RuleDefinition object (got ${typeof raw})`,
        { index: String(i) },
      );
    }
    const rule = raw as Record<string, unknown>;
    if (typeof rule.name !== "string" || !rule.name) {
      throw new ToolError(
        "config.invalidCustomRule",
        `customRules[${i}]: missing "name" (must be non-empty string)`,
        { index: String(i) },
      );
    }
    if (typeof rule.description !== "string") {
      throw new ToolError(
        "config.invalidCustomRule",
        `customRules[${i}] "${rule.name}": missing "description" string`,
        { index: String(i), name: rule.name },
      );
    }
    if (typeof rule.check !== "function") {
      throw new ToolError(
        "config.invalidCustomRule",
        `customRules[${i}] "${rule.name}": "check" must be a function`,
        { index: String(i), name: rule.name },
      );
    }
    if (rule.fix !== undefined && typeof rule.fix !== "function") {
      throw new ToolError(
        "config.invalidCustomRule",
        `customRules[${i}] "${rule.name}": "fix" must be a function if provided`,
        { index: String(i), name: rule.name },
      );
    }
    validated.push(rule as unknown as RuleDefinition);
  }
  return validated;
};

const inferSourceType = async (filePath: string): Promise<string> => {
  for (const name of knownFormatNames()) {
    const fmt = await loadFormat(name);
    if (!canLoad(fmt) || !fmt.defaultPattern) continue;
    if (matchesPattern(filePath, fmt.defaultPattern)) return name;
  }
  const known = knownFormatNames().join(", ");
  throw new ToolError(
    "format.unknown",
    `Cannot infer source format from "${filePath}". Add explicit \`source.type\` to aact.config.ts (known: ${known}).`,
    { path: filePath },
  );
};

const describeError = (error: unknown): string => {
  if (error instanceof v.ValiError) {
    const issues = error.issues as Array<{ message: string }>;
    return issues.map((issue) => issue.message).join("; ");
  }
  if (error instanceof Error) return error.message;
  return String(error);
};

interface RawConfigResult {
  readonly raw: unknown;
  /** Absolute path to the config file c12 actually resolved (whether
   *  via explicit `--config` or default discovery in cwd / parents).
   *  `null` when no file was found — c12 returns an empty config in
   *  that case, which we surface as `config.missingSource` upstream. */
  readonly configFile: string | null;
}

const loadRawConfig = async (
  configPath: string | undefined,
): Promise<RawConfigResult> => {
  try {
    // c12 v4 tries a bare native `import()` of the config before falling
    // back to jiti. On Node ≥22.18 that native attempt on a .ts file in a
    // project without `"type": "module"` makes Node print a "Failed to
    // load the ES module" warning to stderr on *every* command, even
    // though the jiti fallback then loads the config fine. Supplying a
    // jiti-backed `import` up front skips the noisy native attempt (jiti
    // keeps `tryNative` off by default) and makes config loading
    // identical across Node versions. Options mirror c12's own fallback.
    const jiti = createJiti(join(process.cwd(), configPath ?? "/"), {
      interopDefault: true,
      moduleCache: false,
    });
    const result = await loadConfig({
      name: "aact",
      import: (id) => jiti.import(id),
      ...(configPath ? { configFile: configPath } : {}),
    });
    return {
      raw: result.config,
      configFile:
        result.configFile ?? (configPath ? resolve(configPath) : null),
    };
  } catch (error) {
    throw new ToolError(
      "config.loadFailed",
      `Failed to load aact config: ${describeError(error)}`,
      configPath ? { path: configPath } : undefined,
    );
  }
};

/**
 * `source.options` — per-format shape, so the top-level schema can't
 * check it; the format does, through `Format.loadOptionsSchema`. A
 * format without a schema takes no options at all — silently ignoring
 * a mistyped block is exactly the failure this guards against.
 */
const validateSourceOptions = async (
  type: string,
  options: unknown,
  configPath: string | undefined,
): Promise<void> => {
  const format = await loadFormat(type);
  const details: Record<string, string> = configPath
    ? { path: configPath, type }
    : { type };
  if (format.loadOptionsSchema === undefined) {
    throw new ToolError(
      "config.invalidSchema",
      `source.options is not accepted for format "${type}": it has no load options. Remove the block from aact.config.ts.`,
      details,
    );
  }
  const result = v.safeParse(format.loadOptionsSchema, options);
  if (result.success) return;

  // An unknown key is the common mistake (a typo, or options copied from
  // another format), and valibot words it as "Expected never but received
  // …". Name the key and list what the format does accept instead.
  const unknownKeys = result.issues
    .filter((issue) => issue.type === "strict_object")
    .map((issue) => String(issue.path?.at(-1)?.key));
  const schema = format.loadOptionsSchema as { entries?: object };
  const accepted = schema.entries ? Object.keys(schema.entries) : [];
  if (unknownKeys.length > 0 && accepted.length === 0) {
    throw new ToolError(
      "config.invalidSchema",
      `source.options is not accepted for format "${type}": it has no load options (got ${quoteAll(unknownKeys)}). Remove the block from aact.config.ts.`,
      details,
    );
  }
  if (unknownKeys.length > 0) {
    throw new ToolError(
      "config.invalidSchema",
      `Unknown source.options key ${quoteAll(unknownKeys)} for format "${type}". Accepted keys: ${accepted.join(", ")}.`,
      details,
    );
  }
  throw new ToolError(
    "config.invalidSchema",
    `source.options for format "${type}" failed schema validation: ${describeError(new v.ValiError(result.issues))}`,
    details,
  );
};

const quoteAll = (keys: readonly string[]): string =>
  keys.map((key) => `"${key}"`).join(", ");

const parseConfig = (
  raw: unknown,
  configPath: string | undefined,
): v.InferOutput<typeof AactConfigSchema> => {
  try {
    return v.parse(AactConfigSchema, raw);
  } catch (error) {
    throw new ToolError(
      "config.invalidSchema",
      `aact config failed schema validation: ${describeError(error)}`,
      configPath ? { path: configPath } : undefined,
    );
  }
};

const isAbsent = (raw: unknown): boolean => {
  if (!raw) return true;
  // c12 returns {} when no config file is found in cwd / parents. Treat as
  // absent so commands that tolerate "no config" (like `rule list`) can
  // differentiate from a real schema-invalid config.
  return typeof raw === "object" && Object.keys(raw).length === 0;
};

const resolveConfigRelativePath = (
  filePath: string,
  configFile: string | null,
): string => {
  if (isAbsolute(filePath) || !configFile) return filePath;
  return resolve(dirname(configFile), filePath);
};

export interface LoadedConfig {
  readonly config: AactConfig;
  /** Absolute path to the resolved config file. `null` when caller
   *  explicitly passed no file (e.g. `rule list` swallows
   *  `config.missingSource`). Surfaces in `envelope.meta.configPath`
   *  so agents see *where* the config was loaded from, not just
   *  whether a `--config` flag was used. */
  readonly configPath: string | null;
}

export const loadAndValidateConfig = async (
  configPath?: string,
): Promise<LoadedConfig> => {
  const { raw, configFile } = await loadRawConfig(configPath);

  if (isAbsent(raw)) {
    throw new ToolError(
      "config.missingSource",
      "No aact config found. Create an aact.config.ts file (run `aact init` to scaffold).",
    );
  }

  const parsed = parseConfig(raw, configPath);
  const configBase = configFile;

  // Normalize source: string shorthand → object form, infer type if missing.
  const rawSource =
    typeof parsed.source === "string" ? { path: parsed.source } : parsed.source;
  const type = rawSource.type ?? (await inferSourceType(rawSource.path));
  const sourcePath = resolveConfigRelativePath(rawSource.path, configBase);
  const sourceOptions: unknown =
    "options" in rawSource && rawSource.options !== undefined
      ? rawSource.options
      : undefined;

  // Validate explicit type against registry — fail fast вместо deferred
  // "Unknown format" из loadModel. Inferred type гарантированно валиден.
  if (rawSource.type && !knownFormatNames().includes(type)) {
    throw new ToolError(
      "format.unknown",
      `Unknown source.type "${type}" in aact.config.ts (known: ${knownFormatNames().join(", ")}).`,
      { type },
    );
  }

  if (sourceOptions !== undefined) {
    await validateSourceOptions(type, sourceOptions, configFile ?? undefined);
  }

  const customRules = parsed.customRules
    ? validateCustomRules(parsed.customRules)
    : undefined;

  return {
    config: {
      ...parsed,
      customRules,
      source: {
        path: sourcePath,
        type,
        ...(sourceOptions === undefined ? {} : { options: sourceOptions }),
      },
    },
    configPath: configFile,
  };
};
