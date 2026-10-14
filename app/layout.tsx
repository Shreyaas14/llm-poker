import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VESPER — Poker prediction market",
  description: "A play-money prediction market on four AI poker players. Trade across five hands.",
  metadataBase: new URL("https://river-market-poker.suseendransuresh.chatgpt.site"),
  icons: {
    icon: { url: "/vesper-icon.png", type: "image/png", sizes: "64x64" },
    shortcut: "/vesper-icon.png",
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
