import {
  HumanReporter,
  renderErrorEnvelope,
} from "../../../src/cli/output/humanReporter";
import type { CliEnvelope, Renderer } from "../../../src/cli/output/types";
import { stripAnsi } from "../../helpers/stripAnsi";

const makeEnvelope = (overrides: Partial<CliEnvelope> = {}): CliEnvelope => ({
  schemaVersion: 1,
  command: "analyze",
  ok: true,
  exitCode: 0,
  data: { hello: "world" },
  diagnostics: [],
  meta: {
    aactVersion: "test",
    durationMs: 1,
    configPath: null,
    source: null,
  },
  ...overrides,
});

interface CapturedStream {
  readonly stream: NodeJS.WritableStream;
  output(): string;
}

const captureStream = (target: NodeJS.WritableStream): CapturedStream => {
  const chunks: Buffer[] = [];
  const original = target.write.bind(target);
  target.write = (chunk: string | Uint8Array) => {
    chunks.push(Buffer.from(chunk));
    return true;
  };
  return {
    stream: target,
    output: () => {
      target.write = original;
      return Buffer.concat(chunks).toString("utf8");
    },
  };
};

describe("HumanReporter", () => {
  it("dispatches success envelopes to the command renderer on stdout", () => {
    const renderer: Renderer<{ hello: string }> = (env, sink) => {
      sink.write(`hello=${env.data.hello}\n`);
    };
    const captured = captureStream(process.stdout);

    new HumanReporter(renderer).emit({
      envelope: makeEnvelope() as CliEnvelope<{ hello: string }>,
    });

    expect(captured.output()).toContain("hello=world");
  });

  it("routes envelope to stderr when stdoutClaimed is true", () => {
    const renderer: Renderer<{ hello: string }> = (_env, sink) => {
      sink.write("rendered\n");
    };
    const captureOut = captureStream(process.stdout);
    const captureErr = captureStream(process.stderr);

    new HumanReporter(renderer).emit({
      envelope: makeEnvelope() as CliEnvelope<{ hello: string }>,
      stdoutClaimed: true,
    });

    expect(captureOut.output()).toBe("");
    expect(captureErr.output()).toContain("rendered");
  });

  it("uses error renderer for exitCode 2 envelopes", () => {
    const renderer: Renderer<unknown> = vi.fn();
    const captureErr = captureStream(process.stderr);

    new HumanReporter(renderer).emit({
      envelope: makeEnvelope({
        ok: false,
        exitCode: 2,
        data: null,
        diagnostics: [
          {
            kind: "config.loadFailed",
            message: "Failed to load",
            severity: "warning",
          },
        ],
      }),
      stdoutClaimed: true,
    });

    // Command renderer should not be invoked for tool errors.
    expect(renderer).not.toHaveBeenCalled();
    const errText = captureErr.output();
    expect(errText).toContain("analyze");
    expect(errText).toContain("Failed to load");
  });

  it("renderErrorEnvelope writes generic failure line when no diagnostics present", () => {
    const chunks: string[] = [];
    const sink: NodeJS.WritableStream = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream;

    renderErrorEnvelope(
      makeEnvelope({ exitCode: 2, ok: false, diagnostics: [] }),
      sink,
    );

    expect(stripAnsi(chunks.join(""))).toMatch(/analyze failed/);
  });

  it("writes diagnostics summary to stderr alongside the primary render", () => {
    const renderer: Renderer<{ ok: boolean }> = (_env, sink) => {
      sink.write("primary\n");
    };
    const captureOut = captureStream(process.stdout);
    const captureErr = captureStream(process.stderr);

    new HumanReporter(renderer).emit({
      envelope: makeEnvelope({
        diagnostics: [
          {
            kind: "model.selfRelation",
            message: "container has self relation",
            severity: "warning",
          },
        ],
      }) as CliEnvelope<{ ok: boolean }>,
    });

    expect(captureOut.output()).toContain("primary");
    expect(captureErr.output()).toContain("model.selfRelation");
    expect(captureErr.output()).toContain("container has self relation");
  });
});
