import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Everything a session writes lives under `<projectDir>/.clientdevbridge/`, so that a
 * session is discoverable from a cold shell and disappears with the checkout.
 */
export interface BridgePaths {
  readonly projectDir: string;
  readonly root: string;
  readonly sessionFile: string;
  readonly gradleLog: string;
  readonly screenshots: string;
  readonly golden: string;
  readonly diffs: string;
  readonly initScript: string;
  readonly hotswapState: string;
  readonly optionsBackup: string;
}

export function resolvePaths(projectDir: string): BridgePaths {
  const resolved = path.resolve(projectDir);
  const root = path.join(resolved, '.clientdevbridge');
  return {
    projectDir: resolved,
    root,
    sessionFile: path.join(root, 'session.json'),
    gradleLog: path.join(root, 'gradle.log'),
    screenshots: path.join(root, 'screenshots'),
    golden: path.join(root, 'golden'),
    diffs: path.join(root, 'diffs'),
    initScript: path.join(root, 'init.gradle'),
    hotswapState: path.join(root, 'hotswap'),
    optionsBackup: path.join(root, 'options-backup.json'),
  };
}

export function ensureDirectories(paths: BridgePaths): void {
  for (const dir of [paths.root, paths.screenshots, paths.golden, paths.diffs, paths.hotswapState]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * The generated session state is disposable, but golden images are committed alongside the
 * consumer's code, so only the rest is ignored. Idempotent: re-running never duplicates the block.
 */
export function ensureGitignore(paths: BridgePaths): boolean {
  const gitignorePath = path.join(paths.projectDir, '.gitignore');
  const marker = '# ClientDevBridge session state (golden images are intentionally kept)';
  const block = [
    marker,
    '.clientdevbridge/*',
    '!.clientdevbridge/golden/',
    '',
  ].join('\n');

  let existing = '';
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf8');
    if (existing.includes(marker)) {
      return false;
    }
  }
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitignorePath, `${existing}${separator}${existing.length > 0 ? '\n' : ''}${block}`, 'utf8');
  return true;
}
