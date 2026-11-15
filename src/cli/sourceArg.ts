import { promises as fs } from "node:fs";

import type { AactConfig } from "../config";
import { detectFormatFromPath } from "../diff";
import { ruleRegistry } from "../rules/registry";
import { ToolError } from "./output";

/**
 * Optional positional `source` shared by the single-model commands
 * (`model`, `check`, `analyze`, `generate`). When given it points aact at a file or
 * directory ad-hoc — matching how `aact diff` takes its paths
 * positionally. With an `aact.config.ts` present it overrides
 * `config.source`; with no config it stands in for one, so
 * `aact model architecture.dsl` works in a bare directory. Format is
 * auto-detected from the path (directory → kubernetes, extension → the
 * matching loader).
 */
export const sourceArg = {
  source: {
    type: "positional",
    description:
      "Architecture source — file or directory. Overrides (or stands in for) aact.config.ts source; format auto-detected from the path.",
    required: false,
  },
} as const;

const inferType = async (raw: string): Promise<string | undefined> => {
  let isDirectory = false;
  try {
    isDirectory = (await fs.stat(raw)).isDirectory();
  } catch {
    // Not statable yet — fall back to extension-based detection and let
    // the loader surface a precise "source not found" error.
  }
  return detectFormatFromPath(raw, isDirectory);
};

const detectType = async (raw: string): Promise<string> => {
  const type = await inferType(raw);
  if (type === undefined) {
    throw new ToolError(
      "config.invalidSchema",
      `Cannot infer a format from "${raw}". Use a known extension (.puml / .dsl / .aact.json), a kubernetes directory, or set source.type in aact.config.ts.`,
      { path: raw },
    );
  }
  return type;
};

/** Format of the configured source — explicit `type`, else inferred from its path. */
const configuredType = async (
  source: AactConfig["source"],
): Promise<string | undefined> =>
  typeof source === "string"
    ? inferType(source)
    : (source.type ?? inferType(source.path));

/**
 * Fold a positional `source` arg into the resolved config. Returns the
 * config unchanged (same reference) when no positional was given — the
 * caller uses that identity to decide whether a config was actually
 * required. Per-format `source.options` survive the override only when
 * the positional path resolves to the same format as the configured
 * source: they describe how to read that format (which tags mean
 * "external", which annotations to honour), so one config can drive
 * `aact check a.dsl`, `aact check b.dsl`, … over a corpus. A different
 * format drops them — its loader would not understand them.
 */
export const applyPositionalSource = async (
  config: AactConfig | null,
  args: Record<string, unknown>,
): Promise<AactConfig | null> => {
  const raw = args.source;
  if (typeof raw !== "string" || raw.length === 0) return config;

  const type = await detectType(raw);
  if (config !== null) {
    const prev = config.source;
    const options =
      typeof prev !== "string" &&
      prev.options !== undefined &&
      (await configuredType(prev)) === type
        ? prev.options
        : undefined;
    const source =
      options === undefined
        ? { path: raw, type }
        : { path: raw, type, options };
    return { ...config, source };
  }
  const source = { path: raw, type };

  // No config to inherit rules from — synthesise one with every built-in
  // rule enabled, so `aact check architecture.dsl` lints with the full
  // pattern set out of the box (`model` / `analyze` ignore `rules`).
  const rules = Object.fromEntries(ruleRegistry.map((r) => [r.name, true]));
  return { source, rules } satisfies AactConfig;
};
