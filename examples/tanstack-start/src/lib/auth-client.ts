import { createAuthClient } from "better-auth/react";
import { supportClient } from "@byo-oss/support/client";

export const authClient = createAuthClient({
  plugins: [supportClient()],
});
