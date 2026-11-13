import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import "./globals.css";
import Nav from "@/components/Nav";
import Notifiers from "@/components/Notifiers";
import { ToastProvider } from "@/lib/toast";
import ScrollToTop from "@/components/ScrollToTop";

export const viewport: Viewport = {
  themeColor: "#0a0a0f",
};

export const metadata: Metadata = {
  title: "RiftWatch - Watch Anime",
  description: "Search, watch & manage anime",
  // No `icons` entry: src/app/icon.svg is picked up by the file convention.
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* Satoshi 600: font-semibold is used across the UI but was never
            requested (400,500,700,900) — the browser faux-bolded it.
            900 dropped: nothing uses font-black. */}
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,600,700&f[]=clash-display@400,500,600,700&display=swap" rel="stylesheet" />
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='light'){document.documentElement.setAttribute('data-theme','light');}else if(t==='dark'){document.documentElement.setAttribute('data-theme','dark');}else if(window.matchMedia('(prefers-color-scheme:light)').matches){document.documentElement.setAttribute('data-theme','light');}}catch(e){}})();` }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <ToastProvider>
          <Notifiers />
          <Suspense>
            <Nav />
          </Suspense>
          <main className="flex-1 page-enter">{children}</main>
          <ScrollToTop />
        </ToastProvider>
      </body>
    </html>
  );
}
