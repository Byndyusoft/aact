import { colors } from "./colors";
import type { CommandResult, Diagnostic, Renderer, Reporter } from "./types";

/**
 * Text-mode reporter. Routes the envelope through the command-supplied
 * `Renderer` for human-friendly output. When the command has claimed stdout
 * for an artefact (`stdoutClaimed`), envelope rendering moves to stderr so
 * the artefact stream stays pipe-safe.
 */
export class HumanReporter<TData = unknown> implements Reporter<TData> {
  constructor(private readonly renderer: Renderer<TData>) {}

  emit(result: CommandResult<TData>): void {
    // Tool-level failures (exit 2) carry a null data payload that the
    // command-specific renderer wouldn't know how to handle, and the
    // shared error line follows the Unix convention of going to
    // stderr — so a piped consumer (`aact check | jq`) still sees
    // failures even when the success path was supposed to drive
    // stdout.
    //
    // renderErrorEnvelope consumes diagnostics[0] as the body of the
    // `✗ <command>: <message>` line. Re-emitting that same diagnostic
    // via renderDiagnostics produces the duplicate-message pair we
    // used to ship — drop the first entry on error envelopes so only
    // additional context lines remain. JSON / SARIF outputs are
    // untouched: the full diagnostics array is the public contract.
    if (result.envelope.exitCode === 2) {
      renderErrorEnvelope(result.envelope, process.stderr);
      const tail = result.envelope.diagnostics.slice(1);
      if (tail.length > 0) renderDiagnostics(tail, process.stderr);
      return;
    }

    const sink: NodeJS.WritableStream = result.stdoutClaimed
      ? process.stderr
      : process.stdout;
    this.renderer(result.envelope, sink);

    if (result.envelope.diagnostics.length > 0) {
      renderDiagnostics(result.envelope.diagnostics, process.stderr);
    }
  }
}

const severityIcon = (severity: Diagnostic["severity"]): string => {
  switch (severity) {
    case "error": {
      return colors.red("✖");
    }
    case "warning": {
      return colors.yellow("⚠");
    }
    default: {
      return colors.cyan("ℹ");
    }
  }
};

const renderDiagnostics = (
  diagnostics: readonly Diagnostic[],
  sink: NodeJS.WritableStream,
): void => {
  for (const d of diagnostics) {
    sink.write(
      `${severityIcon(d.severity)} ${colors.dim(d.kind)}  ${d.message}\n`,
    );
  }
};

/**
 * Shared formatter for error envelopes. Used both by the wrapper's catch
 * branch (when execute throws) and as a default for commands that produce
 * exitCode !== 0 without a custom renderer.
 */
export const renderErrorEnvelope: Renderer<unknown> = (envelope, sink) => {
  const [primary] = envelope.diagnostics;
  if (primary) {
    sink.write(
      `${colors.red("✗")} ${colors.bold(envelope.command)}: ${primary.message}\n`,
    );
  } else {
    sink.write(`${colors.red("✗")} ${colors.bold(envelope.command)} failed\n`);
  }
};
