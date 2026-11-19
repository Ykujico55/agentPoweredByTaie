import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTaieAgent } from '../src/agent.ts';
import { EXTENDED_ANALYSES } from '../src/taie.ts';
import { loadJavaAcceptance, replayJavaCheck } from '../src/business-acceptance.ts';

const requirement = `为单模块 Java 17 项目实现电商订单计价，完成 src/main/java/example/OrderPricing.java。
保留公开 API：静态方法 quote(List<Line> lines, boolean member, boolean coupon, boolean pickup)，返回 Quote；
两个公开嵌套 record 为 Line(String sku, int unitCents, int quantity, boolean eligible)
和 Quote(long subtotal, long memberDiscount, long couponDiscount, long shipping, long total)。
金额使用整数分。subtotal 是所有商品的单价乘数量之和，所有有效金额在 long 范围内。
会员享受符合优惠条件（eligible）商品合计金额的 10% 折扣，按整单向下取整；非会员会员折扣为零。
持券且符合条件商品扣除会员折扣后满 10000 分，立减 1000 分。其余情况券折扣为零。
两项折扣后的整单商品金额满 12000 分免运费，否则运费 600 分。到店自提免运费。
应付金额为小计减两项折扣再加运费。空订单各项均为零；遇到负单价或非正数量抛出 IllegalArgumentException。
保留已有 POM 和公开测试，在业务实现中完成需求，使用宿主的 Maven 和 Tai-e 检查。 `.trim();

const starter = `package example;
import java.util.List;

public class OrderPricing {
    public record Line(String sku, int unitCents, int quantity, boolean eligible) {}
    public record Quote(long subtotal, long memberDiscount, long couponDiscount, long shipping, long total) {}

    public static Quote quote(List<Line> lines, boolean member, boolean coupon, boolean pickup) {
        throw new UnsupportedOperationException("Implement order pricing");
    }
}
`;
const exampleTests = `package example;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class OrderPricingTest {
    @Test public void pickupOfAFreeItem() {
        assertEquals(new OrderPricing.Quote(0, 0, 0, 0, 0), OrderPricing.quote(
                List.of(new OrderPricing.Line("sample", 0, 1, false)), false, false, true));
    }
    @Test public void ordinaryDelivery() {
        assertEquals(new OrderPricing.Quote(2000, 0, 0, 600, 2600), OrderPricing.quote(
                List.of(new OrderPricing.Line("book", 1000, 2, false)), false, false, false));
    }
}
`;

const root = path.resolve('.taie-agent/order-pricing');
await mkdir(root, { recursive: true });
const priorDir = process.argv[2] === '--regress' ? path.resolve(process.argv[3]) : undefined;
const prior = priorDir && JSON.parse(await readFile(path.join(priorDir, 'acceptance.json'), 'utf8'));
// The archived workspace is the source that produced the measured bytecode.
const snapshot = prior && path.join(path.dirname(prior.check), 'check-workspace/project');
const seeded = process.argv.includes('--seeded');
const scenario = prior ? 'regression-' + prior.scenario : seeded ? 'multi-defect' : 'from-spec';
const run = await mkdtemp(path.join(root, scenario + '-'));
const project = path.join(run, 'project');
const sources = path.join(project, 'src/main/java/example');
const tests = path.join(project, 'src/test/java/example');
await mkdir(sources, { recursive: true });
await mkdir(tests, { recursive: true });
const pom = await readFile(snapshot ? path.join(snapshot, 'pom.xml') : 'tests/fixtures/maven-simple/pom.xml', 'utf8');
const publicTests = snapshot ? await readFile(path.join(snapshot, 'src/test/java/example/OrderPricingTest.java'), 'utf8') : exampleTests;
const pomFile = path.join(project, 'pom.xml');
const testFile = path.join(tests, 'OrderPricingTest.java');
const oracle = priorDir ? path.join(priorDir, 'QuoteAcceptance.java') : path.resolve('scripts/acceptance/QuoteAcceptance.java');
const oracleBytes = await readFile(oracle);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const oracleSha256 = hash(oracleBytes);
if (prior) assert.equal(oracleSha256, prior.oracleSha256, '业务规则验收必须沿用上轮同一份判据');
const inputSource = snapshot ? await readFile(path.join(snapshot, 'src/main/java/example/OrderPricing.java'), 'utf8')
  : seeded ? await readFile('scripts/acceptance/seeded/OrderPricing.java', 'utf8') : starter;
const task = seeded || prior ? [
  '请自检现有订单计价代码。先保持代码原样，结束第一轮回复，让宿主对当前实现做检查。随后按宿主给出的定位或业务失败修改。',
  '订单的业务要求如下。', requirement,
].join('\n') : requirement;
if (seeded) {
  await writeFile(path.join(run, 'seed-truth.json'), JSON.stringify({
    sourceSha256: hash(Buffer.from(inputSource)), defects: [
      ['empty-order', 'Empty order unboxes null shipping instead of returning a zero quote.'],
      ['member-discount', '10 / 100 is integer zero and the member calculation divides by that result.'],
      ['quantity-zero', 'Zero quantity is accepted even though the contract requires a positive quantity.'],
    ],
  }, null, 2));
}
await Promise.all([
  writeFile(pomFile, pom), writeFile(testFile, publicTests),
  writeFile(path.join(sources, 'OrderPricing.java'), inputSource),
  writeFile(path.join(run, 'requirement.txt'), task),
  writeFile(path.join(run, 'oracle.sha256'), oracleSha256 + '\n'),
]);

const { jarPath } = JSON.parse(await readFile('.tools/tai-e/source-build.json', 'utf8'));
const agent = await createTaieAgent({
  projectDir: project, provider: 'deepseek', model: 'deepseek-v4-flash',
  config: { buildBackend: 'maven-docker', jarPath, analyses: EXTENDED_ANALYSES,
    dependencyNetwork: false, baselineEnabled: false, timeoutMs: 600_000 },
  repairMode: 'auto', maxRepairs: 2, maxTurns: 20, timeoutMs: 2_400_000, onStatus: console.log,
  acceptBusiness: await loadJavaAcceptance(oracle),
});
console.log('Order pricing run:', run);
try {
  const result = await agent.run(task);
  const check = result.checks.at(-1);
  const pomUnchanged = await readFile(pomFile, 'utf8') === pom;
  const publicTestsUnchanged = await readFile(testFile, 'utf8') === publicTests;
  const oracleCopy = path.join(run, 'QuoteAcceptance.java');
  await writeFile(oracleCopy, oracleBytes);
  const first = result.checks[0];
  const sameStartingSource = prior && first?.stages.build === 'passed'
    ? inputSource === await readFile(path.join(first.runDir, 'check-workspace/project/src/main/java/example/OrderPricing.java'), 'utf8')
    : undefined;
  const before = (seeded || prior) && first?.stages.build === 'passed'
    ? await replayJavaCheck(first, oracleCopy, path.join(run, 'before')) : undefined;
  const independent = check?.stages.build === 'passed'
    ? await replayJavaCheck(check, oracleCopy, path.join(run, 'acceptance'))
    : undefined;
  const passed = result.outcome === 'verified' && pomUnchanged && publicTestsUnchanged && independent?.code === 0
    && (!prior || sameStartingSource === true);
  const summary = { scenario, passed, outcome: result.outcome, repairRounds: result.repairRounds,
    priorDir, inputSourceSha256: hash(Buffer.from(inputSource)), sameStartingSource,
    acceptanceUse: 'development gate with repair feedback', businessChecks: result.businessChecks,
    pomUnchanged, publicTestsUnchanged, oracleSha256, before, independent: independent ?? 'not_run', agentRun: agent.runDir,
    check: check?.reportPath, reviews: result.reviews };
  await writeFile(path.join(run, 'acceptance.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await agent.dispose();
}
