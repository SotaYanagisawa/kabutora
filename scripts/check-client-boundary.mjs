import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript");

export function checkClientBoundary(workspace) {
  const web = path.join(workspace, "apps/web");
  const files = fs.readdirSync(path.join(web, "components"), { recursive: true }).filter((name) => /\.tsx?$/u.test(name)).map((name) => path.join(web, "components", name));
  const visited = new Set();
  const resolve = (source, specifier) => {
    const base = specifier.startsWith("@/") ? path.join(web, specifier.slice(2)) : specifier.startsWith(".") ? path.resolve(path.dirname(source), specifier) : null;
    return base && [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")].find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  };
  const visit = (file, chain = []) => {
    if (visited.has(file)) return;
    visited.add(file);
    if (/\/lib\/(?:server\/|server-[^/]+\.tsx?$|cloudflare-market-env\.ts$)/u.test(file)) throw new Error(`Client imports server runtime: ${[...chain, file].map((value) => path.relative(web, value)).join(" -> ")}`);
    const ast = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const walk = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.isTypeOnly || node.importClause?.isTypeOnly) return;
        const bindings = node.importClause?.namedBindings ?? node.exportClause;
        if (!node.importClause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every((item) => item.isTypeOnly)) return;
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const target = resolve(file, node.moduleSpecifier.text); if (target) visit(target, [...chain, file]);
        }
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        const target = resolve(file, node.arguments[0].text); if (target) visit(target, [...chain, file]);
      }
      ts.forEachChild(node, walk);
    };
    walk(ast);
  };
  for (const file of files) if (/^["']use client["']/u.test(fs.readFileSync(file, "utf8"))) visit(file);
  return visited.size;
}
