import { resolveBuildId } from "../../scripts/source-build-id.mjs";

const buildId = resolveBuildId();
process.env.NEXT_PUBLIC_KABUTORA_BUILD_ID = buildId;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  devIndicators: false,
  poweredByHeader: false,
  transpilePackages: ["@kabutora/domain"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  env: {
    NEXT_PUBLIC_KABUTORA_BUILD_ID: buildId,
    NEXT_PUBLIC_KABUTORA_RECOVERY_MIGRATION: process.env.NEXT_PUBLIC_KABUTORA_RECOVERY_MIGRATION ?? "enabled",
  },
  generateBuildId: async () => buildId,
  async headers() {
    return [{
      source: "/((?!__/auth|__/firebase).*)",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      ],
    }];
  },
};

export default nextConfig;
