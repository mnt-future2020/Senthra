import * as adminRepo from "./admin.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as customerRepo from "#modules/customer/customer.repository.js";
import { conflict } from "../../utils/http-error.js";

// The admin / staff-user / customer login emails are kept disjoint: login resolves
// admin → user → customer, so an address shared across namespaces would let the
// earlier match shadow the later account. Each account flow checks its OWN collection
// inline (with soft-delete / revive semantics); this is the single guard for the
// OTHER namespaces — pass `skip` for the caller's own.
//
// `blockSoftDeleted` controls whether a SOFT-DELETED staff user / customer also
// conflicts. Default false: only the admin and ACTIVE accounts block (a removed
// account can't log in, and reviving it is gated elsewhere). Set true when the email
// is being claimed by the ADMIN — login matches admin-first, so a later revive of a
// staff user / customer under that address would be silently shadowed.
export async function assertEmailNamespaceFree(
  email: string,
  opts: {
    skip?: { admin?: boolean; staff?: boolean; customer?: boolean };
    blockSoftDeleted?: boolean;
  } = {},
): Promise<void> {
  const skip = opts.skip ?? {};
  const [admin, staff, customer] = await Promise.all([
    skip.admin ? null : adminRepo.findByEmail(email),
    skip.staff ? null : userRepo.findByEmailIncludingDeleted(email),
    skip.customer ? null : customerRepo.findByEmailIncludingDeleted(email),
  ]);
  if (admin) {
    throw conflict("That email belongs to the administrator account. Use a different one.");
  }
  if (staff && (opts.blockSoftDeleted || !staff.deletedAt)) {
    throw conflict("That email belongs to a staff user. Use a different one.");
  }
  if (customer && (opts.blockSoftDeleted || !customer.deletedAt)) {
    throw conflict("That email belongs to a customer. Use a different one.");
  }
}
