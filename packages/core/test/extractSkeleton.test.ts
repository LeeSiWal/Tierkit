import { describe, expect, it } from "vitest";
import { extractSkeleton } from "../src/context-compression/extractSkeleton.js";

describe("extractSkeleton", () => {
  it("extracts ts imports/exports/functions/classes/interfaces/types/const", () => {
    const src = [
      "import { foo } from './foo'",
      "import type { Bar } from './bar'",
      "export { foo as bar }",
      "export const x = 42",
      "export function hello() {",
      "  return 'hi'",
      "}",
      "export class Greeter {",
      "  greet() { return 'g' }",
      "}",
      "interface Opts { a: number }",
      "type Id = string",
    ].join("\n");
    const symbols = extractSkeleton(src, "ts");
    const kinds = symbols.map((s) => s.kind);
    expect(kinds).toContain("import");
    expect(kinds).toContain("export");
    expect(kinds).toContain("function");
    expect(kinds).toContain("class");
    expect(kinds).toContain("interface");
    expect(kinds).toContain("type");
    expect(kinds).toContain("const");
  });

  it("extracts tsx fragments same as ts", () => {
    const src = "import React from 'react'\nexport function Button() { return <button/> }";
    const symbols = extractSkeleton(src, "tsx");
    expect(symbols.find((s) => s.kind === "import")?.text).toContain("import React");
    expect(symbols.find((s) => s.kind === "function")?.text).toContain("Button");
  });

  it("extracts python imports + def + class", () => {
    const src = [
      "import os",
      "from typing import List",
      "def add(a, b):",
      "    return a + b",
      "class Foo:",
      "    pass",
    ].join("\n");
    const symbols = extractSkeleton(src, "py");
    expect(symbols.some((s) => s.kind === "import" && s.text.includes("import os"))).toBe(true);
    expect(symbols.some((s) => s.kind === "import" && s.text.includes("from typing"))).toBe(true);
    expect(symbols.some((s) => s.kind === "function" && s.text.includes("def add"))).toBe(true);
    expect(symbols.some((s) => s.kind === "class" && s.text.includes("class Foo"))).toBe(true);
  });

  it("extracts go imports + func + type", () => {
    const src = [
      'import "fmt"',
      "func Hello() string { return \"hi\" }",
      "type Foo struct { X int }",
    ].join("\n");
    const symbols = extractSkeleton(src, "go");
    expect(symbols.some((s) => s.kind === "import")).toBe(true);
    expect(symbols.some((s) => s.kind === "function" && s.text.includes("Hello"))).toBe(true);
    expect(symbols.some((s) => s.kind === "type" && s.text.includes("Foo"))).toBe(true);
  });

  it("extracts rust use + fn + struct", () => {
    const src = [
      "use std::collections::HashMap;",
      "fn hello() -> String { String::from(\"hi\") }",
      "struct Foo { x: i32 }",
    ].join("\n");
    const symbols = extractSkeleton(src, "rs");
    expect(symbols.some((s) => s.kind === "import")).toBe(true);
    expect(symbols.some((s) => s.kind === "function" && s.text.includes("hello"))).toBe(true);
    expect(symbols.some((s) => s.kind === "type" && s.text.includes("struct Foo"))).toBe(true);
  });

  it("falls back to imports only for unknown extensions", () => {
    const src = ['import "weird"', "do_something()", 'import "other"'].join("\n");
    const symbols = extractSkeleton(src, "other");
    expect(symbols.every((s) => s.kind === "import")).toBe(true);
    expect(symbols).toHaveLength(2);
  });

  it("records 1-based line numbers", () => {
    const src = ["// line 1", "import { x } from 'y'", "// line 3"].join("\n");
    const symbols = extractSkeleton(src, "ts");
    expect(symbols[0]?.line).toBe(2);
  });
});
