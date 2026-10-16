import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Autonomous Research Lab",
  description:
    "Multiple AI agents collaborate autonomously on a research topic, publish structured findings in real time, and survive provider rate limits without stalling.",
};

export const viewport: Viewport = {
  themeColor: "#04060a",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-lab-void antialiased">{children}</body>
    </html>
  );
}
