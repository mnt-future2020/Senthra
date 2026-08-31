// Local re-exports so the schedule components share ONE source for these shapes — they mirror the
// backend's models and must not drift into two copies.
export type {
  ReportRun,
  ReportSchedule,
  SchedulableReport,
  SchedulePayload,
  ScheduleRecipient,
} from "@/services/reports.service";

/** The form's working copy. Strings throughout, because that is what inputs produce. */
export interface SchedulablePayloadState {
  name: string;
  reportKey: string;
  cadence: "weekly" | "monthly";
  dayOfWeek: string;
  dayOfMonth: string;
  time: string;
  format: "xlsx" | "csv";
  /** Selected recipient EMAILS, chosen from the server's eligible list — never free text. */
  recipients: string[];
  filters: Record<string, string>;
  enabled: boolean;
}
