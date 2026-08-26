import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

const initialAppearanceScript = `(()=>{try{const root=document.documentElement;const theme=localStorage.getItem("kabutora-theme");const accent=localStorage.getItem("kabutora-accent");const hideScrollbar=localStorage.getItem("kabutora-hide-scrollbar");root.dataset.theme=theme==="dark"?"dark":"light";if(["graphite","blue","forest","plum"].includes(accent))root.dataset.accent=accent;root.dataset.hideScrollbar=hideScrollbar==="false"?"false":"true";}catch{}window.addEventListener("error",event=>{const message=String(event.message||event.error?.message||"");if(!/ChunkLoadError|Loading chunk|dynamically imported module/i.test(message)||sessionStorage.getItem("kabutora-chunk-repair"))return;sessionStorage.setItem("kabutora-chunk-repair","1");Promise.all([navigator.serviceWorker?.getRegistrations?.().then(items=>Promise.all(items.map(item=>item.unregister()))).catch(()=>{}),window.caches?.keys?.().then(keys=>Promise.all(keys.filter(key=>key.startsWith("kabutora-shell-")).map(key=>caches.delete(key)))).catch(()=>{})]).finally(()=>location.replace("/?chunk-repaired="+Date.now()));},true);})();`;

export const metadata: Metadata = {
  title: "株トラ — ポートフォリオトラッカー",
  description: "日本株と米国株をひとつにまとめる、個人向けポートフォリオトラッカー。",
  applicationName: "株トラ",
  appleWebApp: {
    capable: true,
    title: "株トラ",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icon.svg",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="ja" suppressHydrationWarning>
      <head><link rel="manifest" href="/manifest.webmanifest?v=91"/><script nonce={nonce} dangerouslySetInnerHTML={{ __html: initialAppearanceScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
