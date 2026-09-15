/**
 * Stdout/stderr flush barrier for the CLI's exit path.
 *
 * `process.stdout` is only synchronous when it points at a TTY or a
 * file. When the CLI is piped (`aact model --json | jq`, `execa`, any
 * agent reading the envelope from a subprocess) Node writes through an
 * async libuv stream: `write()` buffers whatever the pipe couldn't take
 * (64 KB on Linux/macOS) and returns. Calling `process.exit()` right
 * after that drops the buffered tail on the floor — the consumer gets
 * the envelope truncated at exactly 65536 bytes, i.e. invalid JSON.
 *
 * The barrier: an empty `write` whose callback fires only after every
 * previously queued chunk has reached the OS (stream callbacks run in
 * write order). We skip it when nothing is buffered, which keeps the
 * TTY / file / mocked-stream paths free of extra ticks.
 */
const flushStream = (
  stream: NodeJS.WritableStream | undefined,
): Promise<void> => {
  if (stream === undefined || typeof stream.write !== "function") {
    return Promise.resolve();
  }
  const buffered = (stream as Partial<NodeJS.WriteStream>).writableLength;
  // `undefined` — not a real Writable (tests substitute plain objects).
  // `0` — everything already handed to the OS, nothing to wait for.
  if (buffered === undefined || buffered === 0) return Promise.resolve();

  return new Promise((resolve) => {
    // The callback also fires on error (EPIPE when the reader closed
    // early, e.g. `aact model --json | head -1`) — resolve either way,
    // the exit code is decided by the caller, not by the pipe.
    stream.write("", () => {
      resolve();
    });
  });
};

/**
 * Resolves once both standard streams have handed their buffered output
 * to the OS. Call before `process.exit` so piped consumers see the whole
 * envelope.
 */
export const flushOutput = async (): Promise<void> => {
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
};
