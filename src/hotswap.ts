import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliError } from './errors.js';
import { resolveJavaHome } from './java.js';

export interface ClassFile {
  readonly binaryName: string;
  readonly file: string;
  readonly hash: string;
}

/**
 * Finds every compiled class under a project's build output, keyed by its binary name.
 *
 * Both loaders compile the shared sources into each loader module, so the same binary name can
 * appear more than once; the first one found wins, which matches what the running JVM loaded.
 */
export function scanClasses(projectDir: string): Map<string, ClassFile> {
  const classes = new Map<string, ClassFile>();
  const roots: string[] = [];

  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(projectDir, entry.name, 'build', 'classes', 'java', 'main');
    if (fs.existsSync(candidate)) {
      roots.push(candidate);
    }
  }
  const single = path.join(projectDir, 'build', 'classes', 'java', 'main');
  if (fs.existsSync(single)) {
    roots.push(single);
  }

  for (const root of roots) {
    for (const file of walkClassFiles(root)) {
      const binaryName = path
        .relative(root, file)
        .replace(/\.class$/, '')
        .split(path.sep)
        .join('.');
      if (!classes.has(binaryName)) {
        classes.set(binaryName, { binaryName, file, hash: hashFile(file) });
      }
    }
  }
  return classes;
}

function* walkClassFiles(directory: string): Generator<string> {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkClassFiles(full);
    } else if (entry.name.endsWith('.class')) {
      yield full;
    }
  }
}

function hashFile(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export interface SnapshotFile {
  version: 1;
  takenAt: string;
  classes: Record<string, string>;
}

export function readPreviousSnapshot(stateDir: string): SnapshotFile | null {
  const file = path.join(stateDir, 'classes.json');
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SnapshotFile;
  } catch {
    return null;
  }
}

export function writeSnapshot(stateDir: string, classes: Map<string, ClassFile>): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const record: Record<string, string> = {};
  for (const [name, entry] of classes) {
    record[name] = entry.hash;
  }
  const snapshot: SnapshotFile = { version: 1, takenAt: new Date().toISOString(), classes: record };
  fs.writeFileSync(path.join(stateDir, 'classes.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

/**
 * Which classes changed since the last hotswap or start.
 *
 * With no previous snapshot nothing is reported as changed: swapping every class in the project
 * on the first run would be slow and would mostly fail, and the useful baseline is "since I last
 * looked", not "since the JVM started".
 */
export function diffClasses(
  previous: SnapshotFile | null,
  current: Map<string, ClassFile>,
): { changed: ClassFile[]; added: string[] } {
  if (previous === null) {
    return { changed: [], added: [] };
  }
  const changed: ClassFile[] = [];
  const added: string[] = [];
  for (const [name, entry] of current) {
    const before = previous.classes[name];
    if (before === undefined) {
      added.push(name);
    } else if (before !== entry.hash) {
      changed.push(entry);
    }
  }
  return { changed, added };
}

export interface SwapResult {
  readonly swapped: string[];
  /** Classes the JVM refused to redefine, which is what actually forces a restart. */
  readonly failed: { name: string; reason: string }[];
  /**
   * Classes not loaded in the client yet. These are not failures: the new definition is simply
   * picked up the first time the class is used, so reporting them as needing a restart would send
   * the caller off to do something pointless.
   */
  readonly pending: string[];
  readonly needsRestart: boolean;
}

/**
 * Redefines classes in the running client over JDWP.
 *
 * The JDI classes live in the `jdk.jdi` module, which is not on a plain `java` command's module
 * path, so rather than shipping a Java helper jar the swap is driven by a small Java source file
 * compiled and run on demand with `java --add-modules jdk.jdi`. That keeps the npm package free of
 * a compiled Java artifact, which would otherwise have to be rebuilt and re-signed on every release.
 */
export function redefineClasses(jdwpPort: number, classes: readonly ClassFile[]): SwapResult {
  if (classes.length === 0) {
    return { swapped: [], failed: [], pending: [], needsRestart: false };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clientdevbridge-hotswap-'));
  try {
    const helper = path.join(workDir, 'HotSwap.java');
    fs.writeFileSync(helper, HOT_SWAP_SOURCE, 'utf8');

    const payload = path.join(workDir, 'classes.txt');
    fs.writeFileSync(payload, classes.map((entry) => `${entry.binaryName}\t${entry.file}`).join('\n'), 'utf8');

    const result = spawnSync(
      javaExecutable(),
      ['--add-modules', 'jdk.jdi', helper, String(jdwpPort), payload],
      { encoding: 'utf8', timeout: 120_000 },
    );

    if (result.error !== undefined) {
      throw new CliError(`Could not run the hotswap helper: ${result.error.message}`, 2);
    }
    const stdout = result.stdout ?? '';
    const swapped: string[] = [];
    const failed: { name: string; reason: string }[] = [];
    const pending: string[] = [];
    for (const rawLine of stdout.split('\n')) {
      const okMatch = /^OK\t(.+)$/.exec(rawLine);
      if (okMatch !== null) {
        swapped.push(okMatch[1] as string);
        continue;
      }
      const pendingMatch = /^PENDING\t(.+)$/.exec(rawLine);
      if (pendingMatch !== null) {
        pending.push(pendingMatch[1] as string);
        continue;
      }
      const failMatch = /^FAIL\t([^\t]+)\t(.*)$/.exec(rawLine);
      if (failMatch !== null) {
        failed.push({ name: failMatch[1] as string, reason: failMatch[2] as string });
      }
    }

    if (swapped.length === 0 && failed.length === 0 && pending.length === 0) {
      throw new CliError(
        `The hotswap helper produced no result.\n${result.stderr ?? ''}`,
        2,
        `Check that the client was started with --jdwp-port ${jdwpPort}.`,
      );
    }
    return { swapped, failed, pending, needsRestart: failed.length > 0 };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function javaExecutable(): string {
  const javaHome = process.env['JAVA_HOME'];
  if (javaHome !== undefined && javaHome.length > 0) {
    const candidate = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'java';
}

/** True when the running JVM is a JetBrains Runtime, which can redefine far more than stock HotSpot. */
export function detectJetBrainsRuntime(): boolean {
  try {
    const output =
      spawnSync(javaExecutable(), ['-version'], { encoding: 'utf8' }).stderr ?? '';
    return /jetbrains/i.test(output) || /JBR/.test(output);
  } catch {
    return false;
  }
}

export function gradleCompile(projectDir: string, gradleWrapper: string, javaVersion = 21): string {
  // Same reason as in the launcher: Gradle runs on JAVA_HOME, and the loader plugins refuse to
  // configure at all when that JDK is older than the Minecraft version needs.
  const java = resolveJavaHome(javaVersion);
  try {
    return execFileSync(gradleWrapper, ['compileJava', '--console=plain', '--no-daemon'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 600_000,
      env: { ...process.env, ...(java.javaHome === null ? {} : { JAVA_HOME: java.javaHome }) },
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new CliError(
      `Compilation failed, so nothing was swapped.\n${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      1,
    );
  }
}

/**
 * A single-file Java program run with `java HotSwap.java`, which the launcher compiles in memory.
 */
const HOT_SWAP_SOURCE = `import com.sun.jdi.VirtualMachine;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.Bootstrap;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Attaches to the running client and redefines the classes listed in the given file.
 *
 * Each class is redefined on its own, so one rejected class (a schema change HotSpot cannot apply)
 * does not stop the rest from going through.
 */
public class HotSwap {

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);
        List<String[]> entries = new ArrayList<>();
        for (String line : Files.readAllLines(Path.of(args[1]))) {
            if (!line.isBlank()) {
                entries.add(line.split("\\\\t", 2));
            }
        }

        AttachingConnector connector = null;
        for (Connector candidate : Bootstrap.virtualMachineManager().attachingConnectors()) {
            if ("com.sun.jdi.SocketAttach".equals(candidate.name())) {
                connector = (AttachingConnector) candidate;
                break;
            }
        }
        if (connector == null) {
            System.err.println("No SocketAttach connector is available in this JDK.");
            System.exit(2);
        }

        Map<String, Connector.Argument> arguments = connector.defaultArguments();
        arguments.get("hostname").setValue("127.0.0.1");
        arguments.get("port").setValue(String.valueOf(port));

        VirtualMachine vm;
        try {
            vm = connector.attach(arguments);
        } catch (Exception e) {
            System.err.println("Could not attach to 127.0.0.1:" + port + ": " + e.getMessage());
            System.exit(2);
            return;
        }

        try {
            if (!vm.canRedefineClasses()) {
                System.err.println("This JVM does not support class redefinition.");
                System.exit(2);
            }
            for (String[] entry : entries) {
                String binaryName = entry[0];
                Path classFile = Path.of(entry[1]);
                List<ReferenceType> loaded = vm.classesByName(binaryName);
                if (loaded.isEmpty()) {
                    // Not loaded yet: the new definition is picked up on first use, so this is
                    // not a failure and must not send the caller off to restart.
                    System.out.println("PENDING\\t" + binaryName);
                    continue;
                }
                byte[] bytes = Files.readAllBytes(classFile);
                Map<ReferenceType, byte[]> redefinition = new HashMap<>();
                for (ReferenceType type : loaded) {
                    redefinition.put(type, bytes);
                }
                try {
                    vm.redefineClasses(redefinition);
                    System.out.println("OK\\t" + binaryName);
                } catch (UnsupportedOperationException e) {
                    System.out.println("FAIL\\t" + binaryName + "\\tschema change: " + e.getMessage());
                } catch (Exception e) {
                    System.out.println("FAIL\\t" + binaryName + "\\t" + e.getClass().getSimpleName() + ": " + e.getMessage());
                }
            }
        } finally {
            vm.dispose();
        }
    }
}
`;
