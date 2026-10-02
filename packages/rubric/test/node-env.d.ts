// The rubric package has no Node types (its source runs in the browser too). The invariants test reads the golden
// files with these few calls; vitest runs it under Node.
declare module "node:fs" {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: "utf8"): string;
}
declare module "node:path" {
  export function resolve(...parts: string[]): string;
}
interface ImportMeta {
  readonly dirname: string;
}
