import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The version npm installed, read from the package's own manifest.
 *
 * Not a literal in the source: a literal is one more thing a release has to remember to bump, and
 * the one release that forgot shipped a package whose `--version` disagreed with the registry.
 *
 * The manifest is always one directory up from this file -- `dist/` sits directly under the
 * package root in a checkout and once installed alike -- which `version.test.ts` pins down.
 */
export function packageVersion(): string {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const version = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    // Printing a version is never worth failing a command over.
    return 'unknown';
  }
}
