import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject } from '../src/check.ts';
import { reviewFinding } from '../src/review.ts';
import { redactReviewSecrets } from '../src/review-evidence.ts';
import { getDefaultJarPath } from '../src/taie.ts';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** One real Tai-e check and one tool-free DeepSeek request on a newly created synthetic project. */
async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runDir = path.join(root, '.taie-agent/live-review', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const projectDir = path.join(runDir, 'project');
  const sourcePath = path.join(projectDir, 'src/main/java/example/Parser.java');
  const source = [
    'package example;', 'public class Parser {',
    '  public static void parse(String input) {',
    '    try { Integer.parseInt(input); } catch (NumberFormatException ignored) {',
    '      // This fixture intentionally leaves the error-handling contract unspecified.',
    '    }', '  }', '}', '',
  ].join('\n');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, source);
  const evidence: Record<string, unknown> = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), projectDir,
    note: 'Real Tai-e and one tool-free DeepSeek review; integration evidence, not a false-positive accuracy benchmark.' };
  const resultPath = path.join(runDir, 'result.json');
  const save = () => writeFile(resultPath, redactReviewSecrets(JSON.stringify(evidence, null, 2)) + '\n');
  await save();
  console.log(`[live-review] Evidence: ${runDir}`);
  try {
    assert.ok(process.env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY is required for this real-model test.');
    const check = await checkProject({ projectDir, analyses: ['dropped-exception'], sourceRoots: ['src/main/java'], jarPath: getDefaultJarPath() });
    evidence.check = { reportPath: check.reportPath, humanReportPath: check.humanReportPath, status: check.status,
      projectFindings: check.findingCounts.project, durationMs: check.durationMs };
    await save();
    assert.equal(check.stages.analysis, 'completed');
    assert.equal(check.findings.length, 1);
    assert.equal(check.findings[0].origin, 'project');
    const checkHash = digest(await readFile(check.reportPath));
    const rawHash = digest(await readFile(check.backendReportPath));
    const timeoutMs = Number(process.env.TAIE_REVIEW_TIMEOUT_MS ?? 180_000);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
    const review = await reviewFinding({ projectDir, reportPath: check.reportPath, findingId: check.findings[0].id,
      provider: 'deepseek', model: 'deepseek-v4-flash', timeoutMs });
    evidence.review = review;
    await save();
    assert.equal(review.status, 'completed', review.error);
    assert.equal(review.disposition, 'pending_human');
    assert.equal(review.evidenceLevel, 'E1_model_explanation');
    assert.equal(review.affectsCheckStatus, false);
    assert.equal(review.currentWorkspace, 'not_checked');
    assert.equal(review.input.reportSha256, checkHash);
    assert.equal(review.suggestion?.findingId, check.findings[0].id);
    assert.equal(review.response?.stopReason, 'stop');
    assert.ok(review.response?.usage, 'Real model usage must be recorded.');
    assert.equal(await readFile(sourcePath, 'utf8'), source);
    assert.equal(digest(await readFile(check.reportPath)), checkHash);
    assert.equal(digest(await readFile(check.backendReportPath)), rawHash);
    assert.equal(JSON.parse(await readFile(check.reportPath, 'utf8')).stages.review, 'not_run');
    assert.match(await readFile(review.humanReportPath, 'utf8'), /人工处置：待处理/);
    evidence.originalsUnchanged = true;
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
  } finally {
    evidence.finishedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ status: evidence.status, resultPath }));
    if (evidence.error) console.error(redactReviewSecrets(String(evidence.error)));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(redactReviewSecrets(String(error))); process.exitCode = 1; });
}
