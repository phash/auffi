import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Runs one of the standalone vanilla-JS overlays from viewer/public/ against
 * the test's jsdom globals (document/window/navigator/localStorage). The
 * scripts are IIFEs with no exports, so executing them is the only way to
 * test their behavior; jsdom's readyState is "complete", which makes their
 * init() run synchronously on execution.
 */
export function execPublicScript(relPath: string): void {
  const src = readFileSync(resolve(__dirname, "../../public", relPath), "utf-8");
  new Function(src)();
}
