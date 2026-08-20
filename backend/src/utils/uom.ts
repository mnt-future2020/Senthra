// Units of measure — ONE vocabulary for the whole app.
//
// The same eight values are asked for by IRM items, customer stock entries and rental items. They
// used to be copy-pasted into each of those (five copies across the two apps, two of them carrying
// a "mirrors the IRM item form" comment that admitted the drift), which meant adding a unit was a
// five-file change and forgetting one produced a picker that offered a value the server refused.
//
// It lives in `utils/` rather than in a module because a unit is not owned by any domain. It is not
// a master either — there is no CRUD, no status, no per-tenant list — so the domain-master rule that
// gives IrmCategory and RentalCategory their own modules does not apply. It is a fixed enum, like
// the Incoterm list.
//
// ADDING A UNIT: append here and nowhere else. Every picker and every schema reads this array, so a
// new value reaches all of them at once. Never REMOVE one — rows already store it, and a value the
// schema no longer accepts turns every later edit of those rows into a validation failure.
export const UOM_OPTIONS = ["Each", "Metre", "Roll", "Pack", "Box", "Set", "Pair", "Reel"] as const;

export type Uom = (typeof UOM_OPTIONS)[number];
