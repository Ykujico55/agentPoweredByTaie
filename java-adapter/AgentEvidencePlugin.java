package pascal.taie.analysis.pta.plugin.taint;

import pascal.taie.World;
import pascal.taie.analysis.graph.flowgraph.ArrayIndexNode;
import pascal.taie.analysis.graph.flowgraph.FlowEdge;
import pascal.taie.analysis.graph.flowgraph.InstanceFieldNode;
import pascal.taie.analysis.graph.flowgraph.Node;
import pascal.taie.analysis.graph.flowgraph.ObjectFlowGraph;
import pascal.taie.analysis.graph.flowgraph.StaticFieldNode;
import pascal.taie.analysis.graph.flowgraph.VarNode;
import pascal.taie.analysis.pta.PointerAnalysisResult;
import pascal.taie.analysis.pta.core.heap.Obj;
import pascal.taie.analysis.pta.core.solver.Solver;
import pascal.taie.analysis.pta.plugin.Plugin;
import pascal.taie.analysis.pta.plugin.util.InvokeUtils;
import pascal.taie.ir.exp.Var;
import pascal.taie.ir.stmt.Invoke;
import pascal.taie.ir.stmt.Stmt;
import pascal.taie.language.classes.JMethod;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * A real PTA lifecycle plugin. It observes the completed solver without adding
 * points-to facts or changing analysis semantics. The package is intentional:
 * upstream SourcePoint/SinkPoint types are package-private in Tai-e 0.5.4.
 */
public final class AgentEvidencePlugin implements Plugin {
    private static AgentEvidencePlugin completed;
    private Solver solver;
    private PointerAnalysisResult result;
    private int observedMethods;

    public static void reset() { completed = null; }

    @Override
    public void setSolver(Solver solver) { this.solver = solver; }

    @Override
    public void onNewMethod(JMethod method) { observedMethods++; }

    @Override
    public void onFinish() {
        // Tai-e installs user plugins after TaintAnalysis, so its final flows
        // have already been stored when this callback runs.
        result = solver.getResult();
        completed = this;
    }

    public record Export(List<Map<String, Object>> findings, int analyzedMethods,
                         Map<String, Object> metadata) {}

    public static Export exportResult() {
        if (completed == null || completed.result == null) {
            throw new IllegalStateException("AgentEvidencePlugin did not finish; configure pta plugins explicitly");
        }
        return completed.export();
    }

    private Export export() {
        JMethod mainMethod = World.get().getMainMethod();
        if (mainMethod == null || !result.getCallGraph().contains(mainMethod)) {
            throw new IllegalStateException("Explicit main method was not resolved or is absent from the PTA call graph");
        }
        // Re-read the host's immutable file snapshot only to count resolved
        // policy entries. An empty/unmatched policy must never look clean.
        String configPath = solver.getOptions().getString("taint-config");
        if (configPath == null || configPath.isBlank()) {
            throw new IllegalStateException("Taint evidence requires a file taint configuration");
        }
        YamlTaintConfigProvider provider = new YamlTaintConfigProvider(
                solver.getHierarchy(), solver.getTypeSystem());
        provider.setPath(configPath);
        TaintConfig configuration = provider.get();
        if (configuration.sources().isEmpty() || configuration.sinks().isEmpty()) {
            throw new IllegalStateException("Taint configuration resolved zero sources or sinks: sources="
                    + configuration.sources().size() + ", sinks=" + configuration.sinks().size()
                    + ". Check method/field signatures against the analyzed classpath.");
        }
        Object rawFlows = result.getResult(TaintAnalysis.class.getName());
        if (!(rawFlows instanceof Collection<?> values)) {
            throw new IllegalStateException("No TaintAnalysis result; configure a nonempty taint configuration");
        }
        List<TaintFlow> flows = new ArrayList<>();
        for (Object value : values) {
            if (!(value instanceof TaintFlow flow)) {
                throw new IllegalStateException("Unexpected taint result item " + value);
            }
            flows.add(flow);
        }
        Collections.sort(flows);
        ObjectFlowGraph graph = result.getObjectFlowGraph();
        List<Map<String, Object>> findings = new ArrayList<>();
        int availablePaths = 0;
        for (TaintFlow flow : flows) {
            Map<String, Object> source = sourceLocation(flow.sourcePoint());
            Map<String, Object> sink = callLocation(flow.sinkPoint().sinkCall());
            sink.put("kind", "call");
            sink.put("index", flow.sinkPoint().indexRef().toString());
            sink.put("configuredMethod", flow.sinkPoint().sink().method().getSignature());
            List<Map<String, Object>> path = propagationPath(graph, flow);
            if (!path.isEmpty()) availablePaths++;
            Map<String, Object> evidence = new LinkedHashMap<>();
            evidence.put("kind", "abstract-taint-propagation");
            evidence.put("source", source);
            evidence.put("sink", sink);
            evidence.put("path", path);
            evidence.put("pathStatus", path.isEmpty() ? "unavailable" : "computed");
            evidence.put("pathSemantics", "One shortest path in Tai-e's context-insensitive object-flow graph, "
                    + "restricted to nodes containing a taint object from this source. It is an abstract "
                    + "propagation witness, not a proven feasible execution path or exploit.");
            if (path.isEmpty()) evidence.put("pathUnavailableReason",
                    "The result contains a source-to-sink taint flow but the exported object-flow graph "
                            + "does not expose a matching source-specific path; no intermediate steps were invented.");
            Map<String, Object> finding = new LinkedHashMap<>();
            finding.put("analysis", "taint");
            finding.put("type", "TAINT_FLOW");
            finding.put("severity", "WARNING");
            finding.put("className", sink.get("className"));
            finding.put("method", sink.get("method"));
            if (sink.containsKey("line")) {
                finding.put("startLine", sink.get("line"));
                finding.put("endLine", sink.get("line"));
            }
            finding.put("message", "Configured taint source may reach configured sink: " + flow);
            finding.put("evidence", evidence);
            findings.add(finding);
        }
        int reachableMethods = result.getCallGraph().getNumberOfMethods();
        if (reachableMethods == 0) throw new IllegalStateException("PTA analyzed no reachable methods");
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("plugin", getClass().getName());
        metadata.put("pluginLifecycleCompleted", true);
        metadata.put("observedMethodCallbacks", observedMethods);
        metadata.put("reachableMethods", reachableMethods);
        metadata.put("reachableApplicationMethods", result.getCallGraph().reachableMethods()
                .filter(JMethod::isApplication).count());
        metadata.put("explicitEntry", mainMethod.getSignature());
        metadata.put("explicitEntryReachable", true);
        metadata.put("callGraphEdges", result.getCallGraph().getNumberOfEdges());
        metadata.put("objectFlowNodes", graph.getNodes().size());
        metadata.put("taintFlows", flows.size());
        metadata.put("computedPaths", availablePaths);
        metadata.put("configuredSources", configuration.sources().size());
        metadata.put("configuredSinks", configuration.sinks().size());
        metadata.put("configuredTransfers", configuration.transfers().size());
        metadata.put("configuredSanitizers", configuration.paramSanitizers().size());
        metadata.put("contextSensitivity", solver.getOptions().getString("cs"));
        metadata.put("onlyApplicationCode", solver.getOptions().getBoolean("only-app"));
        metadata.put("taintConfig", solver.getOptions().getString("taint-config"));
        metadata.put("pathSemantics", "abstract propagation; not proof of path feasibility");
        return new Export(findings, reachableMethods, metadata);
    }

    private static Map<String, Object> location(JMethod method, Stmt statement) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("className", method.getDeclaringClass().getName());
        value.put("method", method.getSignature());
        if (statement != null) {
            if (statement.getLineNumber() > 0) value.put("line", statement.getLineNumber());
            value.put("statement", statement.toString());
            value.put("statementIndex", statement.getIndex());
        }
        return value;
    }

    private static Map<String, Object> callLocation(Invoke call) {
        Map<String, Object> value = location(call.getContainer(), call);
        value.put("calledMethod", call.getMethodRef().toString());
        return value;
    }

    private static Map<String, Object> sourceLocation(SourcePoint point) {
        Map<String, Object> value;
        if (point instanceof CallSourcePoint call) {
            value = callLocation(call.sourceCall());
            value.put("kind", "call");
            value.put("index", call.indexRef().toString());
            value.put("configuredMethod", call.source().method().getSignature());
        } else if (point instanceof ParamSourcePoint param) {
            // Bytecode parameter metadata has no reliable declaration line.
            // Deliberately do not substitute the first body statement's line.
            value = location(param.sourceMethod(), null);
            value.put("kind", "parameter");
            value.put("index", param.indexRef().toString());
            value.put("statement", "method parameter " + param.indexRef());
        } else if (point instanceof FieldSourcePoint field) {
            value = location(field.getContainer(), field.loadField());
            value.put("kind", "field-load");
            value.put("configuredField", field.source().field().getSignature());
        } else throw new IllegalStateException("Unknown source point " + point);
        return value;
    }

    private List<Node> indexedNodes(ObjectFlowGraph graph, Var variable, IndexRef index) {
        if (variable == null) return List.of();
        if (index.kind() == IndexRef.Kind.VAR) {
            Node node = graph.getVarNode(variable);
            return node == null ? List.of() : List.of(node);
        }
        List<Node> nodes = new ArrayList<>();
        for (Obj object : result.getPointsToSet(variable)) {
            Node node = index.kind() == IndexRef.Kind.ARRAY ? graph.getArrayIndexNode(object)
                    : graph.getInstanceFieldNode(object, index.field());
            if (node != null) nodes.add(node);
        }
        return nodes;
    }

    private List<Node> sourceNodes(ObjectFlowGraph graph, SourcePoint point) {
        if (point instanceof CallSourcePoint call) {
            return indexedNodes(graph, InvokeUtils.getVar(call.sourceCall(), call.indexRef().index()), call.indexRef());
        }
        if (point instanceof ParamSourcePoint param) {
            int index = param.indexRef().index();
            Var variable = index == InvokeUtils.BASE ? param.sourceMethod().getIR().getThis()
                    : param.sourceMethod().getIR().getParam(index);
            return indexedNodes(graph, variable, param.indexRef());
        }
        if (point instanceof FieldSourcePoint field) {
            Node node = graph.getVarNode(field.loadField().getLValue());
            return node == null ? List.of() : List.of(node);
        }
        return List.of();
    }

    private Set<Obj> pointsTo(Node node) {
        if (node instanceof VarNode variable) return result.getPointsToSet(variable.getVar());
        if (node instanceof InstanceFieldNode field) return result.getPointsToSet(field.getBase(), field.getField());
        if (node instanceof ArrayIndexNode array) return result.getPointsToSet(array.getBase());
        if (node instanceof StaticFieldNode field) return result.getPointsToSet(field.getField());
        return Set.of();
    }

    private List<Map<String, Object>> propagationPath(ObjectFlowGraph graph, TaintFlow flow) {
        SourcePoint sourcePoint = flow.sourcePoint();
        Set<Node> targets = new HashSet<>(indexedNodes(graph,
                InvokeUtils.getVar(flow.sinkPoint().sinkCall(), flow.sinkPoint().indexRef().index()),
                flow.sinkPoint().indexRef()));
        Map<Node, Boolean> tainted = new HashMap<>();
        java.util.function.Predicate<Node> containsSource = node -> tainted.computeIfAbsent(node, key ->
                pointsTo(key).stream().anyMatch(object -> Objects.equals(object.getAllocation(), sourcePoint)));
        Map<Node, FlowEdge> previous = new HashMap<>();
        ArrayDeque<Node> queue = new ArrayDeque<>();
        Set<Node> visited = new HashSet<>();
        sourceNodes(graph, sourcePoint).stream().sorted(Comparator.comparing(Node::toString)).forEach(node -> {
            if (containsSource.test(node) && visited.add(node)) queue.add(node);
        });
        Node target = null;
        while (!queue.isEmpty()) {
            Node current = queue.removeFirst();
            if (targets.contains(current)) { target = current; break; }
            graph.getOutEdgesOf(current).stream()
                    .sorted(Comparator.comparing((FlowEdge edge) -> edge.target().toString()).thenComparing(FlowEdge::info))
                    .forEach(edge -> {
                        if (containsSource.test(edge.target()) && visited.add(edge.target())) {
                            previous.put(edge.target(), edge);
                            queue.addLast(edge.target());
                        }
                    });
        }
        if (target == null) return List.of();
        List<Node> nodes = new ArrayList<>();
        List<FlowEdge> edges = new ArrayList<>();
        for (Node cursor = target; cursor != null;) {
            nodes.add(cursor);
            FlowEdge edge = previous.get(cursor);
            if (edge == null) break;
            edges.add(edge);
            cursor = edge.source();
        }
        Collections.reverse(nodes);
        Collections.reverse(edges);
        List<Map<String, Object>> path = new ArrayList<>();
        for (int index = 0; index < nodes.size(); index++) {
            Map<String, Object> step = nodeLocation(nodes.get(index));
            step.put("step", index);
            if (index > 0) {
                step.put("incomingEdgeKind", edges.get(index - 1).kind().name());
                step.put("incomingEdgeInfo", edges.get(index - 1).info());
            }
            path.add(step);
        }
        return path;
    }

    private static Map<String, Object> nodeLocation(Node node) {
        Map<String, Object> value;
        if (node instanceof VarNode variable) {
            Var var = variable.getVar();
            value = location(var.getMethod(), null);
            List<Map<String, Object>> definitions = new ArrayList<>();
            for (Stmt statement : var.getMethod().getIR()) {
                if (statement.getDef().filter(var::equals).isPresent()) definitions.add(location(var.getMethod(), statement));
            }
            // A variable may have several definitions. Preserve every actual
            // definition instead of presenting one arbitrary line as the edge.
            if (definitions.size() == 1) value.putAll(definitions.get(0));
            else if (!definitions.isEmpty()) value.put("definitions", definitions);
            value.put("variable", var.getName());
        } else if (node instanceof StaticFieldNode field) {
            value = new LinkedHashMap<>();
            value.put("className", field.getField().getDeclaringClass().getName());
            value.put("field", field.getField().getSignature());
        } else {
            value = new LinkedHashMap<>();
            if (node instanceof InstanceFieldNode field) value.put("field", field.getField().getSignature());
        }
        value.put("node", node.toString());
        value.put("nodeKind", node.getClass().getSimpleName());
        value.put("nodeIndex", node.getIndex());
        return value;
    }
}
