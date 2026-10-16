// Vite (and so vitest) loads any file as a string with the `?raw` suffix. The
// repo has no @types/node (the Worker types and Node's would clash), so test
// fixtures are imported this way instead of read with node:fs.
declare module "*?raw" {
  const content: string;
  export default content;
}
