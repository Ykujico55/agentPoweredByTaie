import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSourceCheckout, projectRoot, run } from './setup-taie-source.mjs';

export async function buildTaieSource() {
  const checkout = await inspectSourceCheckout();
  const gradleUserHome = path.join(projectRoot, '.tools', 'gradle-user-home');
  await mkdir(gradleUserHome, { recursive: true });
  const metadataDirectory = path.join(projectRoot, '.tools', 'tai-e');
  await mkdir(metadataDirectory, { recursive: true });
  const toolchainMetadataPath = path.join(metadataDirectory, 'source-toolchain.json');
  const provenanceInit = path.join(metadataDirectory, 'source-provenance.init.gradle');
  // This read-only Gradle task records the compiler selected by the upstream build.
  // It changes no source files, compilation options, or Java toolchain selection.
  await writeFile(provenanceInit, `allprojects { p ->
    if (p.projectDir.canonicalPath == new File(System.getenv('TAIE_SOURCE_DIRECTORY')).canonicalPath) {
      p.tasks.register('taieAgentBuildMetadata') {
        doLast {
          def metadata = p.tasks.named('compileJava').get().javaCompiler.get().metadata
          def result = [javaCompilerHome: metadata.installationPath.asFile.absolutePath,
            javaCompilerVersion: metadata.javaRuntimeVersion,
            javaCompilerVendor: metadata.vendor.toString(),
            javaLanguageVersion: metadata.languageVersion.asInt(),
            gradleVersion: p.gradle.gradleVersion, projectVersion: p.version.toString()]
          new File(System.getenv('TAIE_BUILD_TOOLCHAIN_METADATA')).text = groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(result))
        }
      }
    }
  }\n`);
  const javaHome = process.env.TAIE_JAVA_HOME || process.env.JAVA_HOME;
  const env = { ...process.env, GRADLE_USER_HOME: gradleUserHome,
    TAIE_SOURCE_DIRECTORY: checkout.directory, TAIE_BUILD_TOOLCHAIN_METADATA: toolchainMetadataPath };
  if (javaHome) env.JAVA_HOME = javaHome;
  console.log(`Building Tai-e from ${checkout.directory}; HEAD ${checkout.head}; dirty ${checkout.dirty}`);
  console.log(`Gradle cache: ${gradleUserHome}`);
  const autoDownloadJdk = process.env.TAIE_AUTO_DOWNLOAD_JDK === 'true';
  console.log(`Upstream Java toolchain: 17; project-local automatic JDK provisioning: ${autoDownloadJdk}`);
  // The wrapper's command text is constant. Project paths are supplied as cwd/env.
  // Gradle installs any provisioned toolchain into this project's GRADLE_USER_HOME.
  // Set TAIE_AUTO_DOWNLOAD_JDK=true to permit downloading a missing JDK 17.
  const gradleArguments = `gradlew.bat fatJar taieAgentBuildMetadata --no-daemon --no-configuration-cache --console=plain -I ../../.tools/tai-e/source-provenance.init.gradle -Porg.gradle.java.installations.auto-download=${autoDownloadJdk}`;
  if (process.platform === 'win32') {
    await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', gradleArguments],
      { cwd: checkout.directory, env, inherit: true });
  } else {
    await run('sh', ['./gradlew', 'fatJar', 'taieAgentBuildMetadata', '--no-daemon', '--no-configuration-cache', '--console=plain',
      '-I', '../../.tools/tai-e/source-provenance.init.gradle', `-Porg.gradle.java.installations.auto-download=${autoDownloadJdk}`],
      { cwd: checkout.directory, env, inherit: true });
  }
  const buildDirectory = path.join(checkout.directory, 'build');
  const candidates = (await readdir(buildDirectory)).filter((name) => /^tai-e-all-.*\.jar$/.test(name));
  const toolchain = JSON.parse(await readFile(toolchainMetadataPath, 'utf8'));
  const actualVersion = toolchain.projectVersion;
  if (typeof actualVersion !== 'string' || !/^[A-Za-z0-9._+-]+$/.test(actualVersion))
    throw new Error('Could not determine the resolved Gradle project version.');
  const expectedName = `tai-e-all-${actualVersion}.jar`;
  if (!candidates.includes(expectedName)) throw new Error(`Expected ${expectedName} in ${buildDirectory}; found ${candidates.join(', ') || 'none'}.`);
  const jarPath = path.join(buildDirectory, expectedName);
  const sha256 = createHash('sha256').update(await readFile(jarPath)).digest('hex');
  const java = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  // Tai-e's help command omits its version banner. Read its embedded build properties
  // with the JDK jar tool's listing and an ephemeral Java source launched below.
  const metadataProbe = path.join(metadataDirectory, 'ReadTaieBuildInfo.java');
  await writeFile(metadataProbe, `import java.util.*; import java.util.jar.*; public class ReadTaieBuildInfo { public static void main(String[] args) throws Exception { try (JarFile jar = new JarFile(args[0])) { Properties p = new Properties(); var e = jar.getJarEntry("META-INF/tai-e-build.properties"); if (e == null) throw new IllegalStateException("Missing Tai-e build properties"); try (var in = jar.getInputStream(e)) { p.load(in); } System.out.println(p.getProperty("version")); System.out.println(p.getProperty("commit")); } } }\n`);
  const metadata = (await run(java, [metadataProbe, jarPath], { env })).stdout.split(/\r?\n/);
  if (metadata[0] !== actualVersion || metadata[1] !== checkout.head)
    throw new Error(`Unexpected source JAR build metadata: ${metadata.join(' / ')}.`);
  await run(java, ['-jar', jarPath, '-h'], { env });
  const afterBuild = await inspectSourceCheckout();
  if (afterBuild.head !== checkout.head || afterBuild.status !== checkout.status)
    throw new Error('Tai-e source checkout changed while building; no validated build manifest was written.');
  const manifest = {
    schemaVersion: 1, jarPath, sha256, version: metadata[0], upstream: checkout.lock.upstream,
    origin: checkout.origin, upstreamRemote: checkout.upstreamRemote ?? null,
    sourceDir: checkout.directory, head: checkout.head, baseTag: checkout.lock.tag,
    baseCommit: checkout.lock.commit, dirty: checkout.dirty, sourceStatus: checkout.status,
    javaHome: javaHome || null, gradleUserHome, autoDownloadJdk,
    toolchain,
    buildCommand: process.platform === 'win32' ? gradleArguments : `./gradlew fatJar taieAgentBuildMetadata --no-daemon --no-configuration-cache --console=plain -I ../../.tools/tai-e/source-provenance.init.gradle -Porg.gradle.java.installations.auto-download=${autoDownloadJdk}`,
    builtAt: new Date().toISOString(),
  };
  const manifestPath = path.join(metadataDirectory, 'source-build.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Tai-e source JAR verified: ${jarPath}`);
  console.log(`SHA-256: ${sha256}`);
  console.log(`Build provenance: ${manifestPath}`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildTaieSource().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
