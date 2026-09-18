import { execFile } from "node:child_process";

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Spawns a real OS process to open the user's browser — no meaningful way to
// unit test this beyond re-asserting the platform switch, so it's excluded
// from the coverage report rather than padded with a low-value mock test.
/* node:coverage disable */
export function openInBrowser(target: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  execFile(opener, [target]);
}
/* node:coverage enable */
