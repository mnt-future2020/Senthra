export type Section =
  | "account"
  | "company"
  | "branding"
  | "appearance"
  | "integrations"
  | "email"
  | "email-templates"
  | "operations"
  | "legal";

// Props the dashboard passes down so the Appearance section can edit personal
// display preferences. The brand/accent color lives in Branding (it's global and
// used in emails), so it isn't here.
export type AppearanceProps = {
  theme: "light" | "dark";
  setTheme: (v: "light" | "dark") => void;
  density: "compact" | "regular";
  setDensity: (v: "compact" | "regular") => void;
  radius: number;
  setRadius: (v: number) => void;
  pushToast: (msg: string, type?: "success" | "info" | "alert") => void;
};
