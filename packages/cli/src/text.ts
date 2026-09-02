/**
 * Layout for the two things this command prints: a labelled row, and a sentence that
 * has to wrap under its label.
 *
 * Lifted out of `report.ts` when `site-report.ts` became the second caller — the
 * engineering guide's rule is no abstraction until there is one, and there is now. The
 * two reports share the label column and the wrap width so that a person reading a
 * stored crawl and a person reading a fresh one are reading the same shape.
 */

/** Width of the label column. Every value starts at the same place. */
const LABEL = 15;
/** Prose wraps here; the terminal would wrap it without the continuation indent. */
const WIDTH = 88;

export const row = (label: string, value: string): string =>
  `${label.padEnd(LABEL)}${value}`;

/** A row whose value is a sentence: wrapped, and continuing under the value column. */
export const prosaicRow = (label: string, value: string): string =>
  indented(value, label.padEnd(LABEL), " ".repeat(LABEL));

/**
 * Wrapped to `WIDTH`, with the first line prefixed by `first` and the rest by `cont`.
 * The prefixes are applied after wrapping rather than being part of the text, because
 * padding is not a word and would be wrapped as one.
 */
export function indented(text: string, first: string, cont: string): string {
  return wrap(text, WIDTH - cont.length)
    .map((line, index) => `${index === 0 ? first : cont}${line}`)
    .join("\n");
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}
