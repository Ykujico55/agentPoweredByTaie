import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Finding } from './taie.ts';

/** Use actual build output so nested, anonymous and generated classes retain ownership. */
export async function projectClassNames(classesDir: string): Promise<Set<string>> {
  const names = new Set<string>();
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(path.join(classesDir, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile() && entry.name.endsWith('.class')) {
        names.add(name.slice(0, -'.class'.length).split(path.sep).join('.'));
      }
    }
  }
  await visit('');
  return names;
}

/** Origin follows the primary reported class, not classes along a propagation path. */
export function partitionFindings(findings: Finding[], projectClasses: ReadonlySet<string>): {
  projectFindings: Finding[];
  dependencyFindings: Finding[];
} {
  const projectFindings: Finding[] = [];
  const dependencyFindings: Finding[] = [];
  for (const finding of findings) {
    if (!finding.className) throw new Error(`Finding ${finding.id} has no className for origin classification.`);
    const origin = projectClasses.has(finding.className) ? 'project' as const : 'dependency' as const;
    const classified = { ...finding, origin };
    (origin === 'project' ? projectFindings : dependencyFindings).push(classified);
  }
  return { projectFindings, dependencyFindings };
}
