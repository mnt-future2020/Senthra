/**
 * How an OPTIONAL text field is put into a create/edit payload.
 *
 * An update is a PATCH: a MISSING key means "leave this field alone", so it can't also mean "clear
 * it". And `JSON.stringify` DELETES keys whose value is `undefined` — so the long-standing
 * `city.trim() || undefined` made a cleared box literally unsendable. The user empties City, hits
 * Save, gets a success toast, and the server never hears about the field at all: the old value
 * stays in the database while the form shows it blank. Reopen the record and the old value is back.
 *
 * On EDIT a blank box therefore sends `""` — every update schema accepts it and the services'
 * `trimToNull` turns it into `null`, which is what "the user cleared this" means in the database.
 *
 * On CREATE a blank stays OMITTED. There is nothing to clear yet, and several create schemas
 * reject `""` outright (a postcode must match the UK pattern, an email must be an email) — sending
 * an empty string there would turn "I left this optional field blank" into a validation error.
 */
export function optionalFor(isEdit: boolean): (value: string) => string | undefined {
  return (value: string) => {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
    return isEdit ? "" : undefined;
  };
}
