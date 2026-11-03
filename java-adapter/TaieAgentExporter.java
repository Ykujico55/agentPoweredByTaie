import com.fasterxml.jackson.databind.ObjectMapper;
import pascal.taie.Main;
import pascal.taie.World;
import pascal.taie.analysis.bugfinder.BugInstance;
import pascal.taie.analysis.pta.plugin.taint.AgentEvidencePlugin;
import pascal.taie.config.AnalysisConfig;
import pascal.taie.config.AnalysisPlanner;
import pascal.taie.config.ConfigManager;
import pascal.taie.config.Configs;
import pascal.taie.config.Plan;
import pascal.taie.config.PlanConfig;
import pascal.taie.ir.stmt.Stmt;
import pascal.taie.language.classes.JClass;
import pascal.taie.language.classes.JMethod;

import java.nio.file.Path;
import java.io.File;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Runs real Tai-e analyses and exports their in-memory result objects. */
public final class TaieAgentExporter {
    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            throw new IllegalArgumentException("Expected output JSON, comma-separated profiles, and Tai-e arguments");
        }
        String output = args[0];
        String[] profiles = args[1].split(",");
        AgentEvidencePlugin.reset();
        String[] taiEArguments = Arrays.copyOfRange(args, 2, args.length);
        expandRequestedPlan(taiEArguments);
        Main.main(taiEArguments);
        List<JClass> classes = World.get().getClassHierarchy().allClasses()
                .filter(JClass::isApplication).sorted(Comparator.comparing(JClass::getName)).toList();
        if (classes.isEmpty()) throw new IllegalStateException("No application classes analyzed");
        List<Map<String, Object>> findings = new ArrayList<>();
        Map<String, Integer> counts = new LinkedHashMap<>();
        Map<String, Object> metadata = new LinkedHashMap<>();
        for (String profile : profiles) {
            if (profile.equals("taint")) {
                AgentEvidencePlugin.Export taint = AgentEvidencePlugin.exportResult();
                findings.addAll(taint.findings());
                counts.put(profile, taint.analyzedMethods());
                metadata.put(profile, taint.metadata());
                continue;
            }
            int count = 0;
            for (JClass clazz : classes) {
                if (profile.equals("clone-idiom")) {
                    collect(findings, clazz.getResult(profile), profile, clazz, null);
                    count++;
                } else {
                    for (JMethod method : clazz.getDeclaredMethods()) {
                        if (method.isAbstract()) continue;
                        collect(findings, method.getIR().getResult(profile), profile, clazz, method);
                        count++;
                    }
                }
            }
            if (count == 0) throw new IllegalStateException("No entities analyzed by " + profile);
            counts.put(profile, count);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schemaVersion", 2);
        result.put("analyzedEntities", counts);
        result.put("findings", findings);
        result.put("analysisMetadata", metadata);
        new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(Path.of(output).toFile(), result);
        System.out.println("TAIE_AGENT_EXPORT_COMPLETED " + findings.size());
    }

    /**
     * Tai-e expands dependencies for -a, but assumes a -p plan is already fully
     * expanded. The host supplies a JSON/YAML requested plan to preserve option
     * value types and Windows paths, so use Tai-e's own planner before execution.
     * The host fixes class/method analysis scope to APP (not REACHABLE).
     */
    private static void expandRequestedPlan(String[] args) throws Exception {
        for (int index = 0; index < args.length; index++) {
            if (!args[index].equals("-p") && !args[index].equals("--plan-file")) continue;
            if (index + 1 >= args.length) throw new IllegalArgumentException("Missing plan file path");
            File requestedFile = Path.of(args[index + 1]).toAbsolutePath().toFile();
            List<PlanConfig> requested = PlanConfig.readConfigs(requestedFile);
            ConfigManager manager;
            try (InputStream content = Configs.getAnalysisConfig()) {
                manager = new ConfigManager(AnalysisConfig.parseConfigs(content));
            }
            manager.overwriteOptions(requested);
            Plan expanded = new AnalysisPlanner(manager, Set.of(Plan.KEEP_ALL)).expandPlan(requested, false);
            List<PlanConfig> expandedConfigs = expanded.analyses().stream()
                    .map(config -> new PlanConfig(config.getId(), config.getOptions())).toList();
            PlanConfig.writeConfigs(expandedConfigs, requestedFile.getParentFile());
            args[index + 1] = new File(requestedFile.getParentFile(), "tai-e-plan.yml").getAbsolutePath();
            return;
        }
    }

    private static void collect(List<Map<String, Object>> findings, Object result,
                                String analysis, JClass clazz, JMethod method) {
        if (!(result instanceof Collection<?> values)) {
            throw new IllegalStateException("Missing or unsupported result: " + analysis + " " + clazz + " " + method);
        }
        for (Object value : values) {
            Map<String, Object> finding = new LinkedHashMap<>();
            finding.put("analysis", analysis);
            finding.put("className", clazz.getName());
            if (method != null) finding.put("method", method.getSignature());
            if (value instanceof BugInstance bug) {
                finding.put("type", bug.getType().toString());
                finding.put("severity", bug.getSeverity().toString());
                if (bug.getSourceLineStart() > 0) finding.put("startLine", bug.getSourceLineStart());
                if (bug.getSourceLineEnd() > 0) finding.put("endLine", bug.getSourceLineEnd());
                finding.put("message", bug.toString());
            } else if (analysis.equals("dead-code") && value instanceof Stmt stmt) {
                finding.put("type", "DEAD_CODE");
                finding.put("severity", "INFO");
                if (stmt.getLineNumber() > 0) {
                    finding.put("startLine", stmt.getLineNumber());
                    finding.put("endLine", stmt.getLineNumber());
                }
                finding.put("message", stmt.toString());
            } else {
                throw new IllegalStateException("Unknown result item: " + value.getClass());
            }
            findings.add(finding);
        }
    }
}
