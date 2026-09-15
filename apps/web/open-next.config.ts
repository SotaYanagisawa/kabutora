import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default {
  ...defineCloudflareConfig(),
  // Keep the Cloudflare build independent of whichever workspace package-manager
  // shim happens to be first on PATH in CI or the Codex runtime.
  buildCommand: `"${process.execPath}" node_modules/next/dist/bin/next build`,
};
