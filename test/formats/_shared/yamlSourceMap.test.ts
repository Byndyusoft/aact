import { isMap, parseDocument } from "yaml";

import {
  findKeyPair,
  keyLocation,
  rangeToLocation,
  valueLocationFor,
} from "../../../src/formats/_shared/yamlSourceMap";

const sample = `services:
  api:
    image: node:20
  db:
    image: postgres:13
`;

const table = (): { source: string; file: string } =>
  Object.freeze({ source: sample, file: "compose.yml" });

const parseSample = () => parseDocument(sample, { keepSourceTokens: true });

describe("rangeToLocation", () => {
  it("undefined range → undefined", () => {
    // Required nullable param — explicit undefined hits early-return branch.
    // eslint-disable-next-line unicorn/no-useless-undefined
    expect(rangeToLocation(table(), undefined)).toBeUndefined();
  });

  it("converts offset-triple [start, valueEnd, nodeEnd] → SourceLocation", () => {
    const loc = rangeToLocation(table(), [0, 0, 8]);
    expect(loc).toBeDefined();
    expect(loc?.file).toBe("compose.yml");
    expect(loc?.start.line).toBe(1);
    expect(loc?.start.col).toBe(1);
    expect(loc?.start.offset).toBe(0);
    expect(loc?.end.offset).toBe(8);
  });

  it("converts numeric offset → zero-length range at offset", () => {
    // `services:\n` is 10 chars. Offset 12 = line 2, col 3 → `a` of `api:`.
    const loc = rangeToLocation(table(), 12);
    expect(loc?.start.offset).toBe(loc?.end.offset);
    expect(loc?.start.line).toBe(2);
    expect(loc?.start.col).toBe(3);
  });

  it("offset 0 maps to line 1, col 1", () => {
    const loc = rangeToLocation(table(), [0, 0, 0]);
    expect(loc?.start).toEqual({ line: 1, col: 1, offset: 0 });
  });

  it("negative offset clamps to zero (start of file)", () => {
    const loc = rangeToLocation(table(), -5);
    expect(loc?.start.offset).toBe(0);
    expect(loc?.start.line).toBe(1);
    expect(loc?.start.col).toBe(1);
  });

  it("offset past end of source clamps to source length", () => {
    const loc = rangeToLocation(table(), [0, 0, sample.length + 100]);
    expect(loc?.end.offset).toBe(sample.length);
  });

  it("end defaults to start when triple has only [start, valueEnd]", () => {
    const loc = rangeToLocation(table(), [3, 5] as unknown as [
      number,
      number,
      number,
    ]);
    expect(loc?.end.offset).toBe(loc?.start.offset);
    expect(loc?.start.offset).toBe(3);
  });
});

describe("findKeyPair", () => {
  it("returns pair when key exists in mapping", () => {
    const doc = parseSample();
    expect(doc.contents).toBeDefined();
    if (!doc.contents || !isMap(doc.contents)) throw new Error("expected map");
    const pair = findKeyPair(doc.contents, "services");
    expect(pair).toBeDefined();
  });

  it("returns undefined when key not found", () => {
    const doc = parseSample();
    expect(findKeyPair(doc.contents ?? undefined, "missing")).toBeUndefined();
  });

  it("returns undefined when node is not a map", () => {
    const doc = parseDocument("just a scalar", { keepSourceTokens: true });
    expect(findKeyPair(doc.contents ?? undefined, "x")).toBeUndefined();
  });

  it("returns undefined when node is undefined", () => {
    expect(findKeyPair(undefined, "x")).toBeUndefined();
  });
});

describe("keyLocation", () => {
  it("returns location of the key token", () => {
    const doc = parseSample();
    const servicesPair = findKeyPair(doc.contents ?? undefined, "services");
    const loc = keyLocation(table(), servicesPair);
    expect(loc?.file).toBe("compose.yml");
    expect(loc?.start.line).toBe(1);
    expect(loc?.start.col).toBe(1);
  });

  it("returns undefined when pair is undefined", () => {
    // Required nullable param — explicit undefined hits early-return branch.
    // eslint-disable-next-line unicorn/no-useless-undefined
    expect(keyLocation(table(), undefined)).toBeUndefined();
  });

  it("nested key location maps to correct line", () => {
    const doc = parseSample();
    const servicesPair = findKeyPair(doc.contents ?? undefined, "services");
    const apiPair = findKeyPair(servicesPair?.value as never, "api");
    const loc = keyLocation(table(), apiPair);
    expect(loc?.start.line).toBe(2);
  });
});

describe("valueLocationFor", () => {
  it("returns location of value scalar", () => {
    const doc = parseSample();
    const servicesPair = findKeyPair(doc.contents ?? undefined, "services");
    const apiPair = findKeyPair(servicesPair?.value as never, "api");
    const loc = valueLocationFor(table(), apiPair?.value as never, "image");
    expect(loc?.start.line).toBe(3);
    // `image:` value `node:20` starts after `    image: ` (4 spaces + 'image: ').
    expect(loc?.start.col).toBeGreaterThan(1);
  });

  it("returns undefined when key not found in map", () => {
    const doc = parseSample();
    const loc = valueLocationFor(table(), doc.contents ?? undefined, "missing");
    expect(loc).toBeUndefined();
  });

  it("returns undefined when map node is undefined", () => {
    expect(valueLocationFor(table(), undefined, "x")).toBeUndefined();
  });
});
