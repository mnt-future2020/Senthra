import { describe, expect, it } from "vitest";
import type { Customer, CustomerUser } from "@prisma/client";

import { CUSTOMER_PERMISSIONS, customerPrincipal } from "./principal.js";

// The portal login identity = a CustomerUser scoped to a company. This builder is
// the seam every customer request flows through, so its shape is load-bearing.

function makeUser(over: Partial<CustomerUser> = {}): CustomerUser {
  return {
    id: "user-1",
    customerId: "company-1",
    fullName: "Jane PM",
    email: "jane@bt.com",
    emailLower: "jane@bt.com",
    phone: null,
    designation: null,
    status: "active",
    passwordHash: "hash",
    mustResetPassword: true,
    resetTokenHash: null,
    resetTokenExpiresAt: null,
    lastLoginAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as unknown as CustomerUser;
}

function makeCompany(over: Partial<Customer> = {}): Customer {
  return {
    id: "company-1",
    customerCode: "CUST-0001",
    name: "BT",
    logoUrl: null,
    ...over,
  } as unknown as Customer;
}

describe("customerPrincipal (the portal login identity)", () => {
  it("uses the USER as the principal and the COMPANY as the tenant scope", () => {
    const p = customerPrincipal(makeUser(), makeCompany());
    expect(p.type).toBe("customer");
    expect(p.id).toBe("user-1"); // the signed-in person
    expect(p.customerId).toBe("company-1"); // the only tenant they can address
    expect(p.id).not.toBe(p.customerId); // user is never the company
    expect(p.email).toBe("jane@bt.com");
    expect(p.userName).toBe("Jane PM");
    expect(p.name).toBe("BT");
    expect(p.customerCode).toBe("CUST-0001");
  });

  it("carries the fixed read-only permission set (never a role)", () => {
    expect(customerPrincipal(makeUser(), makeCompany()).permissions).toEqual(CUSTOMER_PERMISSIONS);
  });

  it("treats a null mustResetPassword as 'must reset' (conservative default)", () => {
    expect(
      customerPrincipal(makeUser({ mustResetPassword: null }), makeCompany()).mustResetPassword,
    ).toBe(true);
    expect(
      customerPrincipal(makeUser({ mustResetPassword: false }), makeCompany()).mustResetPassword,
    ).toBe(false);
  });
});
