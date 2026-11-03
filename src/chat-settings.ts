import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectConfig } from './config.ts';
import { DEFAULT_ANALYSES, SUPPORTED_ANALYSES, getDefaultJarPath } from './taie.ts';

export interface ChatSettings {
  projectDir: string;
  config: ProjectConfig;
  provider: string;
  model: string;
  repairMode: 'ask' | 'auto' | 'off';
  analysisEnabled: boolean;
  maxRepairs: number;
  maxTurns: number;
  timeoutMs: number;
  json: boolean;
}

export interface ChatSettingDefinition {
  key: string;
  flag: string;
  description: string;
  usage: string;
  /** Display the effective value, including defaults and resolved paths. */
  display: (settings: ChatSettings) => string;
  /** Mutates only the private clone created by applySetting. */
  apply: (settings: ChatSettings, rawValue: string) => void;
}

function scalar(raw: string): string {
  const value = raw.trim();
  if (!value || /[\0\r\n]/.test(value)) throw new Error('设置值不能为空或包含换行/NUL。');
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    if (value.length < 2 || value.at(-1) !== quote) throw new Error('设置值的引号不完整。');
    // Scalar paths may use ordinary quotes around Windows backslashes. JSON
    // escaping is required only in JSON arrays, not for an individually quoted path.
    const content = value.slice(1, -1);
    if (!content.trim()) throw new Error('设置值不能为空。');
    return content;
  }
  return value;
}

function identifier(raw: string): string {
  const value = scalar(raw);
  if (/\s/.test(value)) throw new Error('标识符中不能包含空白。');
  return value;
}

function integer(raw: string, minimum: number): number {
  const value = scalar(raw);
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`必须是大于或等于 ${minimum} 的安全整数。`);
  }
  return number;
}

function boolean(raw: string): boolean {
  const value = scalar(raw).toLowerCase();
  if (value === 'true' || value === 'on') return true;
  if (value === 'false' || value === 'off') return false;
  throw new Error('布尔设置必须使用 on/off 或 true/false。');
}

function repairMode(raw: string): ChatSettings['repairMode'] {
  const value = scalar(raw).toLowerCase();
  if (value === 'ask' || value === 'auto' || value === 'off') return value;
  throw new Error('修复模式必须使用 ask、auto 或 off。');
}

function array(raw: string, allowEmpty = false): string[] {
  const value = raw.trim();
  let entries: unknown;
  if (value.startsWith('[')) {
    try { entries = JSON.parse(value); }
    catch { throw new Error('数组必须是有效 JSON；Windows 路径的反斜杠需写为 \\\\，也可使用 /。'); }
  } else {
    entries = value.split(',').map(entry => entry.trim());
  }
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string' || !entry.trim() || /[\0\r\n]/.test(entry))
      || (!allowEmpty && entries.length === 0)) {
    throw new Error(`必须提供${allowEmpty ? '' : '非空'}字符串数组或逗号分隔列表，不能包含空项。`);
  }
  return entries as string[];
}

const paths = (values: string[], project: string) => JSON.stringify(values.map(value => resolve(project, value)));
const unset = (raw: string) => scalar(raw).toLowerCase() === 'unset';
const optionalPath = (value: string | undefined, project: string) => value ? JSON.stringify(resolve(project, value)) : 'unset';
const definition = (key: string, description: string, usage: string,
  display: ChatSettingDefinition['display'], apply: ChatSettingDefinition['apply']): ChatSettingDefinition => ({
  key, flag: `--${key}`, description, usage, display, apply,
});

/** Every interactive setting is registered here, including its parser and display. */
export const CHAT_SETTING_REGISTRY: readonly ChatSettingDefinition[] = [
  definition('project', '目标项目目录', '<目录>', settings => JSON.stringify(resolve(settings.projectDir)),
    (settings, raw) => { settings.projectDir = resolve(settings.projectDir, scalar(raw)); }),
  definition('provider', '模型供应商', '<id>', settings => settings.provider,
    (settings, raw) => { settings.provider = identifier(raw); }),
  definition('model', '模型名称', '<id>', settings => settings.model,
    (settings, raw) => { settings.model = identifier(raw); }),
  definition('repair-mode', '宿主修复策略', 'ask|auto|off', settings => settings.repairMode,
    (settings, raw) => { settings.repairMode = repairMode(raw); }),
  definition('analysis', '默认是否执行 Tai-e', 'on|off', settings => settings.analysisEnabled ? 'on' : 'off',
    (settings, raw) => { settings.analysisEnabled = boolean(raw); }),
  definition('max-repairs', '最多修复轮数', '<整数 >= 0>', settings => String(settings.maxRepairs),
    (settings, raw) => { settings.maxRepairs = integer(raw, 0); }),
  definition('max-turns', '每任务模型轮数上限', '<整数 >= 1>', settings => String(settings.maxTurns),
    (settings, raw) => { settings.maxTurns = integer(raw, 1); }),
  definition('timeout', '整个任务的时限（毫秒）', '<毫秒 >= 1>', settings => String(settings.timeoutMs),
    (settings, raw) => { settings.timeoutMs = integer(raw, 1); }),
  definition('analysis-timeout', '单次编译和分析时限（毫秒）', '<毫秒 >= 1>', settings => String(settings.config.timeoutMs ?? 120_000),
    (settings, raw) => { settings.config.timeoutMs = integer(raw, 1); }),
  definition('analyses', 'Tai-e 检测器组合', '<JSON 数组或 csv>', settings => JSON.stringify(settings.config.analyses ?? DEFAULT_ANALYSES),
    (settings, raw) => {
      const analyses = array(raw).map(value => value.trim());
      for (const analysis of analyses) if (!SUPPORTED_ANALYSES.includes(analysis))
        throw new Error(`未知检测器 ${analysis}；可用值：${SUPPORTED_ANALYSES.join(', ')}。`);
      settings.config.analyses = [...new Set(analyses)];
    }),
  definition('source-root', 'Java 源码根目录', '<JSON 数组或 csv>|auto', settings => {
    if (settings.config.sourceRoots) return paths(settings.config.sourceRoots, settings.projectDir);
    const inferred = existsSync(resolve(settings.projectDir, 'src/main/java')) ? 'src/main/java'
      : existsSync(resolve(settings.projectDir, 'src')) ? 'src' : '.';
    return `auto → ${paths([inferred], settings.projectDir)}`;
  }, (settings, raw) => {
    if (raw.trim().toLowerCase() === 'auto') delete settings.config.sourceRoots;
    else settings.config.sourceRoots = array(raw);
  }),
  definition('classpath', '依赖 JAR 或目录；[] 清空', '<JSON 数组或 csv>', settings => paths(settings.config.classpath ?? [], settings.projectDir),
    (settings, raw) => { settings.config.classpath = array(raw, true); }),
  definition('main-class', 'Java 入口类；unset 清除', '<类名>|unset', settings => settings.config.mainClass ?? 'unset',
    (settings, raw) => { if (unset(raw)) delete settings.config.mainClass; else settings.config.mainClass = identifier(raw); }),
  definition('taint-config', '污点策略文件；unset 清除', '<文件>|unset', settings => optionalPath(settings.config.taintConfig, settings.projectDir),
    (settings, raw) => { if (unset(raw)) delete settings.config.taintConfig; else settings.config.taintConfig = resolve(settings.projectDir, scalar(raw)); }),
  definition('taint-implicit-entries', '是否建模 JVM 隐式入口', 'on|off', settings => (settings.config.taintImplicitEntries ?? true) ? 'on' : 'off',
    (settings, raw) => { settings.config.taintImplicitEntries = boolean(raw); }),
  definition('java-version', 'javac --release；unset 使用所选 JDK 默认值', '<整数 >= 8>|unset',
    settings => settings.config.javaVersion === undefined ? 'unset（所选 JDK 默认目标）' : String(settings.config.javaVersion),
    (settings, raw) => { if (unset(raw)) delete settings.config.javaVersion; else settings.config.javaVersion = integer(raw, 8); }),
  definition('jar', 'Tai-e JAR；unset 恢复环境变量或官方默认', '<文件>|unset', settings => {
    if (settings.config.jarPath) return JSON.stringify(resolve(settings.projectDir, settings.config.jarPath));
    return process.env.TAIE_JAR ? `${JSON.stringify(resolve(process.env.TAIE_JAR))}（TAIE_JAR）`
      : `${JSON.stringify(getDefaultJarPath())}（官方默认）`;
  }, (settings, raw) => { if (unset(raw)) delete settings.config.jarPath; else settings.config.jarPath = resolve(settings.projectDir, scalar(raw)); }),
  definition('json', '是否仅打印任务结果 JSON', 'on|off', settings => settings.json ? 'on' : 'off',
    (settings, raw) => { settings.json = boolean(raw); }),
];

function setting(key: string): ChatSettingDefinition {
  const normalized = key.trim().replace(/^--/, '');
  const entry = CHAT_SETTING_REGISTRY.find(candidate => candidate.key === normalized);
  if (!entry) throw new Error(`未知设置 ${key}。输入 /config 查看可用设置。`);
  return entry;
}

/** Return a detached copy; callers decide whether changed settings require a new session. */
export function applySetting(current: ChatSettings, key: string, rawValue: string): ChatSettings {
  const entry = setting(key);
  if (typeof rawValue !== 'string' || !rawValue.trim()) throw new Error(`缺少 ${entry.flag} 的值；用法：/set ${entry.key} ${entry.usage}`);
  const next = structuredClone(current);
  try { entry.apply(next, rawValue); }
  catch (error) { throw new Error(`${entry.flag}: ${error instanceof Error ? error.message : String(error)}`); }
  return next;
}

export function renderSettings(current: ChatSettings): string {
  const javaHome = process.env.TAIE_JAVA_HOME || process.env.JAVA_HOME;
  return [
    '会话配置（/set <设置名> <值>）',
    ...CHAT_SETTING_REGISTRY.map(entry => `${entry.flag.padEnd(26)} ${entry.display(current)}\n  ${entry.description}；${entry.usage}`),
    '',
    '相对路径：project 相对当前项目目录；jar、taint-config、source-root、classpath 相对所选项目。',
    'source-root auto 清除显式目录，下一轮重新推断。改变设置是否重建会话由 CLI 提示。',
    '含逗号或空格的多个路径请使用 JSON 数组，Windows 路径可用 / 或 JSON 双反斜杠。',
    `Java 环境（只读）：${javaHome ? `${process.env.TAIE_JAVA_HOME ? 'TAIE_JAVA_HOME' : 'JAVA_HOME'}=${javaHome}` : 'PATH 中的 java / javac'}`,
    '',
    '用法：',
    '  /set model deepseek-v4-flash',
    '  /set source-root ["src/main/java", "generated sources"]',
    '  /set classpath ["lib/dependency,one.jar", "D:/Java libraries/two.jar"]',
    '  /set jar vendor/Tai-e/build/tai-e-all-0.5.4.jar',
    '  /set main-class unset',
    '  /repair ask       /repair auto       /repair off',
    '  /analysis on      /analysis off',
    '  /config（或 /settings）  /help  /exit',
  ].join('\n');
}

export type ChatCommand =
  | { kind: 'settings' }
  | { kind: 'set'; key: string; value: string }
  | { kind: 'help' }
  | { kind: 'exit' }
  | { kind: 'message'; text: string };

/** Parse local chat commands without touching files, a model, or a live session. */
export function parseChatCommand(text: string): ChatCommand {
  const input = text.trim();
  if (!input.startsWith('/')) return { kind: 'message', text };
  const match = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) throw new Error('无效命令。输入 /help 查看用法。');
  const command = match[1];
  const argumentsText = match[2]?.trim() ?? '';
  if (['/config', '/settings', '/help', '/exit'].includes(command)) {
    if (argumentsText) throw new Error(`${command} 不接受参数。`);
    return { kind: command === '/config' || command === '/settings' ? 'settings' : command === '/help' ? 'help' : 'exit' };
  }
  if (command === '/set') {
    const parameters = /^(\S+)\s+([\s\S]+)$/.exec(argumentsText);
    if (!parameters || !parameters[2].trim()) throw new Error('用法：/set <设置名> <值>；输入 /config 查看全部设置。');
    const entry = setting(parameters[1]);
    return { kind: 'set', key: entry.key, value: parameters[2] };
  }
  if (command === '/repair') {
    if (!argumentsText) throw new Error('用法：/repair ask|auto|off');
    return { kind: 'set', key: 'repair-mode', value: repairMode(argumentsText) };
  }
  if (command === '/analysis') {
    if (!/^(?:on|off)$/i.test(argumentsText)) throw new Error('用法：/analysis on|off');
    return { kind: 'set', key: 'analysis', value: argumentsText.toLowerCase() };
  }
  throw new Error(`未知命令 ${command}。输入 /help 查看用法。`);
}
