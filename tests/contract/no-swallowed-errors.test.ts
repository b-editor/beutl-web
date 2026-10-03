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

// catch が受け取ったエラーを、使いもせず、投げ直しもせずに捨てるなら、なぜ
// 捨ててよいのかをその場にコメントで書く。何も書かれていない catch は、障害を
// 「見つからない」「権限が無い」のような別の結果に化けさせていることが多い。
// ログに残すだけでも、そのログが受け取ったエラーを含まなければ捨てたのと同じ。
//
// 別のエラーを投げるのは捨てたことにしない。失敗は失敗のまま呼び出し側に届く。
//
// ストリームの cancel() の失敗だけは例外とする。読むのをやめた相手を片付けて
// いるだけで、その失敗が伝える事実は無い。
function swallowedErrors(file: string, source: string): number[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: number[] = [];

  const isFunction = (node: TypeScript.Node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isAccessor(node) ||
    ts.isConstructorDeclaration(node);
  const binds = (name: TypeScript.BindingName | undefined, text: string): boolean => {
    if (!name) return false;
    if (ts.isIdentifier(name)) return name.text === text;
    return name.elements.some(
      (element) => !ts.isOmittedExpression(element) && binds(element.name, text),
    );
  };
  // A block that declares the same name hides the catch binding inside it.
  const shadows = (node: TypeScript.Node, text: string) =>
    (isFunction(node) &&
      (node as TypeScript.SignatureDeclaration).parameters.some((parameter) =>
        binds(parameter.name, text),
      )) ||
    (ts.isCatchClause(node) && binds(node.variableDeclaration?.name, text)) ||
    ((ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) &&
      node.statements.some(
        (statement) =>
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some((declaration) =>
            binds(declaration.name, text),
          ),
      ));
  const isReference = (identifier: TypeScript.Identifier) => {
    const parent = identifier.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === identifier) return false;
    if (ts.isBindingElement(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)) {
      return parent.initializer === identifier;
    }
    return true;
  };
  // Whether the body reads the caught value itself, not something that only
  // shares its name.
  const uses = (body: TypeScript.Node, name: TypeScript.BindingName | undefined) => {
    if (!name || !ts.isIdentifier(name)) return false;
    const text = name.text;
    let seen = false;
    const visit = (node: TypeScript.Node) => {
      if (seen || shadows(node, text)) return;
      if (ts.isIdentifier(node) && node.text === text && isReference(node)) seen = true;
      else ts.forEachChild(node, visit);
    };
    if (ts.isBlock(body)) body.statements.forEach(visit);
    else visit(body);
    return seen;
  };
  const throws = (body: TypeScript.Node) => {
    let seen = false;
    const visit = (node: TypeScript.Node) => {
      if (seen || isFunction(node)) return;
      if (ts.isThrowStatement(node)) seen = true;
      else ts.forEachChild(node, visit);
    };
    if (isFunction(body)) ts.forEachChild(body, visit);
    else visit(body);
    return seen;
  };
  // Only real comments count: text that looks like one inside a string or a
  // regular expression is not a reason.
  // TypeScript reports a comment on the same line as the token before it as
  // trailing, and one on a later line as leading; either is a reason.
  const commentAt = (position: number) =>
    (ts.getLeadingCommentRanges(source, position)?.length ?? 0) > 0 ||
    (ts.getTrailingCommentRanges(source, position)?.length ?? 0) > 0;
  const hasComment = (node: TypeScript.Node): boolean =>
    commentAt(node.getFullStart()) ||
    node.getChildren(sourceFile).some(hasComment);
  const statementOf = (node: TypeScript.Node) => {
    let current = node;
    while (!ts.isStatement(current) && current.parent) current = current.parent;
    return current;
  };
  const record = (node: TypeScript.Node) => {
    found.push(
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    );
  };

  const visit = (node: TypeScript.Node) => {
    if (ts.isCatchClause(node)) {
      const block = node.block;
      // Comments inside the braces, not the one before "catch".
      const commented = block.getChildren(sourceFile).slice(1).some(hasComment);
      if (!uses(block, node.variableDeclaration?.name) && !throws(block) && !commented) {
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
        // A reason may sit inside the handler, above the statement, or on the
        // line just before ".catch(" in a chain.
        const commented =
          handler.getChildren(sourceFile).some(hasComment) ||
          commentAt(statementOf(handler).getFullStart()) ||
          commentAt(receiver.getEnd());
        if (!uses(handler.body, handler.parameters[0]?.name) && !throws(handler) && !commented) {
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
    expect(
      files.flatMap((file) =>
        swallowedErrors(file, readFileSync(path.join(root, file), "utf8")).map(
          (line) => `${file}:${line}`,
        ),
      ),
    ).toEqual([]);
    // Parsing every source file takes seconds when the suite runs in parallel.
  }, 60_000);

  it.each([
    ["an unused binding", "try { f(); } catch (error) { return null; }"],
    ["no binding", "try { f(); } catch { return null; }"],
    ["a log without the error", 'try { f(); } catch (error) { console.error("failed"); return null; }'],
    ["a shadowed binding", "try { f(); } catch (error) { [1].forEach((error) => use(error)); }"],
    ["a redeclared binding", "try { f(); } catch (error) { { const error = 1; use(error); } }"],
    ["a property that shares the name", "try { f(); } catch (error) { use(result.error); }"],
    ["comment markers in a string", 'try { f(); } catch { return "https://fallback"; }'],
    ["comment markers in a regular expression", "try { f(); } catch { return /\\/\\*/; }"],
    ["a comment only before catch", "try { f(); } // why\ncatch { return null; }"],
    ["a promise handler", "p.catch(() => null);"],
    ["a promise handler with an unused parameter", 'p.catch((error) => console.error("failed"));'],
  ])("flags a catch with %s", (_, code) => {
    expect(swallowedErrors("fixture.ts", code)).toHaveLength(1);
  });

  it.each([
    ["a used binding", "try { f(); } catch (error) { report(error); }"],
    ["a logged binding", 'try { f(); } catch (error) { console.error("failed", error); }'],
    ["a narrowed rethrow", "try { f(); } catch (error) { if (!expected(error)) throw error; }"],
    ["another error thrown", 'try { f(); } catch { throw new Error("failed"); }'],
    ["a reason inside", "try { f(); } catch {\n  // The store is optional.\n  return null;\n}"],
    ["a promise handler using its parameter", "p.catch((error) => report(error));"],
    ["a reason above the statement", "// The result is optional.\np.catch(() => null);"],
    ["a reason before .catch in a chain", "p\n  .then(f)\n  // The result is optional.\n  .catch(() => null);"],
    ["a cancelled stream", "await reader.cancel().catch(() => undefined);"],
  ])("accepts a catch with %s", (_, code) => {
    expect(swallowedErrors("fixture.ts", code)).toEqual([]);
  });
});
