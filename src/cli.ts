import { parseArgs } from "node:util";
import { readFile, mkdir, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { stdin, stdout, stderr } from "node:process";
import { freezeProjectConfig, loadProjectConfig } from "./config.ts";
import { analyzeJavaProject, getDefaultJarPath } from "./taie.ts";
import { renderCheckResult, type CheckResult } from "./check.ts";
import { parseChatTurn } from "./turn.ts";
import type { RepairMode } from "./verification.ts";
import { applySetting, parseChatCommand, renderSettings, CHAT_SETTING_REGISTRY, type ChatSettings } from "./chat-settings.ts";
import { createConsoleInput, type ConsoleInput } from "./console-input.ts";

const help = [
  "Tai-e Coding Agent (Pi SDK)",
  "",
  "Usage:",
  '  npm start -- run --project <dir> --prompt "Write a Java program ..."',
  "  npm start -- chat --project <dir>",
  "  npm run analyze -- --project <dir>",
  "  npm run check:maven -- --project <dir> --dependency-network on",
  "  npm run build:maven-image  Build the fixed JDK 17/Maven container image",
  "  npm run doctor",
  "",
  "Options (also available through /set):",
  ...CHAT_SETTING_REGISTRY.map(entry => "  " + entry.flag.padEnd(27) +
    (entry.key === "source-root" || entry.key === "classpath" ? "<path> (repeatable)" : ["json", "include-dependencies"].includes(entry.key) ? "(boolean; /set " + entry.key + " on|off)" : entry.usage) + "  " + entry.description),
  "",
  "Launch / per-message options:",
  "  --prompt <text>         Initial task (or positional text after run)",
  "  --prompt-file <file>    Initial task from a UTF-8 file",
  "  --skip-taie            Skip Tai-e for this run (chat: first message only)",
  "  --no-repair            Disable repairs for this run (chat: first message only)",
  "  --json                 Print task results as JSON; local UI uses stderr",
  "  --help                 Show this help",
  "",
  "CLI defaults: analysis=on, repair-mode=ask, max-repairs=2, max-turns=30, timeout=600000ms.",
  "Task timeout excludes time waiting for human repair decisions.",
  "--source-root and --classpath are repeatable launch flags.",
  "--jar / --taint-config launch paths are relative to the launch directory.",
  "",
  "Chat commands (handled by host, no model request):",
  "  /config or /settings   Show all settings and effective values",
  "  /set <name> <value>    Change a setting for subsequent messages",
  "  /repair ask|auto|off   Choose repair policy",
  "  /analysis on|off       Choose default analysis policy",
  "  /check                Run the selected build backend; no model or repairs",
  "  /help                 Show this help",
  "  /exit                 Exit",
  "",
  "Prefix one chat message with --no-repair or --skip-taie for a one-message override.",
  "ask requires y/yes to start each repair round; empty input/EOF means no.",
  "In JSON mode ask preserves findings without an interactive repair prompt.",
  "Use /repair off to preserve deliberate bug demonstrations while still analyzing.",
  "Configure source roots/dependencies in <project>/taie-agent.json.",
  "Credentials are needed only for model tasks, not local configuration commands.",
  "/check runs even when /analysis is off, and does not consume per-message overrides.",
  "build-backend selects the same backend for model tools, fresh host verification, and /check; default javac.",
  "Maven build/test/analysis runs in Docker; model shell/file tools still run on the host.",
  "dependency-network/include-dependencies apply to run/chat and check-maven; Maven checks stay offline.",
  "A clean javac /check is tests_not_run. Maven passed requires build, tests and analysis success; review remains not_run.",
  'Agent schemaVersion=2: "verified" requires fresh build, executed tests and analysis success with no project findings.',
  'Clean javac tasks return "incomplete" (exit 1); failed checks return "check_failed". Review remains not_run.',
  "",
].join("\n");

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" }, json: { type: "boolean" }, "skip-taie": { type: "boolean" }, "no-repair": { type: "boolean" },
      project: { type: "string" }, prompt: { type: "string" }, "prompt-file": { type: "string" },
      provider: { type: "string" }, model: { type: "string" }, analysis: { type: "string" }, "repair-mode": { type: "string" },
      "max-repairs": { type: "string" }, "max-turns": { type: "string" }, timeout: { type: "string" },
      "analysis-timeout": { type: "string" }, analyses: { type: "string" }, jar: { type: "string" },
      "main-class": { type: "string" }, "java-version": { type: "string" },
      "taint-config": { type: "string" }, "taint-implicit-entries": { type: "string" },
      "source-root": { type: "string", multiple: true }, classpath: { type: "string", multiple: true },
      "dependency-network": { type: "string" },
      "include-dependencies": { type: "boolean" },
      "build-backend": { type: "string" },
    },
  });
  if (values.help) { console.log(help); return; }
  const command = positionals[0] ?? "chat";
  if (!["run", "chat", "analyze", "doctor", "check-maven"].includes(command)) throw new Error("Unknown command " + command + ". Use --help.");
  for (const flag of ['dependency-network', 'include-dependencies'] as const) {
    if (values[flag] !== undefined && !['run', 'chat', 'check-maven'].includes(command))
      throw new Error('--' + flag + ' applies only to run/chat or check-maven.');
  }
  if (values['build-backend'] !== undefined && !['chat', 'run', 'check-maven'].includes(command))
    throw new Error('--build-backend applies only to run/chat or check-maven.');
  if (command === 'check-maven' && values['build-backend'] !== undefined && values['build-backend'] !== 'maven-docker')
    throw new Error('check-maven requires --build-backend maven-docker.');
  if (command !== "run" && command !== "chat") {
    for (const flag of ["skip-taie", "no-repair", "repair-mode", "analysis"] as const) {
      if (values[flag] !== undefined) throw new Error("--" + flag + " applies only to run/chat, not analyze or doctor.");
    }
  }
  const projectDir = resolve(values.project ?? ".");
  if (command === "doctor") {
    const javaHome = process.env.TAIE_JAVA_HOME ?? process.env.JAVA_HOME;
    const executable = (name: string) => javaHome ? join(javaHome, "bin", name + (process.platform === "win32" ? ".exe" : "")) : name;
    const check = (name: string) => {
      const result = spawnSync(executable(name), ["-version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      return { ok: result.status === 0 && !result.error, version: ((result.stdout ?? "") + (result.stderr ?? "")).trim(), error: result.error?.message };
    };
    const jarPath = resolve(values.jar ?? process.env.TAIE_JAR ?? getDefaultJarPath());
    const jarPresent = await access(jarPath).then(() => true, () => false);
    const java = check("java"), javac = check("javac");
    const result = {
      node: process.version, java, javac, taiE: { jarPath, installed: jarPresent }, deepseekKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY),
      readyForAnalysis: java.ok && javac.ok && jarPresent,
      note: "Default detectors: dropped-exception, clone-idiom, dead-code. No model request was made.",
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.readyForAnalysis) process.exitCode = 1;
    return;
  }
  if (command === "run" || command === "chat") await mkdir(projectDir, { recursive: true });
  const config = await loadProjectConfig(projectDir);
  if (config.jarPath) config.jarPath = resolve(projectDir, config.jarPath);
  if (config.taintConfig) config.taintConfig = resolve(projectDir, config.taintConfig);
  let settings: ChatSettings = {
    projectDir, config, provider: process.env.TAIE_AGENT_PROVIDER ?? "deepseek", model: process.env.TAIE_AGENT_MODEL ?? "deepseek-v4-flash",
    repairMode: "ask", analysisEnabled: true, maxRepairs: 2, maxTurns: 30, timeoutMs: 600_000, json: Boolean(values.json),
  };
  const raw = values as Record<string, unknown>;
  for (const key of ["provider", "model", "analysis", "repair-mode", "max-repairs", "max-turns", "timeout", "analysis-timeout", "analyses", "main-class", "java-version", "taint-implicit-entries", "build-backend", "dependency-network"]) {
    if (typeof raw[key] === "string") settings = applySetting(settings, key, raw[key]);
  }
  if (values['include-dependencies'] !== undefined)
    settings = applySetting(settings, 'include-dependencies', String(values['include-dependencies']));
  if (values.jar) settings = applySetting(settings, "jar", resolve(values.jar));
  if (values["taint-config"]) settings = applySetting(settings, "taint-config", resolve(values["taint-config"]));
  if (values["source-root"]) settings = applySetting(settings, "source-root", JSON.stringify(values["source-root"]));
  if (values.classpath) settings = applySetting(settings, "classpath", JSON.stringify(values.classpath));
  if (command === 'check-maven') {
    const { checkMavenInDocker } = await import('./docker-maven.ts');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    try {
      const report = await checkMavenInDocker({ ...settings.config, projectDir,
        timeoutMs: values.timeout ? settings.timeoutMs : settings.config.timeoutMs ?? 600_000,
        signal: controller.signal });
      const { normalizeMavenCheck, writeCheckReports } = await import('./check.ts');
      const check = await writeCheckReports(normalizeMavenCheck(report));
      console.error('可读质检报告: ' + check.humanReportPath);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === 'passed' ? 0 : report.status === 'findings' ? 2 : 1;
    } finally { process.removeListener('SIGINT', cancel); }
    return;
  }
  if (command === "analyze") {
    const report = await analyzeJavaProject({ ...settings.config, projectDir });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status !== "completed" ? 1 : report.findings.length ? 2 : 0;
    return;
  }
  if (values.prompt !== undefined && values["prompt-file"] !== undefined) throw new Error("Use either --prompt or --prompt-file.");
  const task = values["prompt-file"] ? await readFile(resolve(values["prompt-file"]), "utf8") : values.prompt ?? positionals.slice(1).join(" ");
  if (command === "run" && !task.trim()) throw new Error("run requires --prompt, --prompt-file or a positional task.");
  let input: ConsoleInput | undefined;
  let activeCheck: AbortController | undefined;
  if (command === "chat" || (settings.repairMode === "ask" && !settings.json)) input = createConsoleInput(stdin, stderr, () => {
    if (!activeCheck) return false;
    activeCheck.abort();
    console.error('[检查] 已请求取消，正在保存证据并清理。');
    return true;
  });
  let agent: Awaited<ReturnType<typeof import("./agent.ts")["createTaieAgent"]>> | undefined;
  let appliedSettings: string | undefined;
  let frozenAgentConfig: typeof settings.config | undefined;
  let frozenConfigKey: string | undefined;
  let agentSourceRoots: string[] | undefined;
  let skipNextTurn = Boolean(values["skip-taie"]);
  let repairNextTurn: RepairMode | undefined = values["no-repair"] ? "off" : undefined;
  const printSettings = () => {
    console.error(renderSettings(settings));
    if (agentSourceRoots && settings.config.buildBackend !== 'maven-docker')
      console.error('模型任务已冻结的源码范围：' + JSON.stringify(agentSourceRoots.map(root => resolve(settings.projectDir, root))) + '；/set source-root auto 可重新推断。');
    console.error("本轮覆盖：--skip-taie / --no-repair（可组合，单独输入时作用于下一条任务）。");
    console.error("启动输入：--prompt " + (values.prompt === undefined ? "未设置" : "已设置") + "；--prompt-file " + (values["prompt-file"] ?? "未设置") + "（仅启动时读取）。");
    if (skipNextTurn || repairNextTurn) console.error("下一条任务覆盖：" + (skipNextTurn ? "跳过检测 " : "") + (repairNextTurn ? "不修复" : ""));
  };
  const confirmRepair = async (report: CheckResult, round: number) => {
    if (settings.json || !input) return false;
    console.error("\n[修复选择] 第 " + round + "/" + settings.maxRepairs + " 轮 · " + report.status + " · " + report.findings.length + " 条告警");
    console.error('构建：' + report.stages.build + '；测试：' + report.stages.test.status + '（失败 ' + report.stages.test.failures + '，错误 ' + report.stages.test.errors + '）；分析：' + report.stages.analysis);
    for (const finding of report.findings.slice(0, 5)) console.error("  " + finding.type + ": " + (finding.className ?? "") + (finding.startLine ? " 第 " + finding.startLine + " 行" : ""));
    if (report.diagnostics.length) console.error(report.diagnostics.join("\n").slice(-2000));
    console.error("质检报告：" + report.humanReportPath);
    console.error("JSON：" + report.reportPath);
    for (;;) {
      const answer = await input.ask("是否允许修改代码并重新检测？[y/N] > ");
      if (answer === undefined) return false;
      const choice = answer.trim().toLowerCase();
      if (["y", "yes", "是", "修复"].includes(choice)) return true;
      if (["", "n", "no", "否", "不修复"].includes(choice)) return false;
      if (["/config", "/settings"].includes(choice)) { printSettings(); continue; }
      if (choice === "/help") { console.error(help); continue; }
      if (command === "chat") input.defer(answer);
      console.error("[taie-agent] 未收到明确修复同意，保留告警。" + (command === "chat" ? "该输入将在下一轮处理。" : ""));
      return false;
    }
  };
  const agentOptions = () => ({
    projectDir: settings.projectDir, config: settings.config, provider: settings.provider, model: settings.model,
    maxRepairs: settings.maxRepairs, maxTurns: settings.maxTurns, timeoutMs: settings.timeoutMs, repairMode: settings.repairMode, confirmRepair,
    onText: (text: string) => { if (!settings.json) stdout.write(text); },
    onStatus: (text: string) => { if (!settings.json) console.error("\n[taie-agent] " + text); },
  });
  const getAgent = async () => {
    const configKey = JSON.stringify(settings.config);
    if (frozenConfigKey !== configKey) {
      frozenAgentConfig = await freezeProjectConfig(settings.projectDir, settings.config, agentSourceRoots);
      if (frozenAgentConfig.buildBackend !== 'maven-docker') agentSourceRoots = frozenAgentConfig.sourceRoots;
      frozenConfigKey = configKey;
    }
    const update = {
      config: frozenAgentConfig!, provider: settings.provider, model: settings.model, repairMode: settings.repairMode,
      maxRepairs: settings.maxRepairs, maxTurns: settings.maxTurns, timeoutMs: settings.timeoutMs,
    };
    const fingerprint = JSON.stringify(update);
    if (!agent) {
      const { createTaieAgent } = await import("./agent.ts");
      agent = await createTaieAgent({ ...agentOptions(), config: frozenAgentConfig! });
    } else if (appliedSettings !== fingerprint) await agent.configure(update);
    appliedSettings = fingerprint;
    return agent;
  };
  const execute = async (text: string, skipTaie = false, repairMode = settings.repairMode) => {
    const report = await (await getAgent()).run(text, { skipTaie: skipTaie || !settings.analysisEnabled, repairMode });
    if (settings.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log("\n\n[taie-agent] " + report.outcome + "; repair: " + report.repairMode + "; host checks: " + report.checks.length + "; evidence: " + report.runDir);
      if (report.error) console.error("[taie-agent] " + report.error);
      else if (report.outcome === "unresolved") console.error("[taie-agent] 告警已保留。可用 /repair auto 或下一轮明确安排修复。");
      else if (report.outcome === "incomplete") console.error("[taie-agent] 检查未完成：项目测试未运行，不能视为通过。");
    }
    const lastCheck = report.checks.at(-1);
    if (lastCheck) {
      if (settings.json) console.error('可读质检报告: ' + lastCheck.humanReportPath);
      else console.log(renderCheckResult(lastCheck));
    }
    process.exitCode = report.outcome === "verified" || report.outcome === "skipped" ? 0 : 1;
  };
  const setValue = async (key: string, value: string) => {
    const next = applySetting(settings, key, value);
    if (key === 'source-root') { agentSourceRoots = undefined; frozenConfigKey = undefined; }
    if (next.projectDir !== settings.projectDir) {
      await mkdir(next.projectDir, { recursive: true });
      const projectConfig = await loadProjectConfig(next.projectDir);
      next.config = { ...projectConfig, jarPath: projectConfig.jarPath ?? settings.config.jarPath, analyses: projectConfig.analyses ?? settings.config.analyses };
      if (next.config.jarPath) next.config.jarPath = resolve(next.projectDir, next.config.jarPath);
      if (next.config.taintConfig) next.config.taintConfig = resolve(next.projectDir, next.config.taintConfig);
      await agent?.dispose();
      agent = undefined;
      appliedSettings = undefined;
      frozenAgentConfig = undefined;
      frozenConfigKey = undefined;
      agentSourceRoots = undefined;
      console.error("[taie-agent] 已切换项目并加载其配置；下一条任务开始新对话。模型、修复策略和预算保留。");
    }
    settings = next;
    console.error("[配置] " + key + " 已更新，下一轮生效。/config 查看全部设置。");
  };
  const check = async () => {
    const { checkProject, renderCheckResult } = await import('./check.ts');
    const controller = new AbortController();
    activeCheck = controller;
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    console.error('[检查] ' + (settings.config.buildBackend ?? 'javac') + ' · 构建/测试/分析中；不调用模型、不修复。Ctrl+C 取消。');
    try {
      const report = await checkProject({ ...settings.config, projectDir: settings.projectDir, signal: controller.signal });
      console.log(settings.json ? JSON.stringify(report, null, 2) : renderCheckResult(report));
      if (settings.json) console.error('可读质检报告: ' + report.humanReportPath);
      process.exitCode = report.status === 'passed' ? 0 : report.status === 'findings' ? 2 : 1;
    } finally { activeCheck = undefined; process.removeListener('SIGINT', cancel); }
  };
  const dispatch = async (text: string): Promise<boolean> => {
    try {
      const action = parseChatCommand(text);
      if (action.kind === "exit") return false;
      if (action.kind === "settings") { printSettings(); return true; }
      if (action.kind === "help") { console.error(help); return true; }
      if (action.kind === "set") { await setValue(action.key, action.value); return true; }
      if (action.kind === "check") { await check(); return true; }
      const turn = parseChatTurn(action.text, skipNextTurn, repairNextTurn);
      if (!turn.task.trim()) {
        skipNextTurn = turn.skipTaie;
        repairNextTurn = turn.repairMode;
        if (skipNextTurn || repairNextTurn) console.error("[taie-agent] 已设置下一条实际任务的单轮覆盖；配置命令不会消耗它。");
        return true;
      }
      skipNextTurn = false;
      repairNextTurn = undefined;
      await execute(turn.task, turn.skipTaie, turn.repairMode ?? settings.repairMode);
    } catch (error) {
      console.error("[taie-agent] " + (error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
    return true;
  };
  try {
    if (command === "run") { await execute(task, skipNextTurn, repairNextTurn ?? settings.repairMode); return; }
    console.error("Tai-e Coding Agent · " + settings.projectDir + "\n/config 查看配置；/check 手动检查；/repair 选择修复；/analysis 开关检测；/exit 退出。");
    printSettings();
    if (task.trim() && !await dispatch(task)) return;
    for (;;) {
      const repairLabel = { ask: "询问", auto: "自动", off: "关闭" }[settings.repairMode];
      const override = (skipNextTurn ? " · 本轮跳过" : "") + (repairNextTurn ? " · 本轮不修复" : "");
      const text = await input!.nextTask("\n你 [检测" + (settings.analysisEnabled ? "开" : "关") + " · 修复" + repairLabel + override + "] > ");
      if (text === undefined || !await dispatch(text)) break;
    }
  } finally { input?.close(); await agent?.dispose(); }
}

main().catch(error => {
  console.error("[taie-agent] " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
