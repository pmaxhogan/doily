// Types for Vite's import.meta.glob, used by fakes.ts to inline HTML fixtures.
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: string; import: string; eager: true },
  ): Record<string, unknown>;
}
