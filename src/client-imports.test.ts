// The `./client` entry is imported by browser code and by access-control
// files shared between server and browser. A static scan of the source (the
// dist-side check is `exports.dist.test.ts`): walks every value import from
// `client.ts` and fails if it reaches the inbound mail code or a provider
// SDK. `import type` and `export type` are erased (verbatimModuleSyntax), so
// they are not edges; any other import, even of inline `type` names only, is.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL(".", import.meta.url));

/** Packages a browser-safe entry must never reach. */
const FORBIDDEN = ["mailauth", "postal-mime", "@aws-sdk/", "@wraps.dev/email"];

/** The specifiers of one file's value imports and re-exports. */
function valueSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        found.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        found.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      // dynamic import(): loaded on call, not at import time
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function resolveLocal(from: string, specifier: string): string {
  const base = join(dirname(from), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`can't resolve ${specifier} from ${relative(src, from)}`);
}

/** Every local file and package reached from `entry` through value imports. */
function graph(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [join(src, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of valueSpecifiers(file)) {
      if (specifier.startsWith(".")) queue.push(resolveLocal(file, specifier));
      else packages.add(specifier);
    }
  }
  return {
    files: [...files].map((file) => relative(src, file)).sort(),
    packages: [...packages].sort(),
  };
}

const forbidden = (specifier: string) =>
  FORBIDDEN.some((name) =>
    name.endsWith("/")
      ? specifier.startsWith(name)
      : specifier === name || specifier.startsWith(`${name}/`),
  );

describe("the client entry's source imports", () => {
  it("reach the statements and nothing of the inbound mail code or provider SDKs", () => {
    const { files, packages } = graph("client.ts");
    expect(files).toContain("statements.ts");
    expect(files.filter((file) => file.startsWith("inbound"))).toEqual([]);
    expect(files.filter((file) => file.startsWith("routes"))).toEqual([]);
    expect(files).not.toContain("index.ts");
    expect(packages.filter(forbidden)).toEqual([]);
    expect(packages.filter((name) => name.startsWith("node:"))).toEqual([]);
  });

  it("keeps statements.ts free of imports", () => {
    expect(valueSpecifiers(join(src, "statements.ts"))).toEqual([]);
  });

  it("would catch it: the root entry does reach the inbound code", () => {
    const { files } = graph("index.ts");
    expect(files).toContain("inbound/receive.ts");
    expect(files).toContain("statements.ts");
  });
});
