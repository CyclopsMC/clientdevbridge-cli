/**
 * The CLI's only version-aware logic (plan §4).
 *
 * The wire protocol is identical on every branch, so one CLI release drives every supported
 * Minecraft version. The single thing it has to know is which ClientDevBridge branch publishes
 * artifacts for a given Minecraft version.
 *
 * ClientDevBridge follows the Cyclops artifact convention — `cyclopscore-<mc>-<loader>`,
 * `flopper-<mc>-<loader>` — so artifacts are named `clientdevbridge-<mc>-<loader>`. Each entry
 * below therefore records the exact Minecraft versions a branch builds against.
 */
export interface ArtifactLine {
  /** The ClientDevBridge branch that publishes this line. */
  readonly branch: string;
  /** Minecraft versions this branch supports, most-preferred first. */
  readonly minecraftVersions: readonly string[];
  /** Matches Minecraft versions this branch also covers, for point releases published later. */
  readonly matches: RegExp;
}

export const GROUP = 'org.cyclops.clientdevbridge';

/**
 * Where the mod builds are published.
 *
 * A static Maven repository served by GitHub Pages out of CyclopsMC/ClientDevBridge-Releases. It
 * is deliberately not the CyclopsMC GitHub Packages Maven that the rest of the Cyclops artifacts
 * live in: GitHub Packages requires a token even for public packages, so every mod developer would
 * have to set credentials up before they could launch a client. This one is anonymous, which is
 * what lets a consumer repository need no setup at all.
 *
 * `CLIENTDEVBRIDGE_MAVEN_URL` overrides it, for a fork, a mirror, or a local server.
 */
export const RELEASES_MAVEN_URL = 'https://cyclopsmc.github.io/ClientDevBridge-Releases';

export function releasesMavenUrl(): string {
  const override = process.env['CLIENTDEVBRIDGE_MAVEN_URL'];
  return override === undefined || override.length === 0 ? RELEASES_MAVEN_URL : override;
}

// Order matters: the first matching line wins, so the LTS lines are listed before the trunk one.
// The LTS branch tracks a specific point release (26.1.x); the trunk branch is everything newer.
export const ARTIFACT_LINES: readonly ArtifactLine[] = [
  { branch: 'master-1.21-lts', minecraftVersions: ['1.21.1'], matches: /^1\.21(\.1)?$/ },
  { branch: 'master-26-lts', minecraftVersions: ['26.1.2'], matches: /^26\.1(\.\d+)?$/ },
  { branch: 'master-26', minecraftVersions: ['26.2'], matches: /^26\./ },
];

export function findLine(minecraftVersion: string): ArtifactLine | undefined {
  return ARTIFACT_LINES.find(
    (line) => line.minecraftVersions.includes(minecraftVersion) || line.matches.test(minecraftVersion),
  );
}

/**
 * The Maven coordinate of the bridge build a consumer on this Minecraft version needs.
 *
 * The artifact id embeds the Minecraft version rather than the branch name, matching how
 * CyclopsCore and Flopper name theirs.
 */
export function artifactId(minecraftVersion: string, loader: string): string {
  return `clientdevbridge-${minecraftVersion}-${loader}`;
}

export function coordinate(minecraftVersion: string, loader: string, version: string): string {
  return `${GROUP}:${artifactId(minecraftVersion, loader)}:${version}`;
}

/**
 * Explains, in the terms the user can act on, that no branch covers their Minecraft version.
 */
export function unsupportedMessage(minecraftVersion: string): string {
  const supported = ARTIFACT_LINES.map(
    (line) => `${line.branch} (${line.minecraftVersions.join(', ') || 'no released versions yet'})`,
  ).join('\n  ');
  return (
    `No ClientDevBridge build is mapped to Minecraft ${minecraftVersion}.\n` +
    `Known branches:\n  ${supported}\n` +
    'Pass --clientdevbridge-version to pin a build explicitly, or publish one with ' +
    "'./gradlew publishToMavenLocal' in a ClientDevBridge checkout on the matching branch."
  );
}

/**
 * The Groovy engine that powers `eval` and `wait --expr`.
 *
 * The mod reaches it through `javax.script`, so it is genuinely optional — but the Cyclops
 * publishing convention emits artifact-only POMs, so nothing declares it transitively and the
 * init script has to add it alongside the bridge itself.
 */
export const GROOVY_DEPENDENCY = 'org.apache.groovy:groovy-jsr223:5.1.1';
