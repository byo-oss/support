import { defineConfig } from "tsup";

const external = [
  "react",
  "better-auth",
  "zod",
  "@byo-oss/core",
  "@byo-oss/mailer",
  "@wraps.dev/email",
  "@aws-sdk/client-s3",
  "vitest",
  "mailauth",
  "postal-mime",
];

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      client: "src/client.ts",
      wraps: "src/wraps.ts",
      s3: "src/s3.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    // clean is done in the build script — with parallel configs, tsup's
    // own clean races the other config's output and can delete emitted files
    clean: false,
    external,
  },
  {
    // ESM only: vitest throws when it's require()d
    entry: { testing: "src/testing.ts" },
    format: ["esm"],
    dts: true,
    clean: false,
    external,
  },
  {
    entry: {
      "react/index": "src/react/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    external,
    banner: { js: '"use client";' },
  },
]);
