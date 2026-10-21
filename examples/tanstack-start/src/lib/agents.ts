import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth } from "./auth";
import { STAFF_ORGANIZATION_ID } from "./constants";

/**
 * The staff organization's members, for the inbox's assignee and @mention
 * pickers. Only a member of the staff organization can read them.
 */
export const listAgents = createServerFn({ method: "GET" }).handler(async () => {
  const organization = await auth.api.getFullOrganization({
    headers: getRequestHeaders(),
    query: { organizationId: STAFF_ORGANIZATION_ID },
  });
  return (organization?.members ?? []).map((member) => ({
    id: member.userId,
    name: member.user.name,
    image: member.user.image ?? null,
  }));
});
