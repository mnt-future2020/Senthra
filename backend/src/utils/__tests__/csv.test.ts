import { describe, expect, it } from "vitest";

import { csvEscape, toCsv } from "../csv.js";

describe("csvEscape", () => {
  it("leaves an ordinary value untouched", () => {
    expect(csvEscape("Optical splitter")).toBe("Optical splitter");
  });

  it("quotes and doubles embedded quotes", () => {
    expect(csvEscape('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("quotes values containing a comma, newline or carriage return", () => {
    expect(csvEscape("Leeds, West Yorkshire")).toBe('"Leeds, West Yorkshire"');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape("line1\rline2")).toBe('"line1\rline2"');
  });

  // The security half of this function. A cell starting with any of these is executed as a FORMULA by
  // Excel and Google Sheets when the download is opened, so the leading apostrophe is what keeps a
  // hostile item name from becoming code on the recipient's machine.
  describe("formula injection", () => {
    it.each(["=", "+", "-", "@", "\t", "\r"])("neutralises a value starting with %j", (lead) => {
      expect(csvEscape(`${lead}SUM(A1)`)).toContain("'");
      expect(csvEscape(`${lead}SUM(A1)`).replace(/^"|"$/g, "").startsWith("'")).toBe(true);
    });

    it("neutralises the classic command-execution payload", () => {
      // Apostrophe-prefixed but NOT double-quoted: the payload's quotes are SINGLE quotes, which are
      // not CSV syntax, so there is nothing to escape. The prefix alone is what defuses it.
      expect(csvEscape(`=cmd|'/c calc'!A0`)).toBe(`'=cmd|'/c calc'!A0`);
    });

    it("both prefixes AND quotes when the payload also contains CSV syntax", () => {
      expect(csvEscape(`=HYPERLINK("http://x","click")`)).toBe(
        `"'=HYPERLINK(""http://x"",""click"")"`,
      );
    });

    it("does not touch a minus that appears later in the value", () => {
      expect(csvEscape("WH-0009")).toBe("WH-0009");
    });

    it("still neutralises a NEGATIVE NUMBER, which is the accepted trade-off", () => {
      // `-5` starts with `-`, so it gets the apostrophe and lands in the sheet as text. Safety wins:
      // the alternative is parsing every cell to decide whether it's arithmetic or an attack.
      expect(csvEscape("-5")).toBe("'-5");
    });
  });
});

describe("toCsv", () => {
  it("emits the header alone when there are no rows", () => {
    expect(toCsv(["Item", "Qty"], [])).toBe("Item,Qty");
  });

  it("joins rows with CRLF, as RFC 4180 and Excel expect", () => {
    expect(toCsv(["Item", "Qty"], [["Splitter", 2]])).toBe("Item,Qty\r\nSplitter,2");
  });

  it("renders null and undefined as empty cells rather than the words", () => {
    // A literal "null" in a spreadsheet cell reads as data the customer then has to interpret.
    expect(toCsv(["A", "B", "C"], [[null, undefined, 0]])).toBe("A,B,C\r\n,,0");
  });

  it("keeps a zero and a false, which are values and not blanks", () => {
    expect(toCsv(["Qty", "Flag"], [[0, false]])).toBe("Qty,Flag\r\n0,false");
  });

  it("escapes header cells too", () => {
    expect(toCsv(["Not received, units"], [])).toBe('"Not received, units"');
  });

  it("escapes every cell of every row", () => {
    const csv = toCsv(["Item", "Warehouse"], [["=BAD()", "Leeds, UK"], ["Fine", "London"]]);
    expect(csv).toBe('Item,Warehouse\r\n\'=BAD(),"Leeds, UK"\r\nFine,London');
  });
});
