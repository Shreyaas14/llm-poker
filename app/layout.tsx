import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "River Market — Poker prediction market",
  description: "Four AI poker players. Every hand visible. Trade the outcome across five hands in a play-money prediction market.",
  metadataBase: new URL("https://river-market-poker.suseendransuresh.chatgpt.site"),
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
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
