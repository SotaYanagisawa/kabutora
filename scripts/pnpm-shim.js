#!/usr/bin/env node
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

function getEnv() {
  const localBin = path.resolve(process.cwd(), "node_modules/.bin");
  const parentBin = path.resolve(process.cwd(), "../../node_modules/.bin");
  const rootBin = path.resolve(__dirname, "../node_modules/.bin");
  const pathParts = [localBin, parentBin, rootBin, process.env.PATH || ""].filter(Boolean);
  return { ...process.env, PATH: pathParts.join(path.delimiter) };
}

// Handle `pnpm exec <command> ...`
if (args[0] === "exec") {
  const cmd = args[1];
  const restArgs = args.slice(2);
  const localBin = path.resolve(process.cwd(), "node_modules/.bin", cmd);
  const parentBin = path.resolve(process.cwd(), "../../node_modules/.bin", cmd);
  const rootBin = path.resolve(__dirname, "../node_modules/.bin", cmd);
  const binToRun = fs.existsSync(localBin) ? localBin : (fs.existsSync(parentBin) ? parentBin : (fs.existsSync(rootBin) ? rootBin : cmd));
  try {
    execSync(`${binToRun} ${restArgs.map(a => `"${a}"`).join(" ")}`, { stdio: "inherit", env: getEnv() });
    process.exit(0);
  } catch (err) {
    process.exit(err.status || 1);
  }
}

// Handle --filter @kabutora/web <script>
if (args[0] === "--filter" && args[1] === "@kabutora/web") {
  const scriptName = args[2];
  const pkgPath = path.resolve(process.cwd(), "apps/web/package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg.scripts && pkg.scripts[scriptName]) {
      process.chdir(path.dirname(pkgPath));
      try {
        execSync(pkg.scripts[scriptName], { stdio: "inherit", env: getEnv() });
        process.exit(0);
      } catch (err) {
        process.exit(err.status || 1);
      }
    }
  }
}

// Handle `pnpm run <script>` or `pnpm <script>`
const scriptName = args[0] === "run" ? args[1] : args[0];
const localPkgPath = path.resolve(process.cwd(), "package.json");
if (fs.existsSync(localPkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(localPkgPath, "utf8"));
  if (pkg.scripts && pkg.scripts[scriptName]) {
    try {
      execSync(pkg.scripts[scriptName], { stdio: "inherit", env: getEnv() });
      process.exit(0);
    } catch (err) {
      process.exit(err.status || 1);
    }
  }
}

console.error("pnpm runner: command not handled: " + args.join(" "));
process.exit(1);
