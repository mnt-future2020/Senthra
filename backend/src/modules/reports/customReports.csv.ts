import { toCsv } from "../../utils/csv.js";
import type { CsvExport } from "../../utils/csv-response.js";
import type { CustomReportResult } from "./customReports.service.js";

/**
 * Custom report → CSV. A RENDERER: the columns come from the registry and the values from the runner,
 * so the file, the screen and the workbook are the same data in three containers.
 *
 * `capped` rides the shared X-Export-Capped header via sendCsv — a short file the user believes is
 * complete is worse than no file.
 */
export function customReportCsv(result: CustomReportResult): CsvExport {
  const cols = result.report.columns;
  const filters = Object.entries(result.appliedFilters).map(([k, v]) => `${k}=${v}`).join("; ") || "none";
  const header = [
    [`Report`, result.report.label],
    [`Filters`, filters],
    [`Generated`, result.generatedAt],
    [],
  ];
  const body = [cols.map((c) => c.header), ...result.rows.map((r) => cols.map((c) => r[c.key] ?? ""))];
  return { csv: toCsv([result.report.label], [...header, ...body] as (string | number)[][]), capped: result.capped };
}
