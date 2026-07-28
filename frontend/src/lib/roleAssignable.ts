// Which roles the current actor may hand out in the user form's Role picker.
//
// This MIRRORS the backend's `assertCanAssignRole` (modules/user/user.service.ts), which is the
// real enforcer — it runs on both createUser and updateUser. The copy here exists purely so the
// picker doesn't offer an option the API will reject: without it a delegated admin (e.g. System
// Admin, who holds users.create but not "*") sees "Super Admin" in the list, fills in the whole
// form, submits, and only then gets a 403.
//
// Kept in sync BY HAND, like the other mirrored client/server rules in this codebase. Drift makes
// the picker stricter or looser than the API — never the API itself.

const ALL_ACCESS = "*";

// `holds` is the actor's own permission test — pass `can` from useAuth, which already returns true
// for every key when the principal is the built-in admin account.
export function canAssignRole(
  rolePermissions: string[],
  holds: (permission: string) => boolean,
): boolean {
  // A full-access actor may assign anything, including another full-access role.
  if (holds(ALL_ACCESS)) return true;
  // A delegate can never mint another super-user...
  if (rolePermissions.includes(ALL_ACCESS)) return false;
  // ...nor grant an individual permission it doesn't itself hold.
  return rolePermissions.every((p) => holds(p));
}
