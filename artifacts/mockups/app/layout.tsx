import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VeriFlow — lesson booking flow in main-panel",
  description:
    "Interactive product mockup of VeriFlow after the first six architecture features: one question, one traced flow, every path.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="cs">
      <body>{children}</body>
    </html>
  );
}
