# 检测器、插件与结构化输出

聊天中的完整配置面板、修复确认及逐轮控制见 [交互配置与修复确认](interactive-settings.md)。

## 扩展模式

```powershell
npm run setup:taie-source
npm run build:taie-source
npm run start:extended -- chat --project examples/playground
```

扩展启动器读取 `.tools/tai-e/source-build.json`，校验实际 JAR 的摘要，选择本地构建，并默认启用：

`dropped-exception`、`clone-idiom`、`dead-code`、`null-pointer`、`division-by-zero`。

也可只运行分析：

```powershell
npm run analyze:extended -- --project examples/division-buggy
npm run analyze:extended -- --project examples/division-clean
```

基础 `npm start` / `npm run analyze` 继续使用固定官方 JAR，兼容已有使用方式。启动器允许通过显式 `--analyses` 选择分析组合。

扩展模式的 CLI 同样默认 `repair-mode=ask`：发现告警后，每轮修复都先询问 `[y/N]`；空输入、拒绝或 EOF 保留告警，等待人工决定不计入执行时限。`/repair auto` 启用有界自动修复，`/repair off` 保留缺陷并继续检测；消息前缀 `--no-repair` 只对当前任务关闭修复。JSON 模式下 `ask` 不询问，直接保留告警。

### 按轮次跳过检测

扩展模式也支持 `--skip-taie`，例如先做一次说明：

```powershell
npm run start:extended -- run --project examples/playground --skip-taie --prompt '解释静态分析'
```

交互消息使用前缀：

```text
--skip-taie 先讨论设计
```

它只影响当前任务；下一条消息恢复会话检测默认值。`/analysis on` 或 `/analysis off` 可以修改该默认值。单独输入 `--skip-taie` 会让下一条实际任务跳过；启动 `chat` 时传入该标志也只影响首条实际任务。该选项不用于独立的 `analyze` 命令。

跳过时，`taie_analyze` 和 `taie_get_finding` 均停用，宿主不执行 Tai-e 编译、分析或自动修复循环。普通读写和 shell 工具仍可用。正常完成后返回 `outcome: "skipped"`、`skipTaie: true`、`checks: []`、`repairRounds: 0`，CLI 退出码为 `0`；这表示未做静态验证。默认检查实际通过才返回 `verified`，模型请求失败或超时仍返回 `agent_error`。

## 检测器

### 空指针异常修复

新前端会使用带 `NullType` 的临时常量变量表示 `null`。补丁使 `IsNullFact` 从常量本身读取空值语义，接受引用类型并避免更新常量，修复直接 null 方法调用、数组解引用触发的 `UnsupportedOperationException`。

这次改动修复已复现的实现异常，没有把方法内启发式检测器变成任意 Java 程序的 sound 验证器。

### 整数除零检测

`division-by-zero` 是注册到 Tai-e 的真实 `MethodAnalysis`。它使用 IR、控制流图、int 常量传播和 long 常量数据流，检查确定为零的整数除法与取余：

- `INTEGER_DIVIDE_BY_ZERO`
- `INTEGER_REMAINDER_BY_ZERO`

参数未知值和浮点运算不报告。规则会处理已知条件的不可达分支、long 比较、整数提升及被捕获的算术异常。它的覆盖受方法内常量域限制，例如未知参数的跨方法取值和一般关系约束不在当前能力中。

宿主自动配置 `throw(exception=all)` 和 `cfg(exception=all)`，并通过 Tai-e 原生 planner 展开依赖。直接调用原生 CLI 时需显式配置：

```powershell
java -jar vendor/Tai-e/build/tai-e-all-0.5.4.jar -acp <classes目录> -scope APP -a throw=exception:all -a cfg=exception:all -a division-by-zero
```

缺少需要的隐式算术异常模型时，规则明确拒绝运行，防止静默遗漏 catch 路径。

## 污点分析与证据插件

```powershell
npm run analyze -- --project examples/taint-buggy
npm run analyze -- --project examples/taint-clean
```

示例通过 `taie-agent.json` 指定入口及 source/sink 配置：

```json
{
  "analyses": ["taint"],
  "mainClass": "example.Main",
  "sourceRoots": ["src/main/java"],
  "taintConfig": "taint.yml",
  "taintImplicitEntries": false
}
```

`taint` 映射到 Tai-e PTA 和内置 TaintAnalysis。`java-adapter/AgentEvidencePlugin.java` 实现真实 PTA Plugin 生命周期，观察完成的求解器，不修改 points-to 状态。它读取实际 `TaintFlow`、调用图和 `ObjectFlowGraph`，导出：

- source / sink 方法、调用语句及可靠行号。
- 与同一污点 source 对象关联的实际抽象传播路径及边类型。
- 显式入口、可达应用方法、调用图边数、规则数量、插件完成状态。

传播路径是静态过近似图中的证据，不证明路径可在运行时执行，也不证明漏洞可利用。拿不到匹配路径时保留告警，并标为 `pathStatus: unavailable`；不会编造中间步骤或声明行号。

宿主默认保留 `implicit-entries=true`、`only-app=false`。示例为缩短运行时间显式关闭隐式 JVM 入口，并在报告中记录覆盖限制。需要完整默认入口建模时，删除或改成 `taintImplicitEntries: true`。

无有效入口、入口没有进入调用图、空 source/sink 策略、无法解析的 source/sink/transfer/sanitizer 规则、缺类或分析超时都会明确失败。当前策略要求配置的规则能够在目标中解析；通用大规则库中的可选规则需先裁剪到目标项目。

agent 在当前分析配置首次实际调用分析时读取并固定污点规则文本；该配置下的工具分析、宿主复查和修复轮次复用这一策略。跳过检测的任务不会读取污点规则文件。用户在任务之间修改分析配置会重置快照，下一轮实际分析时读取新策略；每次分析的规则副本和摘要保存在分析目录。仅修改磁盘文件或重复 `/set` 相同路径不会刷新快照，可先 `unset` 再设回策略路径，或开启新会话。

## JSON、SARIF 与复核记录

外置 `java-adapter/TaieAgentExporter.java` 直接读取分析结果对象，避免解析控制台告警文本。每次分析保留以下证据；若编译或配置阶段失败，尚未运行的步骤不会生成对应文件：

| 文件 | 用途 |
| --- | --- |
| `findings.raw.json` | exporter 成功运行后生成的原始结果和分析覆盖元数据 |
| `report.json` | schema v2：源码位置、片段、稳定 ID、证据、版本和日志位置 |
| `results.sarif` | SARIF 2.1.0：告警、位置、相关位置与传播 code flow |
| `triage.json` | 独立复核模板，初始全部为 `unreviewed` |
| `analysis-plan.json` / `tai-e-plan.yml` | 请求的分析组合与原生 planner 展开的完整依赖 |

失败分析也输出 JSON/SARIF，SARIF invocation 标为 `executionSuccessful: false`。原始报告保留；复核状态不会删除告警或让宿主忽略它。

`skipped` 任务仍保存 agent 运行结果和对话日志，由于没有执行分析，不会为本轮新增分析报告或 SARIF。自动化调用应区分 `skipped` 和 `verified`，二者退出码都为 `0`。

告警 ID 尽量独立于运行目录和纯行号变化。相同方法中相同语句的多个告警按出现顺序区分；插入一个完全相同的更早实例仍可能改变这组重复告警的 ID。

agent 提供两个分析工具：

- `taie_analyze`：新的编译和完整配置分析。
- `taie_get_finding`：按最新报告的告警 ID 提取局部证据；修改代码后仍需重新分析。

## 补丁与验证

源码仍在独立的 `vendor/Tai-e` Git 仓库中，新增功能同时导出为 `patches/tai-e-agent.patch`。新检出时 `setup:taie-source` 自动应用补丁，已有修改会保留；遇到冲突会停止并说明原因。后续修改源码后，可更新和验证补丁：

```powershell
npm run export:taie-patches
npm run test:taie-patches
```

补丁验证从固定上游提交导出干净基线，实际应用补丁，并逐文件对比当前源码。

```powershell
npm run typecheck
npm test
npm run test:taie-source
npm run test:live:extended
```

最后一个命令使用环境中的 DeepSeek API key，会产生 API 用量。它先让模型回复 READY，由宿主检出真实除零告警，再向模型发送反馈，要求取证和修复；最终独立执行 Java 正数、负数、零分子和零分母断言。
