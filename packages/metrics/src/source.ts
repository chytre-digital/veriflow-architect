/**
 * One reading of a source file, shared by every metric that follows.
 *
 * Nothing here parses the language. A metric that mirrors a tool people already run has to be
 * reproducible from the text, on any machine, without a toolchain — so the measurements are made on
 * lines and tokens, and each one names the tool it mirrors and the rule it used. Where that reading
 * is known to misread a construct, the metric carries a caveat rather than a quiet correction.
 */

/** Spaces per logical indent level. Recorded in the rule string, because the numbers depend on it. */
export const INDENT_UNIT = 2;

export interface CodeLine {
  /** 1-based, so it can be printed next to an editor. */
  n: number;
  raw: string;
  /** Comments removed and string bodies blanked, so a keyword inside a message is not a decision. */
  code: string;
  /** Logical indent level of the raw line. */
  indent: number;
  blank: boolean;
  /** Had content, but all of it was comment. */
  comment: boolean;
}

export function analyze(text: string): CodeLine[] {
  const raws = text.split(/\r?\n/);
  const codes = stripNonCode(raws, false);
  return raws.map((raw, i) => {
    const code = codes[i] ?? "";
    const blank = raw.trim().length === 0;
    return {
      n: i + 1,
      raw,
      code,
      indent: indentOf(raw),
      blank,
      comment: !blank && code.trim().length === 0,
    };
  });
}

/**
 * Comments out, string contents blanked to a bare `""`.
 *
 * Both matter: `// if the gateway refuses` is not a branch, and neither is the word `case` inside an
 * error message. A template literal is treated as a string all the way through, so a decision made
 * inside `${…}` is not counted — an undercount that is visible here rather than surprising later.
 */
/**
 * Comments out, strings left alone. An import specifier *is* a string, so the one reader that has to
 * see string contents gets this rather than a second scanner that would drift out of step with the
 * first.
 */
export function stripComments(text: string): string {
  return stripNonCode(text.split(/\r?\n/), true).join("\n");
}

function stripNonCode(lines: readonly string[], keepStrings: boolean): string[] {
  const out: string[] = [];
  let inBlock = false;
  let inString: '"' | "'" | "`" | undefined;

  for (const line of lines) {
    let code = "";
    let i = 0;
    while (i < line.length) {
      const ch = line[i]!;
      const next = line[i + 1];

      if (inBlock) {
        if (ch === "*" && next === "/") {
          inBlock = false;
          i += 2;
        } else i += 1;
        continue;
      }

      if (inString) {
        if (ch === "\\") {
          if (keepStrings) code += line.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === inString) {
          code += keepStrings ? ch : '"';
          inString = undefined;
        } else if (keepStrings) {
          code += ch;
        }
        i += 1;
        continue;
      }

      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        inBlock = true;
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        code += keepStrings ? ch : '"';
        i += 1;
        continue;
      }
      code += ch;
      i += 1;
    }
    // A quote left open at the end of a line was a quote inside something this reader does not
    // model. Only a template literal legitimately spans lines.
    if (inString && inString !== "`") inString = undefined;
    out.push(code);
  }
  return out;
}

function indentOf(raw: string): number {
  let spaces = 0;
  for (const ch of raw) {
    if (ch === " ") spaces += 1;
    else if (ch === "\t") spaces += INDENT_UNIT;
    else break;
  }
  return Math.floor(spaces / INDENT_UNIT);
}

/** Lines that carry code. The denominator of every per-line figure below. */
export function codeLines(lines: readonly CodeLine[]): CodeLine[] {
  return lines.filter((l) => !l.blank && !l.comment);
}

export function identifiersIn(code: string): string[] {
  return code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
}

/** Rough token count, in the sense jscpd means it: identifiers, numbers, and punctuation. */
export function tokenCount(code: string): number {
  return (code.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[^\s\w]/g) ?? []).length;
}

/** For duplication and coverage: same code, no incidental whitespace. */
export function normalize(code: string): string {
  return code.trim().replace(/\s+/g, " ");
}
