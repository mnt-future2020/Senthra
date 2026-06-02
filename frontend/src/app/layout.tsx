import type { Metadata } from "next";
import "./globals.css";

import { AuthProvider } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Senthra — Admin Dashboard",
  description: "Senthra admin & analytics dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
