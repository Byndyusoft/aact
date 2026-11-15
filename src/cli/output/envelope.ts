import { version as aactVersion } from "../../../package.json";
import { ToolError } from "./toolError";
import type { CliEnvelope, Diagnostic, EnvelopeMeta, ExitCode } from "./types";

export interface BuildEnvelopeInput<TData> {
  readonly command: string;
  readonly exitCode: ExitCode;
  readonly data: TData;
  readonly diagnostics?: readonly Diagnostic[];
  readonly meta: Omit<EnvelopeMeta, "aactVersion">;
}

export const buildEnvelope = <TData>(
  input: BuildEnvelopeInput<TData>,
): CliEnvelope<TData> => ({
  schemaVersion: 1,
  command: input.command,
  ok: input.exitCode === 0,
  exitCode: input.exitCode,
  data: input.data,
  diagnostics: input.diagnostics ?? [],
  meta: {
    aactVersion,
    durationMs: input.meta.durationMs,
    configPath: input.meta.configPath,
    source: input.meta.source,
  },
});

export interface ErrorEnvelopeInput {
  readonly command: string;
  readonly error: unknown;
  readonly startedAt: number;
  readonly configPath: string | null;
  readonly source: string | null;
}

/**
 * Build an envelope for a wrapper-level failure (config load, model load,
 * unexpected throw from execute). Exit code is 2 — agents distinguish this
 * from violation-driven exit 1.
 */
export const buildErrorEnvelope = (
  input: ErrorEnvelopeInput,
): CliEnvelope<null> => {
  const diagnostic: Diagnostic =
    input.error instanceof ToolError
      ? input.error.toDiagnostic()
      : {
          kind: "internal.unexpected",
          message:
            input.error instanceof Error
              ? input.error.message
              : String(input.error),
          // exit 2 is fatal — surface it as `error`, not `warning`.
          severity: "error",
        };

  return buildEnvelope({
    command: input.command,
    exitCode: 2,
    data: null,
    diagnostics: [diagnostic],
    meta: {
      durationMs: Date.now() - input.startedAt,
      configPath: input.configPath,
      source: input.source,
    },
  });
};
