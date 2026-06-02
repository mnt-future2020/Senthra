export type Section = "account" | "appearance" | "integrations" | "email";

export type Msg = { type: "success" | "error"; text: string } | null;

// Props the dashboard passes down so the Appearance section can edit the theme.
export type AppearanceProps = {
  accent: string;
  setAccent: (v: string) => void;
  theme: "light" | "dark";
  setTheme: (v: "light" | "dark") => void;
  density: "compact" | "regular";
  setDensity: (v: "compact" | "regular") => void;
  radius: number;
  setRadius: (v: number) => void;
  pushToast: (msg: string, type?: "success" | "info" | "alert") => void;
};
