/**
 * How wide a string will be drawn, without a browser to ask.
 *
 * Every collision this package prevents is prevented by reserving space, and space cannot be
 * reserved for text whose width nobody measured. Character counts do not work: `iiiiiiiiii` and
 * `MWMWMWMWMW` are the same count and nearly three times apart on the page, which is how a label
 * "truncated to 24 characters" still ran off the canvas.
 */

const NARROW = `iljtfrI.,:;'"!|()[]{}/\\ `;
const WIDE = "mwMWQGO@%&#";

export interface TextOptions {
  mono?: boolean;
  bold?: boolean;
}

/**
 * Deliberately a slight over-estimate: allocators spend this number as reserved space, and reserving
 * a little too much costs a few pixels while reserving too little costs a collision.
 */
export function textWidth(text: string, fontSize: number, options: TextOptions = {}): number {
  if (options.mono) return text.length * fontSize * 0.605;
  let em = 0;
  for (const ch of text) {
    if (NARROW.includes(ch)) em += 0.33;
    else if (WIDE.includes(ch)) em += 0.88;
    else if (ch >= "A" && ch <= "Z") em += 0.7;
    else if (ch >= "0" && ch <= "9") em += 0.57;
    else em += 0.55;
  }
  return em * fontSize * (options.bold ? 1.06 : 1);
}

/** Cut to what fits the space there actually is, rather than to a character count that guesses. */
export function fitText(text: string, fontSize: number, maxWidth: number, options: TextOptions = {}): string {
  if (textWidth(text, fontSize, options) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && textWidth(`${cut}…`, fontSize, options) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * The same text over as many lines as it needs, none of them wider than the space there is.
 *
 * Wrapping before truncating is the whole point: a sentence-length step label cut at one line is
 * unreadable, and one drawn as a single long line either escapes the canvas or is clipped by it.
 * Only when the text still does not fit in `maxLines` does the last line get an ellipsis — and
 * callers keep the full string on the element's `<title>`, so nothing is ever lost outright.
 */
export function wrapText(
  text: string,
  fontSize: number,
  maxWidth: number,
  maxLines = 2,
  options: TextOptions = {},
): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === "") return [];
  const width = (value: string): number => textWidth(value, fontSize, options);
  if (width(clean) <= maxWidth) return [clean];

  // A single token wider than the line has no break to take, so give it one — an unbroken URL or
  // identifier otherwise sets the width of the whole drawing.
  const words: string[] = [];
  for (const word of clean.split(" ")) {
    let rest = word;
    while (rest !== "" && width(rest) > maxWidth) {
      let cut = rest.length;
      while (cut > 1 && width(rest.slice(0, cut)) > maxWidth) cut -= 1;
      words.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest !== "") words.push(rest);
  }

  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line === "" ? word : `${line} ${word}`;
    if (width(next) <= maxWidth) {
      line = next;
      continue;
    }
    if (line !== "") lines.push(line);
    line = word;
  }
  if (line !== "") lines.push(line);

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, Math.max(1, maxLines - 1));
  kept.push(fitText(lines.slice(kept.length).join(" "), fontSize, maxWidth, options));
  return kept;
}

/** The widest line of a wrapped block — what the caller has to reserve. */
export function blockWidth(lines: readonly string[], fontSize: number, options: TextOptions = {}): number {
  return lines.reduce((widest, line) => Math.max(widest, textWidth(line, fontSize, options)), 0);
}
