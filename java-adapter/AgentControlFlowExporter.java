import com.fasterxml.jackson.databind.ObjectMapper;
import pascal.taie.Main;
import pascal.taie.World;
import pascal.taie.analysis.graph.cfg.CFG;
import pascal.taie.analysis.graph.cfg.CFGBuilder;
import pascal.taie.analysis.graph.cfg.CFGEdge;
import pascal.taie.config.AnalysisConfig;
import pascal.taie.ir.IR;
import pascal.taie.ir.stmt.If;
import pascal.taie.ir.stmt.Invoke;
import pascal.taie.ir.stmt.Stmt;
import pascal.taie.language.classes.JMethod;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Exports one method's actual normal CFG without running PTA or changing existing reports. */
public final class AgentControlFlowExporter {
    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            throw new IllegalArgumentException("Expected output JSON, exact method signature, and Tai-e world arguments");
        }
        String methodSignature = args[1];
        Main.buildWorld(Arrays.copyOfRange(args, 2, args.length));
        JMethod method = World.get().getClassHierarchy().getMethod(methodSignature);
        if (method == null || !method.getSignature().equals(methodSignature)
                || !method.getDeclaringClass().isApplication() || method.isAbstract() || method.isNative()) {
            throw new IllegalArgumentException("Expected an exact concrete application method: " + methodSignature);
        }
        IR ir = method.getIR();
        if (ir.getStmts().isEmpty()) throw new IllegalArgumentException("Method has no IR statements: " + methodSignature);
        CFG<Stmt> cfg = new CFGBuilder(AnalysisConfig.of(CFGBuilder.ID,
                "exception", null, "dump", false)).analyze(ir);

        List<Stmt> ordered = new ArrayList<>();
        ordered.add(cfg.getEntry());
        ordered.addAll(ir.getStmts());
        ordered.add(cfg.getExit());
        List<Map<String, Object>> nodes = new ArrayList<>();
        List<Map<String, Object>> edges = new ArrayList<>();
        for (Stmt statement : ordered) {
            Map<String, Object> node = new LinkedHashMap<>();
            node.put("id", id(cfg, statement));
            if (cfg.isEntry(statement) || cfg.isExit(statement)) {
                node.put("kind", cfg.isEntry(statement) ? "ENTRY" : "EXIT");
                node.put("text", cfg.isEntry(statement) ? "Method entry" : "Normal method exit");
            } else {
                node.put("kind", statement.getClass().getSimpleName());
                node.put("statementIndex", statement.getIndex());
                node.put("text", statement.toString());
                if (statement.getLineNumber() > 0) node.put("line", statement.getLineNumber());
                if (statement instanceof If branch) node.put("condition", branch.getCondition().toString());
                if (statement instanceof Invoke call) node.put("invokeMethod", call.getMethodRef().toString());
            }
            nodes.add(node);
            cfg.getOutEdgesOf(statement).stream()
                    .sorted(Comparator.comparing((CFGEdge<Stmt> edge) -> edge.getKind().name())
                            .thenComparing(edge -> id(cfg, edge.target()))
                            .thenComparingInt(edge -> edge.isSwitchCase() ? edge.getCaseValue() : 0))
                    .forEach(edge -> {
                        if (edge.isExceptional()) throw new IllegalStateException("Unexpected exceptional edge in normal-only CFG");
                        Map<String, Object> value = new LinkedHashMap<>();
                        value.put("source", id(cfg, edge.source()));
                        value.put("target", id(cfg, edge.target()));
                        value.put("kind", edge.getKind().name());
                        if (edge.isSwitchCase()) value.put("caseValue", edge.getCaseValue());
                        edges.add(value);
                    });
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schemaVersion", 1);
        result.put("method", method.getSignature());
        result.put("className", method.getDeclaringClass().getName());
        result.put("entryId", "entry");
        result.put("exitId", "exit");
        result.put("nodes", nodes);
        result.put("edges", edges);
        result.put("scope", "normal_intraprocedural");
        result.put("exceptionEdgesIncluded", false);
        result.put("pathFeasibility", "not_checked");
        new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(Path.of(args[0]).toFile(), result);
        System.out.println("TAIE_CFG_EXPORT_COMPLETED " + nodes.size() + " nodes, " + edges.size() + " edges");
    }

    private static String id(CFG<Stmt> cfg, Stmt statement) {
        if (cfg.isEntry(statement)) return "entry";
        if (cfg.isExit(statement)) return "exit";
        return "s" + statement.getIndex();
    }
}
