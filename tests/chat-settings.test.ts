import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { applySetting, CHAT_SETTING_REGISTRY, parseChatCommand, renderSettings, type ChatSettings } from '../src/chat-settings.ts';
import { DEFAULT_ANALYSES, getDefaultJarPath } from '../src/taie.ts';

function settings(): ChatSettings {
  return {
    projectDir: path.resolve('example-project'), config: {}, provider: 'deepseek', model: 'deepseek-v4-flash',
    repairMode: 'ask', analysisEnabled: true, maxRepairs: 2, maxTurns: 30, timeoutMs: 600_000, json: false,
  };
}

test('the settings registry covers every configurable CLI setting exactly once', () => {
  const keys = ['project', 'build-backend', 'dependency-network', 'baseline', 'include-dependencies', 'provider', 'model', 'repair-mode', 'analysis', 'max-repairs', 'max-turns',
    'timeout', 'analysis-timeout', 'analyses', 'source-root', 'classpath', 'main-class', 'taint-config',
    'taint-implicit-entries', 'java-version', 'jar', 'json'];
  assert.deepEqual(CHAT_SETTING_REGISTRY.map(entry => entry.key), keys);
  assert.equal(new Set(CHAT_SETTING_REGISTRY.map(entry => entry.key)).size, keys.length);
  for (const entry of CHAT_SETTING_REGISTRY) {
    assert.equal(entry.flag, `--${entry.key}`);
    assert.ok(entry.usage && entry.description);
    assert.ok(renderSettings(settings()).includes(entry.flag));
  }
});

test('applying a setting returns a detached object and preserves unrelated analysis configuration', () => {
  const before = settings();
  before.config = { sourceRoots: ['src'], classpath: ['lib/old.jar'], analyses: ['dead-code'], mainClass: 'example.Main' };
  const snapshot = structuredClone(before);
  const changed = applySetting(before, '--model', 'new-model');
  assert.equal(changed.model, 'new-model');
  assert.deepEqual(before, snapshot);
  assert.notEqual(changed, before);
  assert.notEqual(changed.config, before.config);
  changed.config.sourceRoots!.push('another');
  changed.config.classpath!.push('extra.jar');
  assert.deepEqual(before, snapshot);
  assert.equal(changed.config.mainClass, 'example.Main');
});

test('scalar settings accept valid choices and integer boundaries while rejecting invalid values', () => {
  const cases: [string, string, (result: ChatSettings) => unknown, unknown][] = [
    ['build-backend', 'maven-docker', result => result.config.buildBackend, 'maven-docker'],
    ['dependency-network', 'on', result => result.config.dependencyNetwork, true],
    ['baseline', 'off', result => result.config.baselineEnabled, false],
    ['include-dependencies', 'off', result => result.config.includeDependencies, false],
    ['provider', 'another-provider', result => result.provider, 'another-provider'],
    ['model', '"new-model"', result => result.model, 'new-model'],
    ['repair-mode', 'auto', result => result.repairMode, 'auto'],
    ['analysis', 'off', result => result.analysisEnabled, false],
    ['max-repairs', '0', result => result.maxRepairs, 0],
    ['max-turns', '1', result => result.maxTurns, 1],
    ['timeout', '1', result => result.timeoutMs, 1],
    ['analysis-timeout', '1000', result => result.config.timeoutMs, 1000],
    ['main-class', 'example.Main$Inner', result => result.config.mainClass, 'example.Main$Inner'],
    ['taint-implicit-entries', 'false', result => result.config.taintImplicitEntries, false],
    ['java-version', '8', result => result.config.javaVersion, 8],
    ['json', 'true', result => result.json, true],
  ];
  for (const [key, value, read, expected] of cases) assert.deepEqual(read(applySetting(settings(), key, value)), expected, key);
  for (const [key, values] of [
    ['build-backend', ['gradle', 'host']], ['dependency-network', ['yes']], ['baseline', ['yes']], ['include-dependencies', ['1']],
    ['max-repairs', ['-1', 'NaN', '1.5', '1e3', '0xff', '9007199254740992']],
    ['max-turns', ['0', '-1']], ['timeout', ['0', 'Infinity']], ['analysis-timeout', ['0']],
    ['java-version', ['7', '17.0']], ['repair-mode', ['yes']], ['analysis', ['yes']],
    ['json', ['1']], ['taint-implicit-entries', ['maybe']], ['provider', ['has spaces']], ['main-class', ['has spaces']],
  ] as [string, string[]][]) {
    for (const value of values) assert.throws(() => applySetting(settings(), key, value), new RegExp(`--${key}`), `${key}=${value}`);
  }
});

test('arrays support strict JSON and simple CSV without losing Windows spaces or commas', () => {
  const roots = ['D:\\My Java, Project\\source one', 'src/main/java'];
  assert.deepEqual(applySetting(settings(), 'source-root', JSON.stringify(roots)).config.sourceRoots, roots);
  const libraries = ['D:\\Java libraries\\dependency,one.jar', 'lib/two.jar'];
  assert.deepEqual(applySetting(settings(), 'classpath', JSON.stringify(libraries)).config.classpath, libraries);
  assert.deepEqual(applySetting(settings(), 'classpath', 'lib/one.jar, lib/two.jar').config.classpath, ['lib/one.jar', 'lib/two.jar']);
  assert.deepEqual(applySetting(settings(), 'classpath', '[]').config.classpath, []);
  assert.deepEqual(applySetting(settings(), 'source-root', '[\n "src",\n "generated sources"\n]').config.sourceRoots, ['src', 'generated sources']);
  assert.deepEqual(applySetting(settings(), 'analyses', 'null-pointer,division-by-zero,null-pointer').config.analyses, ['null-pointer', 'division-by-zero']);
  for (const key of ['source-root', 'classpath', 'analyses']) {
    for (const value of ['[1]', '[null]', '[""]', '["a",]', 'first,,second', 'first,'])
      assert.throws(() => applySetting(settings(), key, value), new RegExp(`--${key}`));
  }
  assert.throws(() => applySetting(settings(), 'analyses', '[]'), /非空/);
  assert.throws(() => applySetting(settings(), 'source-root', '[]'), /非空/);
  assert.throws(() => applySetting(settings(), 'analyses', 'dead-code,not-a-rule'), /未知检测器/);
});

test('interactive project paths resolve against the current project and optional settings can be unset', () => {
  const before = settings();
  const project = applySetting(before, 'project', '"../project with spaces"');
  assert.equal(project.projectDir, path.resolve(before.projectDir, '../project with spaces'));
  const jar = applySetting(project, 'jar', '"tools/custom jar.jar"');
  assert.equal(jar.config.jarPath, path.resolve(project.projectDir, 'tools/custom jar.jar'));
  const taint = applySetting(project, 'taint-config', 'policies/taint.yml');
  assert.equal(taint.config.taintConfig, path.resolve(project.projectDir, 'policies/taint.yml'));
  const configured = settings();
  configured.config = { jarPath: 'old.jar', mainClass: 'Old', taintConfig: 'old.yml', javaVersion: 17, sourceRoots: ['old'] };
  for (const [key, field] of [['jar', 'jarPath'], ['main-class', 'mainClass'], ['taint-config', 'taintConfig'], ['java-version', 'javaVersion']] as const)
    assert.equal(applySetting(configured, key, 'unset').config[field], undefined);
  assert.equal(applySetting(configured, 'source-root', 'auto').config.sourceRoots, undefined);
  configured.config.classpath = ['lib/a.jar'];
  assert.equal(applySetting(configured, 'classpath', 'auto').config.classpath, undefined);
  assert.deepEqual(configured.config.classpath, ['lib/a.jar']);
  assert.deepEqual(configured.config.sourceRoots, ['old']);
});

test('the Maven panel uses build metadata defaults and explains the manual check scope', () => {
  const current = settings();
  const values = (state: ChatSettings) => Object.fromEntries(CHAT_SETTING_REGISTRY.map(entry => [entry.key, entry.display(state)]));
  assert.equal(values(current)['build-backend'], 'javac');
  assert.equal(values(current)['dependency-network'], 'off');
  assert.equal(values(current)['include-dependencies'], 'off');
  const maven = applySetting(current, 'build-backend', 'maven-docker');
  assert.equal(values(maven)['source-root'], 'auto → Maven 构建结果');
  assert.equal(values(maven).classpath, 'auto → Maven 构建结果');
  assert.equal(values(maven)['analysis-timeout'], '600000');
  assert.equal(values(maven)['java-version'], 'unset（容器 JDK 17）');
  assert.match(renderSettings(maven), /\/check 按 build-backend 执行检查，不调用模型或自动修复/);
  assert.match(renderSettings(maven), /模型工具、宿主验收和 \/check 使用同一后端/);
  assert.match(renderSettings(maven), /干净结果为 incomplete/);
  assert.equal(values(applySetting(maven, 'analysis-timeout', '4321'))['analysis-timeout'], '4321');
});

test('the panel renders effective defaults, resolved directories and safe read-only environment state', async () => {
  const root = path.resolve('.taie-agent', 'chat-settings-tests');
  await mkdir(root, { recursive: true });
  const project = await mkdtemp(path.join(root, 'project-'));
  const oldJar = process.env.TAIE_JAR;
  const oldKey = process.env.DEEPSEEK_API_KEY;
  try {
    delete process.env.TAIE_JAR;
    process.env.DEEPSEEK_API_KEY = 'FAKE_SECRET_NOT_FOR_DISPLAY_123456';
    await mkdir(path.join(project, 'src', 'main', 'java'), { recursive: true });
    const current = { ...settings(), projectDir: project };
    const output = renderSettings(current);
    assert.ok(output.includes(JSON.stringify(DEFAULT_ANALYSES)));
    assert.ok(output.includes(JSON.stringify([path.join(project, 'src', 'main', 'java')])));
    assert.match(output, /auto →/);
    assert.ok(output.includes(getDefaultJarPath().replaceAll('\\', '\\\\')));
    assert.match(output, /120000/);
    assert.match(output, /所选 JDK 默认/);
    assert.match(output, /Java 环境（只读）/);
    assert.match(output, /JSON 数组/);
    assert.equal(output.includes(process.env.DEEPSEEK_API_KEY), false);
    assert.match(output, /下一轮重新推断/);
    process.env.TAIE_JAR = 'env/custom.jar';
    assert.ok(renderSettings(current).includes(JSON.stringify(path.resolve('env/custom.jar'))));
    assert.match(renderSettings(current), /TAIE_JAR/);
    assert.ok(renderSettings({ ...current, config: { jarPath: 'project-custom.jar' } })
      .includes(JSON.stringify(path.join(project, 'project-custom.jar'))));
  } finally {
    if (oldJar === undefined) delete process.env.TAIE_JAR; else process.env.TAIE_JAR = oldJar;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
    assert.ok(project.startsWith(root + path.sep));
    await rm(project, { recursive: true, force: true });
  }
});

test('chat command parsing preserves task text and JSON arguments and maps aliases without I/O', () => {
  assert.deepEqual(parseChatCommand(' /config '), { kind: 'settings' });
  assert.deepEqual(parseChatCommand('/settings'), { kind: 'settings' });
  assert.deepEqual(parseChatCommand('/help'), { kind: 'help' });
  assert.deepEqual(parseChatCommand(' /check '), { kind: 'check' });
  assert.deepEqual(parseChatCommand('/exit'), { kind: 'exit' });
  assert.deepEqual(parseChatCommand('/set --model another-model'), { kind: 'set', key: 'model', value: 'another-model' });
  assert.deepEqual(parseChatCommand('/set classpath ["D:/Java libs/a,b.jar", "lib/c.jar"]'), {
    kind: 'set', key: 'classpath', value: '["D:/Java libs/a,b.jar", "lib/c.jar"]',
  });
  assert.deepEqual(parseChatCommand('/repair ask'), { kind: 'set', key: 'repair-mode', value: 'ask' });
  assert.deepEqual(parseChatCommand('/repair auto'), { kind: 'set', key: 'repair-mode', value: 'auto' });
  assert.deepEqual(parseChatCommand('/analysis off'), { kind: 'set', key: 'analysis', value: 'off' });
  assert.deepEqual(parseChatCommand('  Write Java code.  '), { kind: 'message', text: '  Write Java code.  ' });
  assert.deepEqual(parseChatCommand('--skip-taie 先讨论设计'), { kind: 'message', text: '--skip-taie 先讨论设计' });
  for (const input of ['/unknown', '/set', '/set model', '/set unknown value', '/repair', '/repair yes', '/analysis', '/analysis maybe', '/config extra', '/check extra', '/exit now'])
    assert.throws(() => parseChatCommand(input), Error, input);
});

test('unknown settings, empty values, malformed quotes and control characters cannot change state', () => {
  const before = settings();
  const snapshot = structuredClone(before);
  assert.throws(() => applySetting(before, 'not-a-setting', 'value'), /未知设置/);
  for (const value of ['', '  ', '""', "''", '"unfinished', 'bad\nvalue', 'bad\0value'])
    assert.throws(() => applySetting(before, 'model', value));
  assert.deepEqual(before, snapshot);
});
