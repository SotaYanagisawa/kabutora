import { describe, expect, it } from "vitest";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

describe("rules of hooks compliance", () => {
  it("ensures no component calls hooks conditionally or after early returns", () => {
    const violations: string[] = [];

    function checkFile(filePath: string) {
      const content = fs.readFileSync(filePath, "utf8");
      const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

      function checkComponent(node: ts.Node) {
        let returned = false;

        function visit(child: ts.Node, inControlFlow = false) {
          if (ts.isFunctionDeclaration(child) || ts.isArrowFunction(child) || ts.isFunctionExpression(child)) {
            return;
          }
          if (
            ts.isIfStatement(child) ||
            ts.isConditionalExpression(child) ||
            ts.isSwitchStatement(child) ||
            ts.isForStatement(child) ||
            ts.isForInStatement(child) ||
            ts.isForOfStatement(child) ||
            ts.isWhileStatement(child) ||
            ts.isDoStatement(child)
          ) {
            ts.forEachChild(child, (c) => visit(c, true));
            return;
          }
          if (
            ts.isBinaryExpression(child) &&
            (child.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
              child.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
              child.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
          ) {
            visit(child.left, inControlFlow);
            visit(child.right, true);
            return;
          }
          if (ts.isReturnStatement(child)) {
            returned = true;
            return;
          }
          if (ts.isCallExpression(child)) {
            const text = child.expression.getText(sourceFile);
            if (/^use[A-Z]/.test(text)) {
              const loc = sourceFile.getLineAndCharacterOfPosition(child.getStart());
              const rel = path.relative(process.cwd(), filePath);
              if (inControlFlow) {
                violations.push(`[CONDITIONAL HOOK] ${rel}:${loc.line + 1} - ${text}`);
              }
              if (returned) {
                violations.push(`[HOOK AFTER RETURN] ${rel}:${loc.line + 1} - ${text}`);
              }
            }
          }
          ts.forEachChild(child, (c) => visit(c, inControlFlow));
        }

        const func = node as ts.FunctionLikeDeclaration;
        if (func.body && ts.isBlock(func.body)) {
          ts.forEachChild(func.body, (c) => visit(c, false));
        }
      }

      function findFunctions(node: ts.Node) {
        if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
          checkComponent(node);
        }
        ts.forEachChild(node, findFunctions);
      }

      findFunctions(sourceFile);
    }

    function scanDir(dir: string) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== ".next" && entry.name !== "dist") {
            scanDir(full);
          }
        } else if (entry.name.endsWith(".tsx") || (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))) {
          checkFile(full);
        }
      }
    }

    scanDir(path.resolve(process.cwd(), "apps/web/components"));
    scanDir(path.resolve(process.cwd(), "apps/web/app"));

    expect(violations).toEqual([]);
  });
});
