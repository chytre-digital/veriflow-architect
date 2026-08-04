/**
 * F019's first runtime-coverage adapter.
 *
 * This is deliberately a small, bounded Cobertura reader rather than a general XML facility. It
 * accepts the elements Cobertura uses for sources, classes and lines, validates the XML nesting,
 * and rejects entities instead of expanding input controlled by a coverage producer. The canonical
 * Cobertura 0.4 DOCTYPE emitted by common reporters is ignored as inert metadata; no DTD is loaded.
 */

export const MAX_COBERTURA_BYTES = 10 * 1024 * 1024;
const MAX_XML_ELEMENTS = 500_000;
const STANDARD_COBERTURA_DOCTYPE =
  /<!DOCTYPE\s+coverage\s+SYSTEM\s+(["'])http:\/\/cobertura\.sourceforge\.net\/xml\/coverage-04\.dtd\1\s*>/gi;

export interface CoberturaLine {
  line: number;
  hits: number;
  branches?: { covered: number; total: number };
}

export interface CoberturaFile {
  path: string;
  lines: CoberturaLine[];
}

export interface CoberturaArtifact {
  format: "cobertura-xml";
  sourceRoots: string[];
  files: CoberturaFile[];
}

export class CoberturaError extends Error {
  readonly code: "artifact.too_large" | "artifact.unsafe_xml" | "artifact.malformed";

  constructor(code: CoberturaError["code"], message: string) {
    super(message);
    this.name = "CoberturaError";
    this.code = code;
  }
}

interface OpenElement {
  name: string;
  classPath?: string;
  line?: CoberturaLine;
  /** True when line-level condition-coverage already supplied the aggregate. */
  branchAggregate?: boolean;
  source?: string;
}

/** Parse one already-bounded byte buffer without touching the filesystem. */
export function parseCoberturaXml(bytes: Uint8Array): CoberturaArtifact {
  if (bytes.byteLength > MAX_COBERTURA_BYTES) {
    throw new CoberturaError(
      "artifact.too_large",
      `Cobertura artifact is ${bytes.byteLength} bytes; the limit is ${MAX_COBERTURA_BYTES}`,
    );
  }

  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new CoberturaError("artifact.malformed", "Cobertura artifact is not valid UTF-8");
  }
  const doctypes = [...xml.matchAll(STANDARD_COBERTURA_DOCTYPE)];
  if (doctypes.length > 1) {
    throw new CoberturaError("artifact.malformed", "Cobertura artifact contains more than one DOCTYPE");
  }
  const coverageRoot = xml.search(/<coverage(?:\s|>)/i);
  if (doctypes[0]?.index !== undefined && (coverageRoot < 0 || doctypes[0].index > coverageRoot)) {
    throw new CoberturaError("artifact.malformed", "Cobertura DOCTYPE must appear before the root element");
  }
  // Preserve offsets while making the declaration invisible to the deliberately small parser.
  // The URI is never opened and a declaration with an internal subset cannot match this pattern.
  xml = xml.replace(STANDARD_COBERTURA_DOCTYPE, (doctype) => " ".repeat(doctype.length));
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) {
    throw new CoberturaError(
      "artifact.unsafe_xml",
      "Cobertura artifact contains an unsupported DTD or entity declaration; expansion is forbidden",
    );
  }

  const sources: string[] = [];
  const byFile = new Map<string, Map<number, CoberturaLine>>();
  const stack: OpenElement[] = [];
  let cursor = 0;
  let elements = 0;
  let roots = 0;
  let declarations = 0;
  let sawCoverage = false;

  const activeClass = (): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i]!.classPath) return stack[i]!.classPath;
    }
    return undefined;
  };
  const activeLineElement = (): OpenElement | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i]!.line) return stack[i];
    }
    return undefined;
  };
  const appendText = (raw: string): void => {
    if (!raw) return;
    if (stack.length === 0 && raw.trim()) malformed("text appears outside the root element");
    const source = [...stack].reverse().find((entry) => entry.source !== undefined);
    if (source) source.source = (source.source ?? "") + decodeXml(raw);
  };
  const finish = (entry: OpenElement): void => {
    if (entry.source !== undefined) {
      const source = entry.source.trim();
      if (source && !sources.includes(source)) sources.push(source);
    }
    if (!entry.line) return;
    // V8 source-map remapping can legitimately attach covered branch conditions to a generated
    // line whose line hit counter is zero. Keep both facts: the mapper still classifies the exact
    // line as uncovered because hits=0, without discarding the reporter's branch evidence.
    const path = entry.classPath ?? activeClass();
    if (!path) malformed("a <line> appears outside a class with a filename");
    const lines = byFile.get(path) ?? new Map<number, CoberturaLine>();
    const previous = lines.get(entry.line.line);
    if (!previous) {
      lines.set(entry.line.line, entry.line);
    } else {
      previous.hits = Math.max(previous.hits, entry.line.hits);
      if (entry.line.branches) {
        previous.branches = previous.branches
          ? {
              covered: Math.max(previous.branches.covered, entry.line.branches.covered),
              total: Math.max(previous.branches.total, entry.line.branches.total),
            }
          : entry.line.branches;
      }
    }
    byFile.set(path, lines);
  };

  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    if (open < 0) {
      appendText(xml.slice(cursor));
      cursor = xml.length;
      break;
    }
    appendText(xml.slice(cursor, open));

    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0) malformed("unterminated XML comment");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      if (end < 0) malformed("unterminated CDATA section");
      appendText(xml.slice(open + 9, end));
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      if (end < 0) malformed("unterminated processing instruction");
      const instruction = xml.slice(open + 2, end).trim();
      if (!/^xml(?:\s|$)/i.test(instruction)) {
        throw new CoberturaError("artifact.unsafe_xml", "only the XML declaration is allowed");
      }
      declarations += 1;
      if (declarations > 1 || roots > 0 || stack.length > 0) malformed("XML declaration is not at the start");
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", open)) {
      throw new CoberturaError("artifact.unsafe_xml", "XML declarations other than CDATA are forbidden");
    }

    const end = tagEnd(xml, open + 1);
    if (end < 0) malformed("unterminated XML tag");
    let body = xml.slice(open + 1, end).trim();
    cursor = end + 1;
    if (!body) malformed("empty XML tag");

    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      if (!/^[A-Za-z_][\w:.-]*$/.test(name)) malformed(`invalid closing tag </${name}>`);
      const entry = stack.pop();
      if (!entry || entry.name !== name) {
        malformed(`closing tag </${name}> does not match <${entry?.name ?? "none"}>`);
      }
      finish(entry);
      continue;
    }

    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1).trimEnd();
    const match = /^([A-Za-z_][\w:.-]*)([\s\S]*)$/.exec(body);
    if (!match) malformed(`invalid XML tag <${body}>`);
    const name = match[1]!;
    const attributes = parseAttributes(match[2] ?? "");
    elements += 1;
    if (elements > MAX_XML_ELEMENTS) malformed(`more than ${MAX_XML_ELEMENTS} XML elements`);
    if (stack.length === 0) {
      roots += 1;
      if (roots > 1) malformed("more than one root element");
      if (name !== "coverage") malformed(`root element is <${name}>, expected <coverage>`);
    }
    if (name === "coverage") sawCoverage = true;

    const entry: OpenElement = { name };
    if (name === "class") {
      const filename = attributes.get("filename")?.trim();
      if (!filename) malformed("a Cobertura <class> is missing its filename");
      entry.classPath = filename;
    } else if (name === "source") {
      entry.source = "";
    } else if (name === "line") {
      const classPath = activeClass();
      if (!classPath) malformed("a <line> appears outside a class with a filename");
      const line = positiveInteger(attributes.get("number"), "line number");
      const hits = nonNegativeInteger(attributes.get("hits"), "line hits");
      const branches = branchCounts(attributes.get("condition-coverage"));
      entry.classPath = classPath;
      entry.line = { line, hits, ...(branches ? { branches } : {}) };
      entry.branchAggregate = Boolean(branches);
    } else if (name === "condition") {
      const lineElement = activeLineElement();
      const line = lineElement?.line;
      if (line && !lineElement?.branchAggregate) {
        const coverage = String(attributes.get("coverage") ?? "").trim();
        const percent = /^(\d+(?:\.\d+)?)%?$/.exec(coverage);
        if (!percent) malformed(`invalid condition coverage "${coverage}"`);
        const covered = Number(percent[1]) > 0 ? 1 : 0;
        line.branches = {
          covered: (line.branches?.covered ?? 0) + covered,
          total: (line.branches?.total ?? 0) + 1,
        };
      }
    }

    if (selfClosing) finish(entry);
    else stack.push(entry);
  }

  if (stack.length > 0) malformed(`unclosed XML tag <${stack.at(-1)!.name}>`);
  if (!sawCoverage || roots !== 1) malformed("root <coverage> element is missing");

  return {
    format: "cobertura-xml",
    sourceRoots: sources.sort(),
    files: [...byFile.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, lines]) => ({
        path,
        lines: [...lines.values()].sort((a, b) => a.line - b.line),
      })),
  };
}

function tagEnd(xml: string, from: number): number {
  let quote: "\"" | "'" | undefined;
  for (let i = from; i < xml.length; i += 1) {
    const char = xml[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let rest = raw;
  while (rest.trim()) {
    const match = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')([\s\S]*)$/.exec(rest);
    if (!match) malformed(`invalid XML attributes near "${rest.trim().slice(0, 40)}"`);
    const name = match[1]!;
    if (attributes.has(name)) malformed(`duplicate XML attribute "${name}"`);
    attributes.set(name, decodeXml(match[3] ?? match[4] ?? ""));
    rest = match[5] ?? "";
  }
  return attributes;
}

function decodeXml(raw: string): string {
  return raw.replace(/&([^;]+);/g, (_whole, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return "\"";
    if (entity === "apos") return "'";
    const decimal = /^#(\d+)$/.exec(entity);
    const hex = /^#x([0-9a-f]+)$/i.exec(entity);
    const point = decimal ? Number(decimal[1]) : hex ? Number.parseInt(hex[1]!, 16) : Number.NaN;
    if (!Number.isInteger(point) || point < 0 || point > 0x10ffff) {
      throw new CoberturaError("artifact.unsafe_xml", `unsupported XML entity &${entity};`);
    }
    return String.fromCodePoint(point);
  });
}

function positiveInteger(raw: string | undefined, label: string): number {
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value <= 0) malformed(`invalid ${label} "${raw ?? ""}"`);
  return value;
}

function nonNegativeInteger(raw: string | undefined, label: string): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 0) malformed(`invalid ${label} "${raw ?? ""}"`);
  return value;
}

function branchCounts(raw: string | undefined): { covered: number; total: number } | undefined {
  if (!raw) return undefined;
  const match = /\((\d+)\s*\/\s*(\d+)\)/.exec(raw);
  if (!match) malformed(`invalid condition-coverage "${raw}"`);
  const covered = Number(match[1]);
  const total = Number(match[2]);
  if (covered > total) malformed(`covered branch count ${covered} exceeds total ${total}`);
  return { covered, total };
}

function malformed(message: string): never {
  throw new CoberturaError("artifact.malformed", `Malformed Cobertura XML: ${message}`);
}
