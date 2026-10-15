import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Futsal Academy Management System",
  description: "Sistem manajemen akademi futsal — pendaftaran siswa, kehadiran, pembayaran, dan jadwal latihan.",
  keywords: ["futsal", "academy", "management", "Next.js", "TypeScript", "PostgreSQL", "PgLite"],
  authors: [{ name: "Futsal Academy" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Futsal Academy Management System",
    description: "Sistem manajemen akademi futsal",
    siteName: "Futsal Academy",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Futsal Academy Management System",
    description: "Sistem manajemen akademi futsal",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
