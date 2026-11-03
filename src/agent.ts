import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkProject, findingEvidence, type CheckResult } from "./check.ts";
import type { ProjectConfig } from "./config.ts";
import { freezeProjectConfig } from "./config.ts";
import { verifyTask, formatReport, isCheckPassed, type VerificationResult, type RepairMode } from "./verification.ts";
import type { AgentTurnOptions } from "./turn.ts";
import { guardRepairTools } from "./repair-guard.ts";

export interface AgentOptions {
  projectDir: string;
  config: ProjectConfig;
  provider: string;
  model: string;
  maxRepairs: number;
  maxTurns: number;
  timeoutMs: number;
  repairMode?: RepairMode;
  confirmRepair?: (report: CheckResult, nextRound: number) => Promise<boolean>;
  onText?: (text: string) => void;
  onStatus?: (text: string) => void;
}

export function redactSecrets(text: string): string {
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:API_KEY|ACCESS_TOKEN|SECRET)$/i.test(key) && value && value.length >= 8) {
      text = text.split(value).join("[REDACTED]");
    }
  }
  return text;
}

export async function createTaieAgent(options: AgentOptions) {
  const projectDir = resolve(options.projectDir);
  const runDir = join(projectDir, ".taie-agent", "agent-runs", `${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(runDir, "pi"), { recursive: true });
  const eventPath = join(runDir, "events.jsonl");
  const log = (event: unknown) => appendFileSync(eventPath, `${redactSecrets(JSON.stringify(event))}\n`, "utf8");
  const toolCalls: string[] = [];
  let frozenConfig = await freezeProjectConfig(projectDir, options.config);
  let settings = { ...options, config: structuredClone(options.config) };
  let running = false;
  // A discussion-only task must not require analysis inputs to exist. Snapshot the
  // immutable policy when analysis is first used, then reuse it for this session.
  let taintConfigContentPromise: Promise<string | undefined> | undefined;
  let skipTaieForTurn = false;
  let repairModeForTurn: RepairMode = options.repairMode ?? "auto";
  let writeLocked = false;
  let currentTaskSignal: AbortSignal | undefined;
  const analyze = async (signal?: AbortSignal) => {
    if (skipTaieForTurn) throw new Error("Tai-e is disabled for the current user task.");
    taintConfigContentPromise ??= frozenConfig.taintConfig
      ? readFile(resolve(projectDir, frozenConfig.taintConfig), "utf8") : Promise.resolve(undefined);
    const signals = [signal, currentTaskSignal].filter((value): value is AbortSignal => value !== undefined);
    return checkProject({ ...frozenConfig, taintConfigContent: await taintConfigContentPromise,
      projectDir, signal: signals.length ? AbortSignal.any(signals) : undefined });
  };
  let lastCheck: CheckResult | undefined;
  // No global model-catalog writes and no automatic downloads during a coding task.
  const modelRuntime = await ModelRuntime.create({
    authPath: join(runDir, "pi", "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModel(options.provider, options.model);
  if (!model) throw new Error(`Unknown model ${options.provider}/${options.model}. Use a model in the pinned Pi catalog.`);
  if (!modelRuntime.hasConfiguredAuth(options.provider)) {
    throw new Error(`No credentials for ${options.provider}. For the default model set DEEPSEEK_API_KEY in your environment.`);
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false },
    enableInstallTelemetry: false, enableAnalytics: false,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: projectDir,
    agentDir: join(runDir, "pi"),
    settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    appendSystemPrompt: [
      "You are a Java coding agent augmented with the real Tai-e static analyzer.",
      `Your target project is ${projectDir}. Work inside that project.`,
      "Answer questions normally. When the user requests code changes, implement them using read, write, edit and shell tools.",
      "Keep Java sources in src/main/java unless the existing project uses another configured source root.",
      "The host specifies whether Tai-e is enabled for each user task. A skipped task does not disable analysis for later tasks.",
      "When Tai-e is enabled, invoke taie_analyze after meaningful Java changes. It uses the host-selected backend and returns build, test, analysis and review stages, project findings and evidence files.",
      "The maven-docker backend builds and tests a project snapshot, then analyzes its actual build output. The javac backend does not run project tests: tests_not_run is incomplete, even with zero findings.",
      "Use taie_analyze for Maven builds and tests; do not run Maven, javac or Tai-e through the host shell as a fallback. Shell and editing tools still run on the host.",
      "Use taie_get_finding to retrieve focused source/sink/path evidence from the latest analysis, including a host verification report.",
      "The host also specifies auto, ask, or off repair policy for every task. Preserve intentional bug demonstrations. Never fix reported defects without permission under ask/off policies.",
      "Do not suppress analysis or fabricate tool results. A request to demonstrate a bug is not permission to fix it.",
      "A completed analysis without findings only covers the configured detectors; it is not a proof of general correctness.",
      "When Tai-e is enabled, the host performs another fresh check with the selected backend after you stop, and may send you repair feedback. Only passed checks can be verified; failed or unrun tests cannot be accepted because analysis found no bugs.",
      "Only project findings drive the project gate. Dependency findings are separate evidence, not confirmed false positives. Do not modify dependency libraries to clear project checks.",
      "Do not read credentials or print API keys. Do not change taie-agent.json or files under .taie-agent.",
    ],
  });
  await resourceLoader.reload();
  const tool = defineTool({
    name: "taie_analyze",
    label: "Tai-e Java analysis",
    description: "Run the host-selected javac or Maven Docker check. Maven builds, runs project tests and analyzes actual classes with Tai-e; javac does not run tests. Returns explicit stages, project findings, separate dependency counts, and JSON/Markdown evidence paths. Zero findings cannot override failed or unrun stages.",
    promptSnippet: "Build, test where supported, and analyze with the host's fixed backend and configuration.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_callId, _params, signal) {
      if (skipTaieForTurn) return {
        content: [{ type: "text", text: "Tai-e is disabled for this user task. No compilation or analysis was performed." }],
        details: { status: "skipped" },
      };
      const report = await analyze(signal);
      lastCheck = report;
      const cleanWithoutTests = report.status === 'tests_not_run' && report.stages.build === 'passed'
        && report.stages.analysis === 'completed' && report.findings.length === 0 && report.findingCounts.project === 0;
      if (repairModeForTurn !== "auto" && !isCheckPassed(report) && !cleanWithoutTests) writeLocked = true;
      log({ type: "taie_tool_report", report });
      const instruction = writeLocked ? "\n\nHost repair policy: writes and shell commands are now paused. Explain these results and stop. The host will handle any repair decision; do not attempt to repair in this response." : "";
      return { content: [{ type: "text", text: formatReport(report) + instruction }], details: report };
    },
  });
  const findingTool = defineTool({
    name: "taie_get_finding",
    label: "Tai-e finding evidence",
    description: "Retrieve focused findings and source/sink/abstract propagation evidence from the latest real check. Defaults to project findings; dependency details require explicit origin and host include-dependencies. Findings refer to that recorded snapshot; re-run taie_analyze after edits.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Exact finding ID. Omit to list findings." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
      origin: Type.Optional(Type.Union([Type.Literal('project'), Type.Literal('dependency')], { default: 'project' })),
    }),
    executionMode: "sequential",
    async execute(_callId, params) {
      if (!lastCheck) return { content: [{ type: "text", text: "No real check is available yet. Call taie_analyze first." }], details: undefined };
      const details = findingEvidence(lastCheck, params);
      const text = JSON.stringify(details, null, 2);
      return { content: [{ type: "text", text: text.length <= 32000 ? text : `${text.slice(0, 32000)}\n[Truncated: read ${lastCheck.reportPath}]` }], details };
    },
  });
  const { session } = await createAgentSession({
    cwd: projectDir, agentDir: join(runDir, "pi"),
    modelRuntime, model, thinkingLevel: "off", resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(projectDir),
    tools: ["read", "write", "edit", process.platform === "win32" ? "powershell" : "bash", "taie_analyze", "taie_get_finding"],
    customTools: [tool, findingTool],
  });
  // Tool lists alone cannot stop a write already present in the same model
  // response as taie_analyze. Check the current permission before every call.
  session.agent.toolExecution = "sequential";
  session.agent.beforeToolCall = guardRepairTools(() => writeLocked, session.agent.beforeToolCall);
  let turns = 0;
  let exceededTurns = false;
  const unsubscribe = session.subscribe(event => {
    if (event.type === "turn_start") {
      turns++;
      if (turns > settings.maxTurns) { exceededTurns = true; void session.abort(); }
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      options.onText?.(redactSecrets(event.assistantMessageEvent.delta));
    }
    if (event.type === "tool_execution_start") {
      toolCalls.push(event.toolName);
      options.onStatus?.(`Tool: ${event.toolName}`);
    }
    // Persist completed messages and tool results, not every streaming token.
    if (event.type !== "message_update" && event.type !== "tool_execution_update") log(event);
  });

  return {
    runDir,
    /** Host-controlled updates are accepted only between user tasks. History is retained. */
    async configure(update: Partial<Omit<AgentOptions, "projectDir" | "onText" | "onStatus">>) {
      if (running) throw new Error("Settings can only be changed between tasks.");
      const next = { ...settings, ...update, config: structuredClone(update.config ?? settings.config) };
      const nextModel = modelRuntime.getModel(next.provider, next.model);
      if (!nextModel) throw new Error(`Unknown model ${next.provider}/${next.model}.`);
      if (!modelRuntime.hasConfiguredAuth(next.provider)) throw new Error(`No credentials for ${next.provider}.`);
      // An omitted sourceRoots preserves frozen coverage; an explicit undefined resets inference.
      const resetRoots = update.config !== undefined && Object.hasOwn(update.config, 'sourceRoots');
      const nextConfig = await freezeProjectConfig(projectDir, next.config, resetRoots ? undefined : frozenConfig.sourceRoots);
      const configChanged = JSON.stringify(nextConfig) !== JSON.stringify(frozenConfig);
      if (next.provider !== settings.provider || next.model !== settings.model) await session.setModel(nextModel, { persist: false });
      settings = { ...next, config: structuredClone(next.config) };
      frozenConfig = nextConfig;
      if (configChanged) { taintConfigContentPromise = undefined; lastCheck = undefined; }
      log({ type: "configuration_changed", config: frozenConfig, provider: settings.provider, model: settings.model, repairMode: settings.repairMode ?? "auto", maxRepairs: settings.maxRepairs, maxTurns: settings.maxTurns, timeoutMs: settings.timeoutMs });
    },
    async run(task: string, turnOptions: AgentTurnOptions = {}): Promise<VerificationResult & { runDir: string; toolCalls: string[]; model: string; finalText: string; skipTaie: boolean; repairMode: RepairMode; repairDecisions: { round: number; approved: boolean }[] }> {
      if (running) throw new Error("A task is already running.");
      turns = 0;
      exceededTurns = false;
      const initialToolCount = toolCalls.length;
      const skipTaie = turnOptions.skipTaie === true;
      const repairMode = turnOptions.repairMode ?? settings.repairMode ?? "auto";
      repairModeForTurn = repairMode;
      writeLocked = false;
      const activeTools = session.getActiveToolNames();
      skipTaieForTurn = skipTaie;
      if (skipTaie) session.setActiveToolsByName(activeTools.filter(name => name !== "taie_analyze" && name !== "taie_get_finding"));
      log({ type: "task_policy", skipTaie, repairMode });
      if (skipTaie) options.onStatus?.("Tai-e skipped for this message; automatic verification resumes on the next message.");
      const taskPolicy = skipTaie
        ? "Host policy for this user task: the user explicitly disabled Tai-e. Do not invoke Tai-e or compile the project for Tai-e, including through shell commands. No host verification or repair loop will run. Do not claim this task is verified. This policy applies only to this task."
        : "Host policy for this user task: Tai-e is enabled. Any skip policy from a previous task has expired. Use taie_analyze after meaningful Java changes; the host will independently run a fresh build/test/analysis check after your response.";
      const repairPolicy = repairMode === "auto"
        ? "Repair policy: auto. Repair supported defects while preserving the requested behavior."
        : `Repair policy: ${repairMode}. You may implement the requested example or feature, but must preserve deliberately introduced defects. After finding build failures, failed tests or project analysis findings, explain them and stop; do not fix them, even if you think a fix is easy. The host ${repairMode === "ask" ? "will ask the human before starting a repair round" : "will not start automatic repairs"}. Never delete or weaken tests, suppress detectors or change build configuration to obtain a passing result.`;
      const controller = new AbortController();
      currentTaskSignal = controller.signal;
      let timedOut = false;
      let remainingMs = settings.timeoutMs;
      let activeSince = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const armTimer = () => {
        activeSince = Date.now();
        timer = setTimeout(() => { timedOut = true; controller.abort(); void session.abort(); }, Math.max(0, remainingMs));
      };
      armTimer();
      const repairDecisions: { round: number; approved: boolean }[] = [];
      let prompts = 0;
      running = true;
      let result: VerificationResult;
      try {
        result = await verifyTask({
          task,
          skipTaie,
          maxRepairs: settings.maxRepairs,
          repairMode,
          async confirmRepair(report, round) {
            clearTimeout(timer);
            remainingMs -= Date.now() - activeSince;
            try {
              const approved = timedOut ? false : await settings.confirmRepair?.(report, round) ?? false;
              repairDecisions.push({ round, approved });
              log({ type: "repair_decision", round, approved, reportPath: report.reportPath });
              return approved;
            } finally { if (!timedOut) armTimer(); }
          },
          async prompt(text) {
            if (timedOut) throw new Error("Agent task timed out.");
            const isRepair = prompts++ > 0;
            if (isRepair) writeLocked = false;
            const phasePolicy = isRepair ? "The host has authorized this repair round. You may now edit to fix the reported issues. After the next analysis, report results and stop if further repairs require another human decision." : repairPolicy;
            const backend = frozenConfig.buildBackend ?? 'javac';
            const coverage = backend === 'maven-docker' ? 'Source roots and classpath come from the Maven build; checks run offline in Docker.'
              : `Configured source roots: ${JSON.stringify(frozenConfig.sourceRoots)}. Project tests are not run by this backend.`;
            await session.prompt(`${taskPolicy}\n${phasePolicy}\nBuild backend: ${backend}\n${coverage}\nConfigured analyses: ${(frozenConfig.analyses ?? ["dropped-exception", "clone-idiom", "dead-code"]).join(", ")}\n\n${text}`);
            if (timedOut) throw new Error("Agent task timed out.");
            if (exceededTurns) throw new Error(`Agent exceeded ${settings.maxTurns} model turns.`);
            const assistant = [...session.messages].reverse().find(message => message.role === "assistant");
            if (assistant && "stopReason" in assistant && (assistant.stopReason === "error" || assistant.stopReason === "aborted")) {
              throw new Error("errorMessage" in assistant ? String(assistant.errorMessage) : `Model stopped: ${assistant.stopReason}`);
            }
          },
          analyze: () => analyze(controller.signal),
          onCheck(report) {
            lastCheck = report;
            if (repairMode !== "auto") writeLocked = true;
            log({ type: "host_verification", report });
            options.onStatus?.(`Host check: ${report.status}; build=${report.stages.build}, tests=${report.stages.test.status}, analysis=${report.stages.analysis}; project findings=${report.findingCounts.project}, dependency findings=${report.findingCounts.dependency}. Report: ${report.reportPath}; readable: ${report.humanReportPath}`);
          },
        });
      } finally {
        clearTimeout(timer);
        currentTaskSignal = undefined;
        skipTaieForTurn = false;
        writeLocked = false;
        running = false;
        if (skipTaie) session.setActiveToolsByName(activeTools);
      }
      if (timedOut) result = { ...result, outcome: "agent_error", error: "Agent task timed out." };
      const report = {
        ...result, runDir, skipTaie, repairMode, repairDecisions, toolCalls: toolCalls.slice(initialToolCount),
        configuration: { projectDir, config: structuredClone(frozenConfig), provider: settings.provider, model: settings.model, maxRepairs: settings.maxRepairs, maxTurns: settings.maxTurns, timeoutMs: settings.timeoutMs },
        model: `${settings.provider}/${settings.model}`, finalText: session.getLastAssistantText() ?? "",
      };
      const json = redactSecrets(JSON.stringify(report, null, 2));
      await writeFile(join(runDir, "result.json"), json, "utf8");
      await writeFile(join(projectDir, ".taie-agent", "last-agent-run.json"), json, "utf8");
      return report;
    },
    async dispose() { unsubscribe(); session.dispose(); },
  };
}
