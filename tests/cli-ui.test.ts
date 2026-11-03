import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.join(repoRoot, '.taie-agent', 'cli-ui-tests');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function workspace(run: (directory: string) => Promise<void>): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  const directory = await mkdtemp(path.join(workspaceRoot, 'workspace-'));
  try {
    await run(directory);
  } finally {
    // Check the actual resolved target before recursively deleting our fixture.
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), await realpath(workspaceRoot));
    assert.match(path.basename(resolved), /^workspace-/);
    await rm(directory, { recursive: true, force: true });
  }
}

function runCli(args: string[], lines: string[], directory: string, timeoutMs = 20_000): Promise<CliResult> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete env[key];
  }
  delete env.TAIE_AGENT_PROVIDER;
  delete env.TAIE_AGENT_MODEL;
  delete env.TAIE_JAR;
  // Local commands must work without a usable JDK or provider credentials.
  env.TAIE_JAVA_HOME = path.join(directory, 'no-jdk-installed');
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { stdout += text; });
    child.stderr.on('data', (text: string) => { stderr += text; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', exitCode => { clearTimeout(timer); resolve({ exitCode, stdout, stderr, timedOut }); });
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
    // Submit every line before the CLI has printed its first prompt. This
    // exercises the actual console input queue rather than a parser mock.
    child.stdin.end(lines.length ? `${lines.join('\n')}\n` : '');
  });
}

function panels(stderr: string): Record<string, string>[] {
  return stderr.split('会话配置（/set <设置名> <值>）').slice(1).map(panel => {
    const values: Record<string, string> = {};
    for (const match of panel.matchAll(/^--([a-z-]+)\s+([^\r\n]*)/gm)) values[match[1]] = match[2].trim();
    return values;
  });
}

function assertLocal(result: CliResult, exitCode = 0): void {
  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.exitCode, exitCode, result.stderr);
  assert.equal(result.stdout, '', 'Local commands must not produce model text or task results');
  assert.doesNotMatch(result.stderr, /\[taie-agent\] (?:Tool:|Host check:)|\[修复选择\]/);
}

async function assertOnlyConfig(directory: string, original?: string): Promise<void> {
  assert.deepEqual((await readdir(directory)).sort(), original === undefined ? [] : ['taie-agent.json'],
    'Local UI commands must not create analysis, agent, session, or configuration files');
  if (original !== undefined) assert.equal(await readFile(path.join(directory, 'taie-agent.json'), 'utf8'), original);
}

test('pretyped chat commands update effective settings without initializing an agent or analyzer', { timeout: 30_000 }, async () => {
  await workspace(async directory => {
    const project = path.join(directory, 'empty project');
    const result = await runCli(['chat', '--project', project], [
      '/config', '/repair off', '/analysis off', '/set max-repairs 3',
      '/set analyses null-pointer,dead-code', '/config', '/exit',
    ], directory);
    assertLocal(result);
    const displayed = panels(result.stderr);
    assert.equal(displayed.length, 3);
    assert.equal(displayed[0]['repair-mode'], 'ask');
    assert.equal(displayed[0].analysis, 'on');
    assert.equal(displayed[0]['max-repairs'], '2');
    const final = displayed.at(-1)!;
    assert.equal(final.project, JSON.stringify(project));
    assert.equal(final['repair-mode'], 'off');
    assert.equal(final.analysis, 'off');
    assert.equal(final['max-repairs'], '3');
    assert.deepEqual(JSON.parse(final.analyses), ['null-pointer', 'dead-code']);
    assert.match(result.stderr, /你 \[检测关 · 修复关闭\]/);
    await assertOnlyConfig(project);
  });
});

test('invalid settings preserve old values and do not prevent later local commands', { timeout: 30_000 }, async () => {
  await workspace(async directory => {
    const project = path.join(directory, 'invalid settings');
    const result = await runCli(['chat', '--project', project], [
      '/set max-repairs nope', '/config', '/set analyses dead-code,not-a-detector', '/config',
      '/set max-repairs 4', '/repair auto', '/config', '/exit',
    ], directory);
    // A rejected local command records an unsuccessful process status while
    // leaving the input loop alive to accept corrections.
    assertLocal(result, 1);
    assert.match(result.stderr, /--max-repairs:.*安全整数/);
    assert.match(result.stderr, /未知检测器 not-a-detector/);
    const displayed = panels(result.stderr);
    assert.equal(displayed.length, 4);
    assert.equal(displayed[1]['max-repairs'], '2');
    assert.equal(displayed[2]['max-repairs'], '2');
    assert.deepEqual(JSON.parse(displayed[2].analyses), JSON.parse(displayed[0].analyses));
    assert.equal(displayed.at(-1)!['max-repairs'], '4');
    assert.equal(displayed.at(-1)!['repair-mode'], 'auto');
    await assertOnlyConfig(project);
  });
});

test('switching projects loads target settings while retaining an omitted backend and detector selection', { timeout: 30_000 }, async () => {
  await workspace(async directory => {
    const original = path.join(directory, 'original project');
    const target = path.join(directory, 'target project');
    await Promise.all([mkdir(original), mkdir(target)]);
    const originalConfig = JSON.stringify({ jarPath: 'tools/original.jar', analyses: ['null-pointer', 'dead-code'],
      sourceRoots: ['original-src'], mainClass: 'original.Main' }, null, 2);
    const targetConfig = JSON.stringify({ sourceRoots: ['target-src'], mainClass: 'target.Main',
      classpath: ['lib/target.jar'], timeoutMs: 4321 }, null, 2);
    await Promise.all([writeFile(path.join(original, 'taie-agent.json'), originalConfig),
      writeFile(path.join(target, 'taie-agent.json'), targetConfig)]);
    const result = await runCli(['chat', '--project', original], [
      `/set project "${target}"`, '/config', '/exit',
    ], directory);
    assertLocal(result);
    const final = panels(result.stderr).at(-1)!;
    assert.equal(JSON.parse(final.project), target);
    assert.equal(JSON.parse(final.jar), path.join(original, 'tools', 'original.jar'));
    assert.deepEqual(JSON.parse(final.analyses), ['null-pointer', 'dead-code']);
    assert.equal(final['main-class'], 'target.Main');
    assert.equal(final['analysis-timeout'], '4321');
    assert.deepEqual(JSON.parse(final['source-root']), [path.join(target, 'target-src')]);
    assert.deepEqual(JSON.parse(final.classpath), [path.join(target, 'lib', 'target.jar')]);
    assert.match(result.stderr, /已切换项目并加载其配置/);
    await assertOnlyConfig(original, originalConfig);
    await assertOnlyConfig(target, targetConfig);
  });
});

test('an explicit target backend and policy take precedence when switching projects', { timeout: 30_000 }, async () => {
  await workspace(async directory => {
    const original = path.join(directory, 'origin');
    const target = path.join(directory, 'target with policy');
    await Promise.all([mkdir(original), mkdir(target)]);
    const originalConfig = JSON.stringify({ jarPath: 'old.jar', analyses: ['dead-code'] });
    const targetConfig = JSON.stringify({ jarPath: 'engine/target.jar', analyses: ['taint'], sourceRoots: ['code'],
      mainClass: 'target.Entry', taintConfig: 'policy/taint.yml', taintImplicitEntries: false });
    await Promise.all([writeFile(path.join(original, 'taie-agent.json'), originalConfig),
      writeFile(path.join(target, 'taie-agent.json'), targetConfig)]);
    const result = await runCli(['chat', '--project', original], [
      `/set project "${target}"`, '/config', '/exit',
    ], directory);
    assertLocal(result);
    const final = panels(result.stderr).at(-1)!;
    assert.equal(JSON.parse(final.project), target);
    assert.equal(JSON.parse(final.jar), path.join(target, 'engine', 'target.jar'));
    assert.deepEqual(JSON.parse(final.analyses), ['taint']);
    assert.equal(final['main-class'], 'target.Entry');
    assert.equal(JSON.parse(final['taint-config']), path.join(target, 'policy', 'taint.yml'));
    assert.equal(final['taint-implicit-entries'], 'off');
    await assertOnlyConfig(original, originalConfig);
    await assertOnlyConfig(target, targetConfig);
  });
});

test('--help documents configurable settings, launch flags, and local chat commands without starting work', { timeout: 30_000 }, async () => {
  await workspace(async directory => {
    const result = await runCli(['--help'], [], directory);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0, result.stderr);
    for (const flag of ['project', 'build-backend', 'provider', 'model', 'repair-mode', 'analysis', 'max-repairs', 'max-turns',
      'timeout', 'analysis-timeout', 'analyses', 'source-root', 'classpath', 'main-class', 'taint-config',
      'taint-implicit-entries', 'java-version', 'jar', 'json', 'prompt', 'prompt-file', 'skip-taie', 'no-repair', 'help',
      'dependency-network', 'include-dependencies']) {
      assert.match(result.stdout, new RegExp(`^\\s+--${flag}(?=\\s|$)`, 'm'), flag);
    }
    for (const command of ['/config', '/settings', '/set', '/repair', '/analysis', '/check', '/help', '/exit']) {
      assert.ok(result.stdout.includes(command), command);
    }
    assert.match(result.stdout, /repair-mode=ask/);
    assert.match(result.stdout, /first message only/);
    assert.doesNotMatch(result.stdout, /host checks:|Tool:|\bverified;/);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('--include-dependencies is rejected outside run/chat/check-maven before starting work', { timeout: 30_000 }, async () => {
  await workspace(async directory => {
    for (const command of ['analyze', 'doctor']) {
      const result = await runCli([command, '--project', directory, '--include-dependencies'], [], directory);
      assertLocal(result, 1);
      assert.match(result.stderr, /--include-dependencies applies only to run\/chat or check-maven/);
      await assertOnlyConfig(directory);
    }
  });
});

test('chat check runs without credentials, keeps overrides, and returns stage evidence in JSON', { timeout: 30_000 }, async () => {
  await workspace(async directory => {
    const project = path.join(directory, 'manual check');
    const result = await runCli(['chat', '--project', project, '--json', '--jar', path.join(directory, 'missing.jar'),
      '--include-dependencies', '--dependency-network', 'off'], [
      '/analysis off', '/repair auto', '--skip-taie', '/check', '/config', '/exit',
    ], directory);
    assert.equal(result.timedOut, false, result.stderr);
    assert.equal(result.exitCode, 1, result.stderr);
    const check = JSON.parse(result.stdout);
    assert.equal(check.backend, 'javac');
    assert.equal(check.status, 'analysis_failed');
    assert.equal(check.stages.build, 'not_run');
    assert.equal(check.stages.test.status, 'not_run');
    assert.equal(check.stages.review, 'not_run');
    assert.match(result.stderr, /下一条任务覆盖：跳过检测/);
    assert.doesNotMatch(result.stderr, /Tool:|Host check:|\[修复选择\]|No credentials/);
    assert.deepEqual(await readdir(path.join(project, '.taie-agent')), ['runs']);
    assert.deepEqual(JSON.parse(await readFile(check.reportPath, 'utf8')), check);
    const readable = await readFile(check.humanReportPath, 'utf8');
    assert.match(readable, /analysis_failed/);
    assert.ok(result.stderr.includes(check.humanReportPath));
    assert.equal(JSON.parse(await readFile(check.backendReportPath, 'utf8')).schemaVersion, 2);
  });
});

test('Maven selection reaches model authentication without starting a check or falling back to javac', { timeout: 90_000 }, async () => {
  await workspace(async directory => {
    const project = path.join(directory, 'maven selected');
    const result = await runCli(['chat', '--project', project, '--build-backend', 'maven-docker'], [
      'Write a Java class', '/config', '/set build-backend javac', '/config', '/exit',
    ], directory, 60_000); // This case loads the real Pi SDK; local-only commands retain their 20s bound.
    assertLocal(result, 1);
    assert.match(result.stderr, /No credentials for deepseek/);
    assert.doesNotMatch(result.stderr, /maven-docker 当前仅支持 \/check/);
    assert.equal(panels(result.stderr)[0]['build-backend'], 'maven-docker');
    assert.equal(panels(result.stderr).at(-1)!['build-backend'], 'javac');
    assert.deepEqual(await readdir(path.join(project, '.taie-agent')), ['agent-runs']);
  });
});

test('run accepts Maven settings and still validates the task before creating a model session', { timeout: 30_000 }, async () => {
  await workspace(async directory => {
    const result = await runCli(['run', '--project', directory, '--build-backend', 'maven-docker',
      '--dependency-network', 'off', '--include-dependencies'], [], directory);
    assertLocal(result, 1);
    assert.match(result.stderr, /run requires --prompt/);
    await assertOnlyConfig(directory);
  });
});

test('check-maven writes a readable failure report while preserving its original JSON output', { timeout: 30_000 }, async () => {
  await workspace(async directory => {
    // An unsupported JDK target fails before Docker access, so this is a host-only check.
    const result = await runCli(['check-maven', '--project', directory, '--java-version', '8'], [], directory);
    assert.equal(result.timedOut, false, result.stderr);
    assert.equal(result.exitCode, 1);
    const backend = JSON.parse(result.stdout);
    assert.equal(backend.schemaVersion, 2);
    assert.equal(backend.status, 'error');
    assert.deepEqual(JSON.parse(await readFile(backend.reportPath, 'utf8')), backend);
    const check = JSON.parse(await readFile(path.join(backend.runDir, 'check.json'), 'utf8'));
    assert.equal(check.status, 'error');
    assert.equal(check.stages.build, 'not_run');
    assert.ok(result.stderr.includes(check.humanReportPath));
    assert.match(await readFile(check.humanReportPath, 'utf8'), /JDK 17/);
    assert.deepEqual((await readdir(backend.runDir)).sort(), ['check.json', 'check.md', 'report.json']);
  });
});

test('project switching loads build settings without carrying network permission to another project', { timeout: 30_000 }, async () => {
  await workspace(async directory => {
    const original = path.join(directory, 'maven');
    const target = path.join(directory, 'default');
    await mkdir(original);
    const originalConfig = JSON.stringify({ buildBackend: 'maven-docker', dependencyNetwork: true, includeDependencies: true });
    await writeFile(path.join(original, 'taie-agent.json'), originalConfig);
    const result = await runCli(['chat', '--project', original], [
      `/set project "${target}"`, '/config', '/exit',
    ], directory);
    assertLocal(result);
    const displayed = panels(result.stderr);
    assert.equal(displayed[0]['build-backend'], 'maven-docker');
    assert.equal(displayed[0]['dependency-network'], 'on');
    assert.equal(displayed.at(-1)!['build-backend'], 'javac');
    assert.equal(displayed.at(-1)!['dependency-network'], 'off');
    assert.equal(displayed.at(-1)!['include-dependencies'], 'off');
    await assertOnlyConfig(original, originalConfig);
    await assertOnlyConfig(target);
  });
});
