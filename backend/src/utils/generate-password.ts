import crypto from "node:crypto";

// Cryptographically-strong temporary password generator. Guarantees at least one
// lowercase, uppercase, digit and symbol so the result satisfies common
// complexity rules. Ambiguous characters (0/O/1/l/I) are omitted for legibility,
// since the value is read by a human from an email.
const LOWER = "abcdefghijkmnpqrstuvwxyz"; // no l
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
const DIGITS = "23456789"; // no 0, 1
const SYMBOLS = "!@#$%^&*?";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

function pick(alphabet: string): string {
  return alphabet[crypto.randomInt(alphabet.length)];
}

export function generateTempPassword(length = 14): string {
  const size = Math.max(length, 8);
  const required = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  const rest = Array.from({ length: size - required.length }, () => pick(ALL));
  const chars = [...required, ...rest];

  // Fisher–Yates shuffle with a CSPRNG so the required characters aren't always
  // at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
