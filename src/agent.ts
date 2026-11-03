import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { analyzeJavaProject } from "./taie.ts";
import type { AnalysisReport } from "./taie.ts";
import type { ProjectConfig } from "./config.ts";
import { freezeProjectConfig } from "./config.ts";
import { verifyTask, formatReport, type VerificationResult, type RepairMode } from "./verification.ts";
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
  confirmRepair?: (report: AnalysisReport, nextRound: number) => Promise<boolean>;
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
  let settings = { ...options, config: structuredClone(frozenConfig) };
  let running = false;
  // A discussion-only task must not require analysis inputs to exist. Snapshot the
  // immutable policy when analysis is first used, then reuse it for this session.
  let taintConfigContentPromise: Promise<string | undefined> | undefined;
  let skipTaieForTurn = false;
  let repairModeForTurn: RepairMode = options.repairMode ?? "auto";
  let writeLocked = false;
  const analyze = async (signal?: AbortSignal) => {
    if (skipTaieForTurn) throw new Error("Tai-e is disabled for the current user task.");
    taintConfigContentPromise ??= frozenConfig.taintConfig
      ? readFile(resolve(projectDir, frozenConfig.taintConfig), "utf8") : Promise.resolve(undefined);
    return analyzeJavaProject({ ...frozenConfig, taintConfigContent: await taintConfigContentPromise, projectDir, signal });
  };
  let lastAnalysis: AnalysisReport | undefined;
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
      "When Tai-e is enabled, invoke taie_analyze after meaningful Java changes. It compiles fresh sources and returns real findings and evidence files.",
      "Use taie_get_finding to retrieve focused source/sink/path evidence from the latest analysis, including a host verification report.",
      "The host also specifies auto, ask, or off repair policy for every task. Preserve intentional bug demonstrations. Never fix reported defects without permission under ask/off policies.",
      "Do not suppress analysis or fabricate tool results. A request to demonstrate a bug is not permission to fix it.",
      "A completed analysis without findings only covers the configured detectors; it is not a proof of general correctness.",
      "When Tai-e is enabled, the host performs another fresh compilation and analysis after you stop, and may send you repair feedback.",
      "Do not read credentials or print API keys. Do not change taie-agent.json or files under .taie-agent.",
    ],
  });
  await resourceLoader.reload();
  const tool = defineTool({
    name: "taie_analyze",
    label: "Tai-e Java analysis",
    description: "Compile all configured Java sources and run real Tai-e bug detectors. Returns findings, build diagnostics and paths to immutable raw logs and report JSON. Never equate a failed analysis with a clean result.",
    promptSnippet: "Compile the project and run Tai-e static analysis with the host's fixed configuration.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_callId, _params, signal) {
      if (skipTaieForTurn) return {
        content: [{ type: "text", text: "Tai-e is disabled for this user task. No compilation or analysis was performed." }],
        details: { status: "skipped" },
      };
      const report = await analyze(signal);
      lastAnalysis = report;
      if (repairModeForTurn !== "auto" && (report.status !== "completed" || report.findings.length > 0)) writeLocked = true;
      log({ type: "taie_tool_report", report });
      const instruction = writeLocked ? "\n\nHost repair policy: writes and shell commands are now paused. Explain these results and stop. The host will handle any repair decision; do not attempt to repair in this response." : "";
      return { content: [{ type: "text", text: formatReport(report) + instruction }], details: report };
    },
  });
  const findingTool = defineTool({
    name: "taie_get_finding",
    label: "Tai-e finding evidence",
    description: "Retrieve focused findings and source/sink/abstract propagation evidence from the latest real analysis. Findings refer to that recorded source snapshot; re-run taie_analyze after edits.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Exact finding ID. Omit to list findings." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
    }),
    executionMode: "sequential",
    async execute(_callId, params) {
      if (!lastAnalysis) return { content: [{ type: "text", text: "No real analysis is available yet. Call taie_analyze first." }], details: undefined };
      const matches = lastAnalysis.findings.filter(finding => !params.id || finding.id === params.id);
      const details = {
        runId: lastAnalysis.runId, status: lastAnalysis.status, sourceFingerprint: lastAnalysis.sourceFingerprint,
        reportPath: lastAnalysis.reportPath, totalMatches: matches.length,
        findings: matches.slice(0, params.limit ?? 5),
      };
      const text = JSON.stringify(details, null, 2);
      return { content: [{ type: "text", text: text.length <= 32000 ? text : `${text.slice(0, 32000)}\n[Truncated: read ${lastAnalysis.reportPath}]` }], details };
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
      const nextConfig = await freezeProjectConfig(projectDir, next.config);
      const configChanged = JSON.stringify(nextConfig) !== JSON.stringify(frozenConfig);
      if (next.provider !== settings.provider || next.model !== settings.model) await session.setModel(nextModel, { persist: false });
      settings = { ...next, config: structuredClone(nextConfig) };
      frozenConfig = nextConfig;
      if (configChanged) { taintConfigContentPromise = undefined; lastAnalysis = undefined; }
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
        : "Host policy for this user task: Tai-e is enabled. Any skip policy from a previous task has expired. Use taie_analyze after meaningful Java changes; the host will independently compile and analyze after your response.";
      const repairPolicy = repairMode === "auto"
        ? "Repair policy: auto. Repair supported defects while preserving the requested behavior."
        : `Repair policy: ${repairMode}. You may implement the requested example or feature, but must preserve deliberately introduced defects. After discovering analysis findings, explain them and stop; do not fix them, even if you think a fix is easy. The host ${repairMode === "ask" ? "will ask the human before starting a repair round" : "will not start automatic repairs"}.`;
      const controller = new AbortController();
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
            await session.prompt(`${taskPolicy}\n${phasePolicy}\nConfigured analyses: ${(frozenConfig.analyses ?? ["dropped-exception", "clone-idiom", "dead-code"]).join(", ")}\nConfigured source roots: ${JSON.stringify(frozenConfig.sourceRoots)}\n\n${text}`);
            if (timedOut) throw new Error("Agent task timed out.");
            if (exceededTurns) throw new Error(`Agent exceeded ${settings.maxTurns} model turns.`);
            const assistant = [...session.messages].reverse().find(message => message.role === "assistant");
            if (assistant && "stopReason" in assistant && (assistant.stopReason === "error" || assistant.stopReason === "aborted")) {
              throw new Error("errorMessage" in assistant ? String(assistant.errorMessage) : `Model stopped: ${assistant.stopReason}`);
            }
          },
          analyze: () => analyze(controller.signal),
          onCheck(report) {
            lastAnalysis = report;
            if (repairMode !== "auto") writeLocked = true;
            log({ type: "host_verification", report });
            options.onStatus?.(`Host check: ${report.status}, ${report.findings.length} finding(s). Report: ${report.reportPath}`);
          },
        });
      } finally {
        clearTimeout(timer);
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
