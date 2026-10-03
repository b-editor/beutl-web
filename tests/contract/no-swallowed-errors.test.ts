import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type * as TypeScript from "typescript";

// typescript は apps/web の devDependency にしか無い。
const ts = createRequire(
  path.resolve(__dirname, "../../apps/web/package.json"),
)("typescript") as typeof TypeScript;

const root = path.resolve(__dirname, "../..");

// catch が受け取ったエラーを、使いもせず、投げ直しもせず、ログにも残さずに
// 捨てるなら、なぜ捨ててよいのかをその場にコメントで書く。何も書かれていない
// catch は、障害を「見つからない」「権限が無い」のような別の結果に化けさせて
// いることが多い。
//
// ストリームの cancel() の失敗だけは例外とする。読むのをやめた相手を片付けて
// いるだけで、その失敗が伝える事実は無い。
function swallowedErrors(file: string): string[] {
  const source = readFileSync(path.join(root, file), "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];

  const mentions = (node: TypeScript.Node, name: string | undefined) => {
    if (!name) return false;
    let seen = false;
    const visit = (child: TypeScript.Node) => {
      if (seen) return;
      if (ts.isIdentifier(child) && child.text === name) seen = true;
      else ts.forEachChild(child, visit);
    };
    visit(node);
    return seen;
  };
  const reports = (node: TypeScript.Node) => {
    let seen = false;
    const visit = (child: TypeScript.Node) => {
      if (seen) return;
      if (
        ts.isThrowStatement(child) ||
        (ts.isCallExpression(child) &&
          /^console\.(error|warn)$/.test(child.expression.getText(sourceFile)))
      ) {
        seen = true;
      } else ts.forEachChild(child, visit);
    };
    visit(node);
    return seen;
  };
  // A reason may sit inside the handler, above the statement, or on the line
  // just before ".catch(" in a chain.
  const commented = (handler: TypeScript.Node, receiver: TypeScript.Node) =>
    /\/\/|\/\*/.test(handler.getText(sourceFile)) ||
    [statementOf(handler).getFullStart(), receiver.getEnd()].some(
      (position) =>
        (ts.getLeadingCommentRanges(source, position)?.length ?? 0) > 0,
    );
  const statementOf = (node: TypeScript.Node) => {
    let current = node;
    while (!ts.isStatement(current) && current.parent) current = current.parent;
    return current;
  };
  const record = (node: TypeScript.Node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    found.push(`${file}:${line + 1}`);
  };

  const visit = (node: TypeScript.Node) => {
    if (ts.isCatchClause(node)) {
      const binding = node.variableDeclaration?.name;
      const name = binding && ts.isIdentifier(binding) ? binding.text : undefined;
      if (
        !mentions(node.block, name) &&
        !reports(node.block) &&
        !/\/\/|\/\*/.test(node.block.getText(sourceFile))
      ) {
        record(node);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch"
    ) {
      const handler = node.arguments[0];
      const receiver = node.expression.expression;
      const cancels =
        ts.isCallExpression(receiver) &&
        ts.isPropertyAccessExpression(receiver.expression) &&
        receiver.expression.name.text === "cancel";
      if (
        handler &&
        (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
        !cancels
      ) {
        const parameter = handler.parameters[0]?.name;
        const name =
          parameter && ts.isIdentifier(parameter) ? parameter.text : undefined;
        if (
          !mentions(handler.body, name) &&
          !reports(handler.body) &&
          !commented(handler, receiver)
        ) {
          record(node);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe("error handling", () => {
  it("does not swallow a caught error without saying why", () => {
    const files = execFileSync(
      "git",
      // Without :(glob), * also matches "/", so these reach every depth under src.
      ["ls-files", "--", "apps/*/src/*.ts", "apps/*/src/*.tsx", "packages/*/src/*.ts", "packages/*/src/*.tsx"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(swallowedErrors)).toEqual([]);
  });
});
