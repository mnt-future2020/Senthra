// Units of measure — the picker half of ONE vocabulary shared with the server.
//
// Must stay identical to `backend/src/utils/uom.ts`, which is what actually validates: every schema
// that accepts a unit uses `z.enum(UOM_OPTIONS)`, so a value offered here but missing there is a
// picker whose selection the server refuses.
//
// These eight used to be copy-pasted into the IRM item form and both customer stock screens (three
// copies here, two more on the server), which is how the rental form ended up with a free-text box
// instead — nothing pointed at a single list to follow.
//
// ADDING A UNIT: add it in BOTH files. Never remove one — rows already store it.
export const UOM_OPTIONS = ["Each", "Metre", "Roll", "Pack", "Box", "Set", "Pair", "Reel"] as const;

export type Uom = (typeof UOM_OPTIONS)[number];

/** Ready for `<Select options={…}>` — the label and the stored value are the same string. */
export const UOM_SELECT_OPTIONS = UOM_OPTIONS.map((u) => ({ value: u, label: u }));
