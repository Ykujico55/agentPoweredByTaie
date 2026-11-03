import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnalysisReport, Finding, EvidenceLocation } from './taie.ts';
type Level = 'error' | 'warning' | 'note';
interface SarifLocation {
  id?: number;
  message?: { text: string };
  physicalLocation?: {
    artifactLocation: { uri: string; uriBaseId?: string };
    region?: { startLine: number; endLine?: number; snippet?: { text: string } };
  };
  logicalLocations?: { fullyQualifiedName: string; kind: 'function' | 'type' }[];
}

const sourceRootId = '%SRCROOT%';
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);
const slash = (text: string) => text.replaceAll('\\', '/');
const positiveLine = (line: unknown): line is number => Number.isSafeInteger(line) && Number(line) > 0;

function relativeFile(file: string | undefined, projectDir: string): string {
  if (!file) return '';
  return slash(path.relative(path.resolve(projectDir), path.resolve(projectDir, file)));
}

/** Normalize location annotations, retaining semantic constants in the message. */
function stableText(text: string | undefined, projectDir: string): string {
  if (!text) return '';
  return slash(text)
    .split(slash(path.resolve(projectDir))).join('<project>')
    .replace(/\.taie-agent\/runs\/[^\s/]+/g, '.taie-agent/runs/<run>')
    .replace(/\bLineNumber\s*:\s*(?:\d+(?:---\d+)?|null)/gi, 'LineNumber: <line>')
    .replace(/\b(?:startLine|endLine|line|lines)\s*[:#]\s*\d+(?:\s*[-–:]\s*\d+)?/gi, 'line <line>')
    .replace(/\bat lines?\s+\d+(?:\s*[-–:]\s*\d+)?/gi, 'at line <line>')
    .replace(/@L\d+/g, '@L<line>')
    .replace(/\[\d+@L<line>\]/g, '[<statement>@L<line>]')
    .replace(/\s+/g, ' ').trim();
}

function locationIdentity(location: EvidenceLocation | undefined, projectDir: string): unknown {
  if (!location) return undefined;
  return [relativeFile(location.sourcePath, projectDir), location.className ?? '', location.method ?? '',
    stableText(location.statement, projectDir)];
}

/** Stable within a logical occurrence; inserting an identical earlier occurrence can renumber duplicates. */
export function normalizeFindings(findings: Finding[], projectDir: string): Finding[] {
  const groups = new Map<string, { index: number; finding: Finding }[]>();
  findings.forEach((finding, index) => {
    const item = finding;
    const ruleId = item.ruleId ?? `${item.analysis}/${item.type}`;
    const identity = JSON.stringify([
      ruleId, relativeFile(item.sourcePath, projectDir), item.className ?? '', item.method ?? '',
      stableText(item.evidence?.sink?.statement ?? item.evidence?.source?.statement ?? item.message, projectDir),
      locationIdentity(item.evidence?.source, projectDir), locationIdentity(item.evidence?.sink, projectDir),
    ]);
    const group = groups.get(identity) ?? [];
    group.push({ index, finding: item });
    groups.set(identity, group);
  });
  const normalized = new Array<Finding>(findings.length);
  for (const [identity, group] of groups) {
    group.sort((a, b) => (a.finding.startLine ?? a.finding.evidence?.sink?.line ?? 0)
      - (b.finding.startLine ?? b.finding.evidence?.sink?.line ?? 0)
      || (a.finding.endLine ?? 0) - (b.finding.endLine ?? 0) || a.index - b.index);
    group.forEach(({ index, finding }, occurrence) => {
      normalized[index] = { ...finding, ruleId: finding.ruleId ?? `${finding.analysis}/${finding.type}`,
        id: digest(`${identity}\0${occurrence}`) };
    });
  }
  return normalized;
}

function level(severity: string | number | undefined): Level {
  const value = String(severity ?? '').toLowerCase();
  if (['blocker', 'critical', 'major', 'high', 'error', 'fatal'].includes(value)) return 'error';
  if (['info', 'informational', 'minor', 'low', 'note'].includes(value)) return 'note';
  return 'warning';
}

function artifactLocation(file: string, projectDir: string): { uri: string; uriBaseId?: string } {
  const absolute = path.resolve(projectDir, file);
  const relative = path.relative(path.resolve(projectDir), absolute);
  if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return { uri: slash(relative).split('/').map(segment => encodeURIComponent(segment)).join('/'), uriBaseId: sourceRootId };
  }
  return { uri: pathToFileURL(absolute).href };
}

function location(value: EvidenceLocation, projectDir: string, endLine?: number, label?: string): SarifLocation | undefined {
  const result: SarifLocation = {};
  if (value.sourcePath) {
    result.physicalLocation = { artifactLocation: artifactLocation(value.sourcePath, projectDir) };
    if (positiveLine(value.line)) {
      result.physicalLocation.region = {
        startLine: value.line,
        ...(positiveLine(endLine) && endLine >= value.line ? { endLine } : {}),
        ...(value.statement ? { snippet: { text: value.statement } } : {}),
      };
    }
  }
  if (value.method || value.className) result.logicalLocations = [{
    fullyQualifiedName: value.method ?? value.className!, kind: value.method ? 'function' : 'type',
  }];
  if (!result.physicalLocation && !result.logicalLocations) return undefined;
  if (label || value.statement) result.message = { text: label ? `${label}${value.statement ? `: ${value.statement}` : ''}` : value.statement! };
  return result;
}

function flowLocations(finding: Finding, projectDir: string): SarifLocation[] {
  const evidence = finding.evidence;
  if (!evidence) return [];
  const points = [evidence.source, ...(evidence.path ?? []), evidence.sink].filter((item): item is EvidenceLocation => Boolean(item));
  const locations: SarifLocation[] = [];
  let previous = '';
  for (const point of points) {
    const current = location(point, projectDir);
    if (!current) continue;
    const key = JSON.stringify(current);
    if (key !== previous) locations.push(current);
    previous = key;
  }
  return locations;
}

/** Convert only observed findings; an unsuccessful invocation is never represented as a clean pass. */
export function toSarif(report: AnalysisReport) {
  const findings = report.findings;
  const ruleIds = [...new Set(findings.map(finding => finding.ruleId ?? `${finding.analysis}/${finding.type}`))].sort();
  const rules = ruleIds.map(id => {
    const finding = findings.find(item => (item.ruleId ?? `${item.analysis}/${item.type}`) === id)!;
    return { id, shortDescription: { text: finding.type },
      defaultConfiguration: { level: level(finding.severity) },
      properties: { analysis: finding.analysis } };
  });
  const successful = report.status === 'completed';
  const rootUri = pathToFileURL(path.resolve(report.projectDir) + path.sep).href;
  return {
    $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/cs01/schemas/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: {
        name: 'Tai-e Coding Agent', ...(report.taiE.version ? { version: report.taiE.version } : {}),
        informationUri: 'https://github.com/pascal-lab/Tai-e', rules,
      } },
      originalUriBaseIds: { [sourceRootId]: { uri: rootUri } },
      invocations: [{
        executionSuccessful: successful,
        ...(report.startedAt ? { startTimeUtc: report.startedAt } : {}),
        ...(report.finishedAt ? { endTimeUtc: report.finishedAt } : {}),
        workingDirectory: { uri: rootUri },
        toolExecutionNotifications: successful ? [] : [{
          level: 'error', message: { text: report.diagnostics.join('\n') || `Analysis did not complete: ${report.status}.` },
        }],
      }],
      results: findings.map(finding => {
        const ruleId = finding.ruleId ?? `${finding.analysis}/${finding.type}`;
        const primary = location({ sourcePath: finding.sourcePath, line: finding.startLine,
          className: finding.className, method: finding.method }, report.projectDir, finding.endLine)
          ?? (finding.evidence?.sink ? location(finding.evidence.sink, report.projectDir) : undefined);
        const related: SarifLocation[] = [];
        for (const [name, point] of [['Source', finding.evidence?.source], ['Sink', finding.evidence?.sink]] as const) {
          const resolved = point ? location(point, report.projectDir, undefined, name) : undefined;
          if (resolved) related.push({ ...resolved, id: related.length + 1 });
        }
        const flow = flowLocations(finding, report.projectDir);
        return {
          ruleId, ruleIndex: ruleIds.indexOf(ruleId), kind: 'fail', level: level(finding.severity),
          message: { text: finding.message },
          partialFingerprints: { 'taieAgent/v2': finding.id },
          ...(primary ? { locations: [primary] } : {}),
          ...(related.length ? { relatedLocations: related } : {}),
          ...(flow.length >= 2 ? { codeFlows: [{
            message: { text: 'Static analysis flow; only reported evidence points are shown.' },
            threadFlows: [{ locations: flow.map((point, index) => ({ location: point, executionOrder: index + 1 })) }],
          }] } : {}),
          properties: { findingId: finding.id, analysis: finding.analysis, type: finding.type,
            ...(finding.confidence ? { confidence: finding.confidence } : {}),
            ...(finding.evidence ? { evidence: finding.evidence } : {}),
          },
        };
      }),
      properties: { schemaVersion: report.schemaVersion, status: report.status, runId: report.runId,
        sourceFingerprint: report.sourceFingerprint, analyses: report.analyses,
        limitations: report.limitations, taiE: report.taiE, analysisMetadata: report.analysisMetadata },
    }],
  };
}

/** The editable review file is separate from the immutable analyzer report and raw evidence. */
export async function writeStructuredOutputs(report: AnalysisReport): Promise<void> {
  const sarif = path.join(report.runDir, 'results.sarif');
  const triage = path.join(report.runDir, 'triage.json');
  const template = {
    schemaVersion: 2, runId: report.runId, reportPath: report.reportPath,
    analysisStatus: report.status, sourceFingerprint: report.sourceFingerprint,
    states: {
      unreviewed: 'No review decision has been recorded.',
      confirmed: 'Evidence supports a real defect.',
      false_positive: 'Recorded reasoning and evidence justify excluding this candidate.',
      unresolved: 'Available evidence does not establish a decision.',
    },
    instructions: 'Record review decisions and supporting evidence here. This file does not suppress or delete raw findings.',
    findings: report.findings.map(finding => ({
      findingId: finding.id, ruleId: finding.ruleId ?? `${finding.analysis}/${finding.type}`,
      state: 'unreviewed', rationale: '', evidence: [] as string[],
    })),
  };
  await writeFile(sarif, `${JSON.stringify(toSarif(report), null, 2)}\n`, { flag: 'wx' });
  await writeFile(triage, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx' });
  report.evidence.sarif = sarif;
  report.evidence.triage = triage;
}
