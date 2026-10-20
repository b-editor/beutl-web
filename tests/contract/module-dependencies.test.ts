import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const compilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  paths: { "@/*": [resolve(root, "apps/web/src/*")] },
};
const resolutionCache = ts.createModuleResolutionCache(root, (path) => path, compilerOptions);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.[cm]?[jt]sx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [child]
      : [];
  }).sort();
}

function isWithin(file: string, directory: string): boolean {
  return file.startsWith(`${directory}${sep}`);
}

for (const name of ["core", "db", "stripe"]) {
  const directory = name === "stripe"
    ? resolve(root, "apps/web/src/lib/stripe")
    : resolve(root, "packages", name, "src");
  const files = sourceFiles(directory);
  // Include type-only dependencies: lower layers must not know application types.
  const imports = new Map(files.map((file) => [
    file,
    ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles.map(({ fileName }) => {
      const target = ts.resolveModuleName(fileName, file, compilerOptions, ts.sys, resolutionCache)
        .resolvedModule?.resolvedFileName;
      return { specifier: fileName, target: target && resolve(target) };
    }),
  ]));

  describe(`${name} module boundaries`, () => {
    it("depends only on its own modules and lower workspace layers", () => {
      const allowedDirectories = [directory];
      const allowedPackages = [`@beutl/${name}`];
      if (name === "db") {
        allowedDirectories.push(resolve(root, "packages/core/src"));
        allowedPackages.push("@beutl/core");
      }

      expect(files.length).toBeGreaterThan(0);
      for (const [file, dependencies] of imports) {
        for (const { specifier, target } of dependencies) {
          const context = `${relative(root, file)} -> ${specifier}`;
          expect(specifier, context).not.toMatch(
            /^(?:next|react|react-dom|hono|server-only|client-only|@opennextjs\/[^/]+)(?:\/|$)/u,
          );
          if (name === "stripe") {
            expect(specifier, context).not.toMatch(/^@\/app(?:\/|$)/u);
            if (target) expect(isWithin(target, resolve(root, "apps/web/src/app")), context).toBe(false);
            continue;
          }
          if (name === "core") expect(specifier, context).not.toMatch(/^@prisma\//u);
          if (specifier.startsWith("@beutl/")) {
            expect(allowedPackages, context).toContain(specifier.split("/").slice(0, 2).join("/"));
          }
          if (specifier.startsWith(".") || specifier.startsWith("@beutl/")) {
            expect(target, context).toBeDefined();
            expect(allowedDirectories.some((allowed) => target && isWithin(target, allowed)), context)
              .toBe(true);
          }
        }
      }
    });

    it("keeps local module dependencies acyclic", () => {
      const visited = new Set<string>();
      const active: string[] = [];
      function visit(file: string): void {
        const start = active.indexOf(file);
        if (start !== -1) {
          throw new Error(`Module cycle: ${[...active.slice(start), file]
            .map((path) => relative(root, path)).join(" -> ")}`);
        }
        if (visited.has(file)) return;
        active.push(file);
        for (const { target } of imports.get(file) ?? []) {
          if (target && imports.has(target)) visit(target);
        }
        active.pop();
        visited.add(file);
      }
      for (const file of files) visit(file);
    });
  });
}
