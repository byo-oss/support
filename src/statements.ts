/**
 * Support's permission statements, in better-auth's access-control format.
 * Spread them into your app's statements and grant them to staff roles.
 * Also exported from `@byo-oss/support/client`, which is safe in browser
 * code: this module imports nothing.
 *
 * - `read`: see the queue and any ticket
 * - `reply`: agent replies and internal notes
 * - `update`: status, priority, assignee, tags, bulk updates, merge
 * - `manage`: canned replies
 * - `delete`: delete tickets
 *
 * ```ts
 * import { createAccessControl } from "better-auth/plugins/access"
 * import { defaultStatements } from "better-auth/plugins/organization/access"
 * import { supportStatements } from "@byo-oss/support/client"
 * export const ac = createAccessControl({ ...defaultStatements, ...supportStatements })
 * ```
 */
export const supportStatements = {
  support: ["read", "reply", "update", "manage", "delete"],
} as const;

export type SupportAction = (typeof supportStatements.support)[number];

/**
 * The suggested mapping for roles in your staff organization: `owner` and
 * `admin` get every support action, `member` gets read, reply and update.
 * Merge each into the role you create with `ac.newRole(...)`:
 *
 * ```ts
 * import { adminAc, memberAc, ownerAc } from "better-auth/plugins/organization/access"
 * const roles = {
 *   owner: ac.newRole({ ...ownerAc.statements, ...supportRoles.owner }),
 *   admin: ac.newRole({ ...adminAc.statements, ...supportRoles.admin }),
 *   member: ac.newRole({ ...memberAc.statements, ...supportRoles.member }),
 * }
 * ```
 *
 * Grant each role only the actions its staff need. Roles apply in every
 * organization, but support only checks them in the staff organization
 * (`staffOrganizationId`): only that organization's members become agents,
 * so a customer org's owner is never one.
 */
export const supportRoles = {
  owner: { support: [...supportStatements.support] },
  admin: { support: [...supportStatements.support] },
  member: { support: ["read", "reply", "update"] },
} satisfies Record<string, { support: SupportAction[] }>;
