// BYO_STUB: final owner N15, which replaces this with the static scan of dist/
// for provider imports (PRD check #3). Until then it always fails: it must
// never pass or skip without that scan.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

it("the built root imports no provider SDK", () => {
  expect(
    existsSync(dist),
    "dist missing: run `pnpm build` before `pnpm test:dist`",
  ).toBe(true);
  throw new Error("stub not yet replaced by N15");
});
