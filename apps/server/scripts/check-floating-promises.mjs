#!/usr/bin/env node
/**
 * Fails on a promise that is neither awaited, returned, assigned, chained nor explicitly voided. With Postgres every
 * query is async, and a forgotten `await` on a write is a silent race (the next read may not see it) that TypeScript
 * doesn't report. Uses the TypeScript checker, so calls into other modules are typed correctly.
 *
 *   node apps/server/scripts/check-floating-promises.mjs [tsconfig path]
 */
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const configPath = resolve(process.argv[2] ?? resolve(import.meta.dirname, "../tsconfig.json"));
const read = ts.readConfigFile(configPath, ts.sys.readFile);
if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

function isPromiseLike(type) {
  if (type.isUnion()) return type.types.some(isPromiseLike);
  const then = type.getProperty("then");
  if (!then) return false;
  const decl = then.valueDeclaration ?? then.declarations?.[0];
  if (!decl) return false;
  return checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(then, decl), ts.SignatureKind.Call).length > 0;
}

const problems = [];
const misused = [];
const isPromiseExpr = (e) => isPromiseLike(checker.getTypeAtLocation(e));
// In a condition, `Promise | undefined` is a legitimate "is a job in flight?" check: only an always-promise is a bug.
const alwaysPromise = (e) => {
  const t = checker.getTypeAtLocation(e);
  return t.isUnion() ? t.types.every(isPromiseLike) : isPromiseLike(t);
};
const report = (e, sf, why) => {
  const { line, character } = sf.getLineAndCharacterOfPosition(e.getStart(sf));
  misused.push(`${relative(process.cwd(), sf.fileName)}:${line + 1}:${character + 1}  ${why}: ${e.getText(sf).split("\n")[0].slice(0, 90)}`);
};
for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || sf.fileName.includes("node_modules")) continue;
  const visit = (node) => {
    if (ts.isExpressionStatement(node)) {
      let e = node.expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      // `void p` is an explicit fire-and-forget; awaits, assignments and chains with .catch are handled.
      const skip = ts.isVoidExpression(e) || ts.isAwaitExpression(e) || ts.isBinaryExpression(e);
      if (!skip && (ts.isCallExpression(e) || ts.isNewExpression(e)) && isPromiseLike(checker.getTypeAtLocation(e))) {
        const callee = ts.isCallExpression(e) ? e.expression : null;
        const handled =
          callee && ts.isPropertyAccessExpression(callee) && ["catch", "finally"].includes(callee.name.text)
            ? true
            : callee && ts.isPropertyAccessExpression(callee) && callee.name.text === "then" && e.arguments.length >= 2;
        if (!handled) {
          const { line, character } = sf.getLineAndCharacterOfPosition(e.getStart(sf));
          problems.push(`${relative(process.cwd(), sf.fileName)}:${line + 1}:${character + 1}  ${e.getText(sf).split("\n")[0].slice(0, 100)}`);
        }
      }
    }
    // A promise where a value is expected: a condition, a template, a spread, or JSON/response serialization.
    const cond =
      (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isConditionalExpression(node)) && node.expression !== undefined
        ? ts.isConditionalExpression(node)
          ? node.condition
          : node.expression
        : null;
    if (cond && alwaysPromise(cond)) report(cond, sf, "promise used as a condition");
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && alwaysPromise(node.operand))
      report(node.operand, sf, "promise negated");
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind) &&
      alwaysPromise(node.left)
    )
      report(node.left, sf, "promise in a logical expression");
    if (ts.isTemplateSpan(node) && isPromiseExpr(node.expression)) report(node.expression, sf, "promise in a template string");
    if ((ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) && isPromiseExpr(node.expression)) report(node.expression, sf, "promise spread");
    // An async predicate is always truthy: filter keeps everything, find returns the first element.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["filter", "find", "findIndex", "findLast", "some", "every", "sort"].includes(node.expression.name.text) &&
      node.arguments[0] &&
      (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0])) &&
      node.arguments[0].modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    )
      report(node.arguments[0], sf, `async callback passed to .${node.expression.name.text}()`);
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (/(^|\.)(JSON\.stringify|json|body|text)$/.test(callee) || callee === "JSON.stringify")
        for (const a of node.arguments) if (isPromiseExpr(a)) report(a, sf, `promise passed to ${callee}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
if (misused.length) {
  console.error(`${misused.length} misused promise(s):\n${misused.join("\n")}`);
  process.exitCode = 1;
}
if (problems.length) {
  console.error(`${problems.length} floating promise(s): await them, return them, or mark fire-and-forget with \`void\`:\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("No floating promises.");
