import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ProjectConfig {
  sourceRoots?: string[];
  classpath?: string[];
  mainClass?: string;
  analyses?: string[];
  javaVersion?: number;
  timeoutMs?: number;
  jarPath?: string;
  taintConfig?: string;
  taintImplicitEntries?: boolean;
}

/** Resolve inferred coverage before the model changes the project's layout. */
export async function freezeProjectConfig(projectDir: string, config: ProjectConfig): Promise<ProjectConfig> {
  const frozen = structuredClone(config);
  if (frozen.sourceRoots === undefined) {
    const exists = async (path: string) => access(resolve(projectDir, path)).then(() => true, () => false);
    frozen.sourceRoots = await exists("src/main/java") ? ["src/main/java"]
      : await exists("src") ? ["src"] : ["."];
  }
  return frozen;
}

export async function loadProjectConfig(projectDir: string): Promise<ProjectConfig> {
  const path = resolve(projectDir, "taie-agent.json");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const config: unknown = JSON.parse(content);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  const result = config as Record<string, unknown>;
  const allowed = ["sourceRoots", "classpath", "mainClass", "analyses", "javaVersion", "timeoutMs", "jarPath", "taintConfig", "taintImplicitEntries"];
  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) throw new Error(`Unknown configuration key: ${key}`);
  }
  for (const key of ["sourceRoots", "classpath", "analyses"]) {
    const value = result[key];
    if (value !== undefined && (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim()))) {
      throw new Error(`${key} must be an array of nonempty strings.`);
    }
  }
  if (Array.isArray(result.analyses) && result.analyses.length === 0) {
    throw new Error("analyses must not be empty.");
  }
  for (const key of ["mainClass", "jarPath", "taintConfig"]) {
    if (result[key] !== undefined && (typeof result[key] !== "string" || !(result[key] as string).trim())) {
      throw new Error(`${key} must be a nonempty string.`);
    }
  }
  if (result.taintImplicitEntries !== undefined && typeof result.taintImplicitEntries !== "boolean") {
    throw new Error("taintImplicitEntries must be a boolean.");
  }
  for (const key of ["javaVersion", "timeoutMs"]) {
    if (result[key] !== undefined && (!Number.isSafeInteger(result[key]) || (result[key] as number) <= 0)) {
      throw new Error(`${key} must be a positive integer.`);
    }
  }
  return result as ProjectConfig;
}
