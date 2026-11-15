import type { CST, Node, Pair, Scalar } from "yaml";
import { isMap, isPair, isScalar } from "yaml";

import type { SourceLocation, SourcePosition } from "../../model";

/**
 * YAML CST range (`[startOffset, valueEndOffset, nodeEndOffset]` per
 * yaml@2 docs) → aact `SourceLocation`. Преобразование offset → line/col
 * сканированием source строки до offset'а — O(n) на caller, но caller
 * вызывает редко (на каждое создание Element / Relation).
 *
 * Использование `yaml` package CST API — каждый node имеет `range`
 * после `parseDocument(source, { keepSourceTokens: true })`.
 */

export interface OffsetTable {
  readonly source: string;
  /** Файл (абсолют или relative как передан loader'у). */
  readonly file: string;
}

const NEWLINE_CODE = "\n".codePointAt(0);

const offsetToPosition = (source: string, offset: number): SourcePosition => {
  if (offset <= 0) return { line: 1, col: 1, offset: 0 };
  const clipped = Math.min(offset, source.length);
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clipped; i++) {
    if (source.codePointAt(i) === NEWLINE_CODE) {
      line++;
      lineStart = i + 1;
    }
  }
  return Object.freeze({
    line,
    col: clipped - lineStart + 1,
    offset: clipped,
  });
};

export const rangeToLocation = (
  table: OffsetTable,
  range:
    | CST.SourceToken["offset"]
    | readonly [number, number, number?]
    | undefined,
): SourceLocation | undefined => {
  if (range === undefined) return undefined;
  // yaml CST stores triple [start, valueEnd, nodeEnd]; AST node.range
  // also triple. Accept either Array-of-3 or a single offset number
  // (CST token form), which we treat as zero-length range.
  if (typeof range === "number") {
    const pos = offsetToPosition(table.source, range);
    return Object.freeze({ file: table.file, start: pos, end: pos });
  }
  const [start, , end] = range;
  const endOffset = end ?? start;
  return Object.freeze({
    file: table.file,
    start: offsetToPosition(table.source, start),
    end: offsetToPosition(table.source, endOffset),
  });
};

/**
 * Извлекает `SourceLocation` для конкретного ключа в map-node — то
 * есть для записи `services.X:` в compose-файле точно ту строку где
 * объявлен service `X`. Используется на каждом mapping элементе.
 */
export const keyLocation = (
  table: OffsetTable,
  pair: Pair<unknown, unknown> | undefined,
): SourceLocation | undefined => {
  if (!pair || !isPair(pair)) return undefined;
  const keyNode = pair.key;
  if (isScalar(keyNode) && Array.isArray(keyNode.range)) {
    return rangeToLocation(table, keyNode.range);
  }
  return undefined;
};

/**
 * Найти `Pair` в `Map` по строковому ключу. Возвращает `undefined` если
 * ключа нет — caller сам решает что делать (часто просто `undefined`
 * sourceLocation для derived Element).
 */
export const findKeyPair = (
  mapNode: Node | undefined,
  key: string,
): Pair<unknown, unknown> | undefined => {
  if (!mapNode || !isMap(mapNode)) return undefined;
  for (const item of mapNode.items) {
    const k = item.key as Scalar | null | undefined;
    if (k && isScalar(k) && k.value === key) return item;
  }
  return undefined;
};

/**
 * Получить локацию scalar value по ключу map-node. Использовуется для
 * relation entries (`depends_on: db` → location of `db` token).
 */
export const valueLocationFor = (
  table: OffsetTable,
  mapNode: Node | undefined,
  key: string,
): SourceLocation | undefined => {
  const pair = findKeyPair(mapNode, key);
  if (!pair) return undefined;
  const valueNode = pair.value;
  if (
    valueNode &&
    typeof valueNode === "object" &&
    "range" in valueNode &&
    Array.isArray(valueNode.range)
  ) {
    return rangeToLocation(
      table,
      (valueNode as { range: readonly [number, number, number?] }).range,
    );
  }
  return undefined;
};

export { type Document } from "yaml";
