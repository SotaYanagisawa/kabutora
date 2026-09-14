import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const developmentEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const emulatorConnections = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_KABUTORA_EMULATORS === "1" && ["localhost", "127.0.0.1"].includes(request.nextUrl.hostname)
    ? " http://127.0.0.1:9099 http://127.0.0.1:8085" : "";
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentEval} https://accounts.google.com https://apis.google.com https://www.gstatic.com https://www.google.com https://www.recaptcha.net`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self' https://accounts.google.com https://apis.google.com https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://securetoken.googleapis.com https://identitytoolkit.googleapis.com https://firebaseappcheck.googleapis.com${emulatorConnections}`,
    "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com https://www.google.com https://www.recaptcha.net",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|__/auth|__/firebase|favicon.ico|kabutora-logo.png|icon.svg|icon-192.png|icon-512.png|apple-touch-icon.png|manifest.webmanifest|sw.js).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
