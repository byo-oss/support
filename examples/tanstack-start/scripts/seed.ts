import { betterAuth } from "better-auth";
import { authOptions } from "../src/lib/auth-options.ts";
import { AGENT, CUSTOMER, STAFF_ORGANIZATION_ID } from "../src/lib/constants.ts";

const auth = betterAuth(authOptions);
const { adapter, internalAdapter } = await auth.$context;

async function ensureUser(user: typeof AGENT) {
  const existing = await internalAdapter.findUserByEmail(user.email);
  if (existing) return existing.user.id;
  const { user: created } = await auth.api.signUpEmail({ body: user });
  return created.id;
}

const agentId = await ensureUser(AGENT);
await ensureUser(CUSTOMER);

// The staff organization has a fixed id, which the API can't set, so it goes
// through the adapter. The agent is its owner: `supportRoles.owner` has every
// support action.
const org = await adapter.findOne({
  model: "organization",
  where: [{ field: "id", value: STAFF_ORGANIZATION_ID }],
});
if (!org) {
  await adapter.create({
    model: "organization",
    forceAllowId: true,
    data: {
      id: STAFF_ORGANIZATION_ID,
      name: "Example Support Team",
      slug: "support-team",
      createdAt: new Date(),
    },
  });
  await adapter.create({
    model: "member",
    data: {
      organizationId: STAFF_ORGANIZATION_ID,
      userId: agentId,
      role: "owner",
      createdAt: new Date(),
    },
  });
}

console.log(`seeded: ${AGENT.email} (agent), ${CUSTOMER.email} (customer)`);
