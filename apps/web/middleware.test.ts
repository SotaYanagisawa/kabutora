import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

describe("middleware CSP", () => {
  it("includes all required reCAPTCHA domains in connect-src, frame-src, and script-src", () => {
    const request = new NextRequest("https://kabutora.test/dashboard");
    const response = middleware(request);
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).toBeTruthy();

    // connect-src must allow reCAPTCHA assessment calls and App Check endpoints
    expect(csp).toContain("connect-src");
    expect(csp).toContain("https://www.google.com");
    expect(csp).toContain("https://recaptcha.google.com");
    expect(csp).toContain("https://www.recaptcha.net");
    expect(csp).toContain("https://www.gstatic.com");
    expect(csp).toContain("https://firebaseappcheck.googleapis.com");
    expect(csp).toContain("https://*.googleapis.com");

    // frame-src must allow reCAPTCHA frames
    expect(csp).toContain("frame-src");
    expect(csp).toContain("https://www.google.com");
    expect(csp).toContain("https://recaptcha.google.com");
    expect(csp).toContain("https://www.recaptcha.net");

    // script-src must allow reCAPTCHA scripts
    expect(csp).toContain("script-src");
    expect(csp).toContain("https://www.google.com");
    expect(csp).toContain("https://recaptcha.google.com");
    expect(csp).toContain("https://www.recaptcha.net");
  });
});
