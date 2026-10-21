import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { roles } from "./access";
import { auth } from "./auth";
import { STAFF_ORGANIZATION_ID } from "./constants";

/** Whether any of a member's roles (comma-separated) grants `support: ["read"]`. */
const canRead = (role: string) =>
  role
    .split(",")
    .some(
      (name) =>
        roles[name.trim() as keyof typeof roles]?.authorize({
          support: ["read"],
        }).success,
    );

/**
 * The staff organization's members whose role grants `support: ["read"]`
 * (what `isAgent` checks), for the inbox's assignee and @mention pickers.
 * Only a member of the staff organization can read them.
 */
export const listAgents = createServerFn({ method: "GET" }).handler(async () => {
  const organization = await auth.api.getFullOrganization({
    headers: getRequestHeaders(),
    query: { organizationId: STAFF_ORGANIZATION_ID },
  });
  return (organization?.members ?? [])
    .filter((member) => canRead(member.role))
    .map((member) => ({
      id: member.userId,
      name: member.user.name,
      image: member.user.image ?? null,
    }));
});
