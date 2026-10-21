// PRD acceptance #3 (and the `exports` map): a static scan of the built
// package. Run with `pnpm test:dist` after `pnpm build`. A missing `dist/`
// fails, it never skips.
//
// The scan parses the built files with TypeScript's parser instead of
// matching text, so a provider name in a comment, a string or an error message
// is not an import, and `import { x } from "y"` spread over lines is one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");

/** Packages the root, client and React entries must never load at import time. */
const FORBIDDEN = [
  "@wraps.dev/email",
  "@aws-sdk/*",
  "mailauth",
  "postal-mime",
] as const;

const isForbidden = (specifier: string) =>
  FORBIDDEN.some((pattern) =>
    pattern.endsWith("/*")
      ? specifier.startsWith(pattern.slice(0, -1))
      : specifier === pattern || specifier.startsWith(`${pattern}/`),
  );

/** `mailauth/lib/x` and `mailauth` are the same package. */
const packageOf = (specifier: string) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

type Reference = {
  file: string;
  specifier: string;
  /** `static`: `import`/`export ... from`/`require`. `dynamic`: `import()`. */
  kind: "static" | "dynamic";
};

/** Every module reference in one file's source. */
function referencesIn(file: string, source: string): Reference[] {
  const found: Reference[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const literal = (node: ts.Node | undefined) =>
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier !== undefined) {
        found.push({ file, specifier, kind: "static" });
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = literal(node.moduleReference.expression);
      if (specifier !== undefined) {
        found.push({ file, specifier, kind: "static" });
      }
    } else if (ts.isCallExpression(node)) {
      const first = literal(node.arguments[0]);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        // import(someVariable) can't be resolved here: record it so a test sees it
        found.push({
          file,
          specifier: first ?? "<computed>",
          kind: "dynamic",
        });
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        first !== undefined
      ) {
        found.push({ file, specifier: first, kind: "static" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const isLocal = (specifier: string) => specifier.startsWith(".");

function assertDist() {
  expect(
    existsSync(dist),
    "dist missing: run `pnpm build` before `pnpm test:dist`",
  ).toBe(true);
}

/** The built scripts directly in `dir` (relative to dist) whose name matches. */
function scripts(dir: string, name: RegExp): string[] {
  assertDist();
  const full = join(dist, dir);
  expect(existsSync(full), `dist/${dir} missing`).toBe(true);
  return readdirSync(full)
    .filter((file) => /\.(?:js|cjs|mjs)$/.test(file) && name.test(file))
    .sort()
    .map((file) => join(full, file));
}

/**
 * Every reference reachable from `entry` through local files (relative
 * specifiers, static or dynamic), the entry included. Each file is read once.
 */
function reachable(entry: string): Reference[] {
  const seen = new Set<string>();
  const references: Reference[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    expect(
      existsSync(file),
      `${relative(root, file)} is imported but missing`,
    ).toBe(true);
    const source = readFileSync(file, "utf8");
    for (const ref of referencesIn(relative(root, file), source)) {
      references.push(ref);
      if (isLocal(ref.specifier)) {
        queue.push(resolve(dirname(file), ref.specifier));
      }
    }
  }
  return references;
}

const describeRef = (ref: Reference) =>
  `${ref.kind} ${JSON.stringify(ref.specifier)} in ${ref.file}`;

const staticProviders = (entry: string) =>
  reachable(entry).filter(
    (ref) => ref.kind === "static" && isForbidden(ref.specifier),
  );

const anyProviders = (entry: string) =>
  reachable(entry).filter((ref) => isForbidden(ref.specifier));

// ---------------------------------------------------------------------------
// The scanner finds what it should (so a blind scan can't pass)
// ---------------------------------------------------------------------------

describe("the scanner", () => {
  const source = `
    // import "mailauth";
    /* const x = require("postal-mime"); */
    import a from "kept-a";
    import {
      b,
      c
    } from "kept-b";
    import "kept-side-effect";
    export { d } from "kept-reexport";
    export * from "kept-star";
    const e = require("kept-require");
    const lazy = async () => (await import("kept-dynamic")).default;
    const computed = (name) => import(name);
    const message = 'import x from "in-a-string"';
    const text = \`require("in-a-template")\`;
  `;

  it("finds static imports, re-exports, requires and dynamic imports, over several lines", () => {
    const refs = referencesIn("fixture.js", source).map(
      (r) => `${r.kind}:${r.specifier}`,
    );
    expect(refs.sort()).toEqual(
      [
        "static:kept-a",
        "static:kept-b",
        "static:kept-side-effect",
        "static:kept-reexport",
        "static:kept-star",
        "static:kept-require",
        "dynamic:kept-dynamic",
        "dynamic:<computed>",
      ].sort(),
    );
  });

  it("ignores comments, strings and templates", () => {
    const refs = referencesIn("fixture.js", source).map((r) => r.specifier);
    for (const ignored of [
      "mailauth",
      "postal-mime",
      "in-a-string",
      "in-a-template",
    ]) {
      expect(refs).not.toContain(ignored);
    }
  });

  it("matches provider packages and their subpaths, not lookalikes", () => {
    for (const hit of [
      "@wraps.dev/email",
      "@wraps.dev/email/ses",
      "@aws-sdk/client-s3",
      "@aws-sdk/s3-request-presigner",
      "mailauth",
      "mailauth/lib/dkim",
      "postal-mime",
    ]) {
      expect(isForbidden(hit), hit).toBe(true);
    }
    for (const miss of [
      "@wraps.dev/sms",
      "@aws-sdk",
      "mailauthentic",
      "postal-mimes",
      "@byo-oss/mailer",
      "better-auth/api",
      "node:dns/promises",
    ]) {
      expect(isForbidden(miss), miss).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Root, client, React: no provider SDK at import time
// ---------------------------------------------------------------------------

describe("dist", () => {
  it("is built", () => {
    assertDist();
    expect(readdirSync(dist).length).toBeGreaterThan(0);
  });
});

describe("the root entry", () => {
  const entries = () => scripts(".", /^index\.(?:js|cjs)$/);

  it("has an ESM and a CJS build", () => {
    expect(entries().map((file) => relative(dist, file))).toEqual([
      "index.cjs",
      "index.js",
    ]);
  });

  it("statically imports no provider SDK, MIME parser or DKIM verifier, in the entry or any local chunk it imports", () => {
    for (const entry of entries()) {
      expect(
        staticProviders(entry).map(describeRef),
        relative(root, entry),
      ).toEqual([]);
    }
  });

  it("loads postal-mime and mailauth only inside dynamic import(), and never the other providers", () => {
    for (const entry of entries()) {
      const providers = anyProviders(entry);
      expect(
        providers.filter((ref) => ref.kind !== "dynamic").map(describeRef),
        relative(root, entry),
      ).toEqual([]);
      // the inbound parser and verifier really are lazy, not just absent
      expect(
        new Set(providers.map((ref) => packageOf(ref.specifier))),
        relative(root, entry),
      ).toEqual(new Set(["postal-mime", "mailauth"]));
    }
  });

  it("never reaches the optional or test-only entries", () => {
    for (const entry of entries()) {
      const locals = reachable(entry)
        .filter((ref) => isLocal(ref.specifier))
        .map((ref) => ref.specifier);
      for (const name of ["wraps", "s3", "testing", "test-utils", "test-sql"]) {
        expect(
          locals.filter((s) => new RegExp(`/${name}(?:[.-]|$)`).test(s)),
          `${relative(root, entry)} reaches ${name}`,
        ).toEqual([]);
      }
    }
  });
});

describe("the client entry", () => {
  it("references no provider SDK at all", () => {
    const entries = scripts(".", /^client\.(?:js|cjs)$/);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        anyProviders(entry).map(describeRef),
        relative(root, entry),
      ).toEqual([]);
    }
  });
});

describe("the React entry", () => {
  it("references no provider SDK at all", () => {
    const entries = scripts("react", /\.(?:js|cjs)$/);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        anyProviders(entry).map(describeRef),
        relative(root, entry),
      ).toEqual([]);
    }
  });

  it('starts dist/react/index.js and index.cjs with the "use client" banner', () => {
    assertDist();
    for (const name of ["index.js", "index.cjs"]) {
      const file = join(dist, "react", name);
      expect(existsSync(file), `dist/react/${name} missing`).toBe(true);
      expect(readFileSync(file, "utf8").trimStart(), name).toMatch(
        /^(["'])use client\1;?/,
      );
    }
  });
});

describe("the optional entries", () => {
  it("wraps and s3 import providers only dynamically", () => {
    const entries = scripts(".", /^(?:wraps|s3)\.(?:js|cjs)$/);
    expect(entries.length).toBe(4);
    for (const entry of entries) {
      expect(
        staticProviders(entry).map(describeRef),
        relative(root, entry),
      ).toEqual([]);
    }
  });

  it("testing imports no provider statically", () => {
    const entries = scripts(".", /^testing\.(?:js|cjs)$/);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        staticProviders(entry).map(describeRef),
        relative(root, entry),
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// package.json `exports`
// ---------------------------------------------------------------------------

describe("package.json", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    main?: string;
    module?: string;
    types?: string;
    exports: Record<string, string | Record<string, string>>;
  };

  const paths = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : value && typeof value === "object"
        ? Object.values(value).flatMap(paths)
        : [];

  it("lists every entry point", () => {
    expect(Object.keys(pkg.exports)).toEqual([
      ".",
      "./client",
      "./react",
      "./wraps",
      "./s3",
      "./testing",
    ]);
  });

  it("has every path in `exports` (and main, module, types) in dist/", () => {
    assertDist();
    const wanted = [
      ...paths(pkg.exports),
      ...[pkg.main, pkg.module, pkg.types].filter(
        (p): p is string => typeof p === "string",
      ),
    ];
    expect(wanted.length).toBeGreaterThan(0);
    for (const p of wanted) expect(p.startsWith("./dist/"), p).toBe(true);
    const missing = [...new Set(wanted)].filter(
      (p) => !existsSync(resolve(root, p)),
    );
    expect(missing).toEqual([]);
  });
});
