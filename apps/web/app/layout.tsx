import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { BOOT_THEME_KEY, THEME_COLORS } from "@/lib/ui/theme-color";
import "./globals.css";

const initialAppearanceScript = `(()=>{try{const root=document.documentElement;const theme=localStorage.getItem("${BOOT_THEME_KEY}")||localStorage.getItem("kabutora-theme")||"dark";const accent=localStorage.getItem("kabutora-accent");const hideScrollbar=localStorage.getItem("kabutora-hide-scrollbar");root.dataset.theme=theme==="light"?"light":"dark";const color=document.createElement("meta");color.name="theme-color";color.content=theme==="light"?"${THEME_COLORS.light}":"${THEME_COLORS.dark}";document.head.append(color);if(["graphite","blue","forest","plum"].includes(accent))root.dataset.accent=accent;root.dataset.hideScrollbar=hideScrollbar==="false"?"false":"true";}catch{}window.addEventListener("error",event=>{try{const message=String(event.message||event.error?.message||"");if(!/ChunkLoadError|Loading chunk|dynamically imported module/i.test(message)||location.search.includes("chunk-repaired")||sessionStorage.getItem("kabutora-chunk-repair"))return;sessionStorage.setItem("kabutora-chunk-repair","1");Promise.all([navigator.serviceWorker?.getRegistrations?.().then(items=>Promise.all(items.map(item=>item.unregister()))).catch(()=>{}),window.caches?.keys?.().then(keys=>Promise.all(keys.filter(key=>key.startsWith("kabutora-shell-")).map(key=>caches.delete(key)))).catch(()=>{})]).finally(()=>location.replace("/?chunk-repaired="+Date.now()));}catch{}},true);})();`;

export const metadata: Metadata = {
  title: "株トラ — ポートフォリオトラッカー",
  description: "日本株と米国株をひとつにまとめる、個人向けポートフォリオトラッカー。",
  applicationName: "株トラ",
  appleWebApp: {
    capable: true,
    title: "株トラ",
    // The page runs under the status bar so content scrolls beneath the Dynamic Island. iOS 26 lays
    // its Liquid Glass edge blur over the top of such a page; no CSS or meta setting turns that off.
    // "default" avoids the glass but keeps content below an opaque status-bar band instead.
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // Dark until the startup script reads the last theme: the startup screen is black by default.
    <html lang="ja" data-theme="dark" suppressHydrationWarning>
      <head><link rel="manifest" href="/manifest.webmanifest"/><script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: initialAppearanceScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
