import { flushOutput } from "../../../src/cli/output/flush";

/**
 * The barrier that keeps `aact <cmd> --json | consumer` from losing its
 * tail: `process.exit` discards whatever stdout still has buffered, so
 * the exit path waits for the buffer to reach the OS first.
 */

interface FakeStream {
  writableLength?: number;
  write: ReturnType<typeof vi.fn>;
}

const fakeStream = (writableLength?: number): FakeStream => ({
  ...(writableLength === undefined ? {} : { writableLength }),
  write: vi.fn((_chunk: string, cb?: () => void) => {
    cb?.();
    return true;
  }),
});

const useStreams = (stdout: unknown, stderr?: unknown): void => {
  vi.spyOn(process, "stdout", "get").mockReturnValue(
    stdout as NodeJS.WriteStream & { fd: 1 },
  );
  vi.spyOn(process, "stderr", "get").mockReturnValue(
    stderr as NodeJS.WriteStream & { fd: 2 },
  );
};

describe("flushOutput", () => {
  it("skips the barrier write when nothing is buffered", async () => {
    const stdout = fakeStream(0);
    const stderr = fakeStream(0);
    useStreams(stdout, stderr);

    await flushOutput();

    expect(stdout.write).not.toHaveBeenCalled();
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it("waits for the buffered tail of both streams", async () => {
    const stdout = fakeStream(70_000);
    const stderr = fakeStream(12);
    useStreams(stdout, stderr);

    await flushOutput();

    expect(stdout.write).toHaveBeenCalledWith("", expect.any(Function));
    expect(stderr.write).toHaveBeenCalledWith("", expect.any(Function));
  });

  it("resolves only after the write callback fires", async () => {
    let release: (() => void) | undefined;
    const stdout: FakeStream = {
      writableLength: 70_000,
      write: vi.fn((_chunk: string, cb: () => void) => {
        release = cb;
        return false;
      }),
    };
    useStreams(stdout, fakeStream(0));

    let settled = false;
    const pending = flushOutput().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    release?.();
    await pending;
    expect(settled).toBe(true);
  });

  it("tolerates streams that aren't real Writables", async () => {
    // Tests (and odd hosts) substitute plain objects for the standard
    // streams; a missing `write` / `writableLength` must not hang the
    // exit path.
    useStreams({});

    await expect(flushOutput()).resolves.toBeUndefined();
  });
});
