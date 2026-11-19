import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTaieAgent } from '../src/agent.ts';
import { replayJavaCheck } from '../src/business-acceptance.ts';

const staticOnly = process.argv.includes('--static-only');
const runs = path.resolve('.taie-agent', 'reviewed-repair');
await mkdir(runs, { recursive: true });
const projectDir = await mkdtemp(path.join(runs, staticOnly ? 'blank-name-' : 'maven-'));
await cp(path.resolve('tests/fixtures/maven-simple'), projectDir, {
  recursive: true, filter: file => !['.taie-agent', 'target'].includes(path.basename(file)),
});
const test = path.join(projectDir, 'src/test/java/example/GreeterTest.java');
const pom = path.join(projectDir, 'pom.xml');
const originalTest = await readFile(test, 'utf8');
const originalPom = await readFile(pom, 'utf8');
const { jarPath } = JSON.parse(await readFile('.tools/tai-e/source-build.json', 'utf8'));
const agent = await createTaieAgent({
  projectDir, provider: 'deepseek', model: 'deepseek-v4-flash',
  config: { buildBackend: 'maven-docker', jarPath, analyses: ['null-pointer'],
    baselineEnabled: false, dependencyNetwork: false, timeoutMs: 600_000 },
  repairMode: 'ask', maxRepairs: 1, maxTurns: 12, timeoutMs: 1_200_000,
  onStatus: console.log,
  async confirmRepair(check, round, targets) {
    assert.equal(round, 1);
    assert.equal(check.findings.length, 1);
    assert.equal(check.stages.test.status, staticOnly ? 'passed' : 'failed');
    if (staticOnly) assert.equal(check.status, 'findings');
    assert.deepEqual(targets.map(target => target.id), [check.findings[0].id]);
    assert.equal(targets[0].type, 'NP_ALWAYS_NULL');
    return true;
  },
});
console.log('Run evidence:', agent.runDir);
try {
  const result = await agent.run([
    'This is a staged coding and review acceptance run. Edit only src/main/java/example/Greeter.java.',
    staticOnly
      ? 'First insert this deliberate defect inside greet: if (name != null && name.isBlank()) { String fallback = null; return fallback.trim(); }'
      : 'First write a deliberate defect inside greet: if (name == null) { String fallback = null; return fallback.trim(); }',
    'Keep the original greeting for all other inputs. Stop after writing the change so the host can check it.',
    'After the host reviews the finding and authorizes a repair, fix the located defect. The public contract is',
    'Hello, <name>! for a named visitor and Hello, stranger! for a null or blank name.',
    'The host runs Maven, JUnit and Tai-e after each edit. Leave those checks to the host.',
  ].join('\n'));
  assert.equal(result.outcome, 'verified', result.error ?? agent.runDir);
  assert.equal(result.repairRounds, 1);
  assert.equal(result.checks.length, 2);
  const [before, after] = result.checks;
  const [review] = result.reviews;
  assert.equal(result.reviews.length, 1);
  assert.equal(review.checkReportPath, before.reportPath);
  assert.equal(review.findingId, before.findings[0].id);
  assert.equal(review.status, 'completed');
  assert.equal(review.repairTarget, true);
  assert.equal(after.status, 'passed');
  assert.ok(after.stages.test.tests > after.stages.test.skipped);
  assert.equal(after.findings.length, 0);
  assert.equal(await readFile(test, 'utf8'), originalTest);
  assert.equal(await readFile(pom, 'utf8'), originalPom);
  if (staticOnly) {
    const probe = path.join(agent.runDir, 'BlankGreeting.java');
    await writeFile(probe, 'class BlankGreeting { public static void main(String[] args) { System.out.print(example.Greeter.greet("   ")); } }\n');
    const broken = await replayJavaCheck(before, probe, path.join(agent.runDir, 'blank-before'));
    assert.equal(broken.code, 1, broken.tail);
    assert.match(broken.tail, /NullPointerException[\s\S]*example\.Greeter\.greet/);
    const fixed = await replayJavaCheck(after, probe, path.join(agent.runDir, 'blank-after'));
    assert.equal(fixed.code, 0, fixed.tail);
    const actual = await readFile(path.join(agent.runDir, 'blank-after.stdout.log'), 'utf8');
    assert.equal(actual, 'Hello, stranger!');
    console.log('Independent blank-name replay:', 'NullPointerException ->', actual);
  }
  console.log('Reviewed and repaired:', review.findingId, '\nReview:', review.reportPath, '\nFinal check:', after.reportPath);
} finally {
  await agent.dispose();
}
