import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";
import { supportRoles, supportStatements } from "@byo-oss/support";

export const ac = createAccessControl({
  ...defaultStatements,
  ...supportStatements,
});

export const roles = {
  owner: ac.newRole({ ...ownerAc.statements, ...supportRoles.owner }),
  admin: ac.newRole({ ...adminAc.statements, ...supportRoles.admin }),
  member: ac.newRole({ ...memberAc.statements, ...supportRoles.member }),
};
