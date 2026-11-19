# 功能验证记录

测试执行日期：2026-10-21（Asia/Shanghai）；文档整理日期：2026-10-22。最新扩展验证见文末；前面的记录保留各阶段的基线结果，不涉及模型/框架比较实验。

## 环境

| 组件 | 实际版本 |
| --- | --- |
| Node.js | 24.4.0 |
| JDK | Temurin 21.0.5 |
| Pi SDK | 0.85.1 |
| Tai-e | 官方 0.5.4 fat JAR |
| 真实模型 | `deepseek/deepseek-v4-flash` |

Tai-e SHA-256：`703d1750b66e8e621d628ac93b07a21315db795b3a1e2224001ad09190c1e4be`。

## 本地验证

- `npm run setup:taie`：固定版本 JAR 校验通过。
- `npm run doctor`：Java、javac、JAR 均可用。
- `npm run typecheck`：通过。
- `npm test`：**12/12 通过**，约 30.20 秒；不调用模型。

其中 5 项使用真实 Java/Tai-e，验证了吞异常告警及修复后的新分析、编译失败、上游空指针检测器异常、取消/缺工具/非法规则、两个 classpath 依赖及合法的 `test` 包。其余测试覆盖宿主复查、修复预算、失败状态和源码范围固定。

## 真实模型端到端验证

执行：`npm run test:live`。用户明确授权后，使用现有环境密钥调用 DeepSeek API。

总结果：**passed**。完整机器可读证据：

[`result.json`](../.taie-agent/live-smoke/2026-10-21T12-33-47-969Z-38996/result.json)

### 从零生成 Java 程序

- 模型实际调用 `write` 写入 `Greeter.java`，使用 shell，并调用 `taie_analyze`。
- 宿主独立执行新的编译与 Tai-e 分析，结果为 `verified`。
- 模型运行之外，再用独立 javac 编译源文件和断言程序。
- 实际执行 main，确认普通参数输出 `Hello, Tai-e!`，没有参数时输出 `Hello, stranger!`。
- 独立 Java 断言验证普通名字、null、空字符串。

生成代码：[`Greeter.java`](../.taie-agent/live-smoke/2026-10-21T12-33-47-969Z-38996/generated/src/main/java/Greeter.java)。

### 检测并修复既有缺陷

- 在模型运行前，真实 Tai-e 对原始空 catch 示例报告 `DE_MIGHT_IGNORE`。
- 模型调用 `taie_analyze`，事件记录证实它收到原始源码对应的真实告警。
- 模型读取、重写代码，再次调用 `taie_analyze`。
- 最后一次独立宿主检查完成且没有剩余告警，源码指纹变化，原始报告保持不变。
- 独立 Java 执行确认有效整数输入保持成功；非法整数输入显式失败，异常 cause 保留 `NumberFormatException`。

修复代码：[`Main.java`](../.taie-agent/live-smoke/2026-10-21T12-33-47-969Z-38996/seeded-repair/src/main/java/example/Main.java)。

## 首版基线边界

首版默认覆盖 `dropped-exception`、`clone-idiom`、`dead-code`。官方 Tai-e 0.5.4 的 `null-pointer` 在已测输入上存在上游异常，没有默认启用；系统会保留失败证据。后续扩展已修复该异常，见文末。当前没有自动解析 Maven/Gradle 依赖、执行其测试生命周期、为框架补全入口模型，或给出任意 Java 程序的无 bug 保证。

首版宿主自动修复反馈的状态机由本地测试验证；当时两个真实模型案例均在初次模型阶段完成了修改，之后的宿主检查通过。后续扩展验证补上了“宿主检查失败后再发送修复反馈”的真实模型案例。

## 初始源码开发支持验证

同日增加源码开发工作流后：

- 官方 `v0.5.4` 源码已检出到 `vendor/Tai-e/`，基线提交 `6474e7da62fb1f3b692331040e66692cbf4d630d`。
- 官方 Gradle wrapper 的 `fatJar` 构建成功，没有修改上游源码。
- Gradle 使用本机已有 Microsoft JDK 17 编译；运行 Gradle 的 JVM 为 JDK 21。
- `npm run typecheck` 通过，`npm test` 更新为 **14/14 通过**。
- 新增测试验证：显式自定义 JAR 的 SHA-256 可以区别于官方发行版；默认 JAR 被篡改时仍被拒绝；无效自定义 JAR 不能返回完成。
- `npm run test:taie-source` **passed**：实际源码构建对 clean 示例返回空告警，对 buggy 示例检出 `DE_MIGHT_IGNORE`，并通过 `TAIE_JAR` 的子进程 CLI 选择流程。

源码构建检查证据：[`result.json`](../.taie-agent/source-smoke/2026-10-21T12-50-54-927Z/result.json)。

该阶段没有再次请求大模型；源码构建通过同一个已验证的 `analyzeJavaProject` 接口供 agent 使用。

## 检测器、插件与结构化输出扩展验证

最终源码构建使用同一上游基线，包含空指针回归修复和新增 `division-by-zero` 检测器；PTA 证据插件与 exporter 位于 `java-adapter/`。JAR SHA-256：`729969c14d007696ad4093bd9329ca1fbea3460f9c25c9f4d550e8d42d19d27a`。构建工具链与源码状态保存在 [source-build.json](../.tools/tai-e/source-build.json)。

### 本地与原生测试

- `npm run typecheck`：通过。
- `npm test`：**24/24 通过**，约 74.9 秒，不请求模型。覆盖真实编译/分析、污点正反例与非法策略、SARIF 与告警 ID、宿主复查、配置和 artifact 校验。
- Tai-e 定向原生测试：**5/5 通过**。新增除零测试逐方法验证 21 个场景；空指针字节码测试验证 4 个方法，并运行已有 `IsNullTest`、`NullPointerDetectionTest` 回归。
- `checkstyleMain`、`checkstyleTest`：通过。
- SARIF 输出使用 OASIS SARIF 2.1.0 JSON schema 校验，通过；包含传播证据与失败报告两种情况。

原生测试结果在 [`build/test-results/test/`](../vendor/Tai-e/build/test-results/test/)。可在 Tai-e 目录复现定向测试及风格检查：

```powershell
Push-Location vendor/Tai-e
.\gradlew.bat :test --tests pascal.taie.analysis.bugfinder.DivisionByZeroTest --tests pascal.taie.analysis.bugfinder.NullLiteralBytecodeTest --tests pascal.taie.analysis.bugfinder.IsNullTest --tests pascal.taie.analysis.bugfinder.NullPointerDetectionTest checkstyleMain checkstyleTest --no-daemon
Pop-Location
```

### 补丁与源码后端

`npm run test:taie-patches`：**passed**。从固定上游提交导出干净基线，实际应用补丁，并确认 9 个文件与当前检出一致。证据：[`result.json`](../.taie-agent/patch-verification/2026-10-21T13-24-28-582Z/result.json)。

`npm run test:taie-source`：**passed**。7 个实际分析均完成：

| 场景 | 结果 |
| --- | --- |
| clean | 无告警 |
| buggy 空 catch | `DE_MIGHT_IGNORE` |
| null 常量解引用 | `NP_ALWAYS_NULL`，不再发生分析器异常 |
| 整数除零缺陷 | `INTEGER_DIVIDE_BY_ZERO` |
| 整数除零修复例 | 无告警 |
| 污点、除零和空指针组合 | `TAINT_FLOW`，插件完成并导出实际抽象传播路径 |
| `TAIE_JAR` 环境变量选择 | 使用相同源码构建，clean 无告警 |

源码后端完整证据：[`result.json`](../.taie-agent/source-smoke/2026-10-21T13-27-50-106Z/result.json)。

### 真实模型接收宿主反馈并修复

`npm run test:live:extended`：**passed**，使用已获授权的 DeepSeek API，模型为 `deepseek/deepseek-v4-flash`。

1. 模型先回复 READY，暂不修改测试程序；宿主执行真实分析，检出 1 个 `INTEGER_DIVIDE_BY_ZERO`。
2. 宿主把真实告警交回模型；事件记录包含 `taie_get_finding`、`read`、`write` 和 `taie_analyze`，确认模型获取证据后修改代码并重新分析。
3. 最后一次独立宿主编译和分析完成，告警数为 0，`repairRounds: 1`，结果为 `verified`。
4. 模型之外，独立编译和执行 Java 断言：正数、负数、零分子结果正确，零分母抛出预期的 `IllegalArgumentException`。

完整机器可读证据：[`result.json`](../.taie-agent/live-extended/2026-10-21T13-27-59-742Z/result.json)。

### 当前能力边界

扩展启动器默认启用基础三项、空指针和除零检测；污点分析需显式指定入口及 source/sink 策略。整数除零检测使用方法内常量域，未知参数值和浮点除法不在其报告范围。污点传播路径来自静态抽象图，不证明运行时路径可行或漏洞可利用。误报复核状态独立保存在 `triage.json`，不会删除原始告警或自动跳过宿主检查。

这些结果证明当前工程闭环和已测场景可用，不构成任意 Java 程序的 soundness 或无缺陷保证。运行方式和配置见 [扩展功能说明](extensions.md)。

## 按轮次跳过 Tai-e 验证

验证日期：2026-10-22（Asia/Shanghai）。新增 `run --skip-taie`、chat 消息前缀 `--skip-taie` 和程序接口 `agent.run(task, { skipTaie: true })`。开关只影响本轮；下一轮默认恢复。跳过期间停用两个 Tai-e 工具，宿主不编译、不分析、不发起自动修复，正常结果为 `skipped`，而非 `verified`。

### 定向回归与真实模型

- `npm run typecheck`：通过。
- `node --test tests/verification.test.ts tests/turn.test.ts`：**11/11 通过**。覆盖本轮跳过、下一轮恢复、修复流程、模型错误仍失败、消息前缀与单独标志，以及在正文中提到标志不会触发跳过。
- CLI 帮助包含新参数；`analyze --skip-taie` 明确拒绝不适用的选项，退出码为 1。
- 真实 DeepSeek 单次 CLI：故意指定不存在的 JAR 和污点配置文件，普通问答仍正常完成，`outcome: skipped`、`checks: []`、`toolCalls: []`，退出码为 0。证明跳过轮次无需预先构建项目或读取污点规则。证据：[`result.json`](../.taie-agent/skip-taie-smoke/2026-10-22/.taie-agent/agent-runs/1792649726551-179efaeb/result.json)。
- 真实 DeepSeek 同会话两轮：第一轮显式跳过，且未创建分析输出目录；第二轮不传开关，宿主执行一次新编译与分析并返回 `verified`。两轮检测数分别为 0 和 1。证据：[`result.json`](../.taie-agent/skip-taie-smoke/2026-10-22T06-18-17-943Z/result.json)。

真实模型请求沿用用户已授权的 DeepSeek API。首次受限环境请求发生连接错误，结果保持 `agent_error`、空检查记录；允许联网的执行环境中验证成功。

### 完整回归的耗时限制

本次 `npm test` 共 30 项：26 项通过，4 项因超过既有时间阈值被取消，没有逻辑断言失败。Tai-e 调用的墙钟耗时明显高于前一日，本轮没有修改 `src/taie.ts` 或检测器源码，也没有放宽测试阈值。

其中吞异常修复与双依赖两例单独复跑通过，分别耗时 76.45 秒和 46.88 秒。证据：[`复跑记录`](../.taie-agent/skip-taie-smoke/elevated-java-recheck-20261022-141737.json)。显式开发 JAR 用例单独复跑仍超过 60 秒，证据：[`开发 JAR 超时记录`](../.taie-agent/skip-taie-smoke/elevated-development-recheck-20261022-142024.json)；污点契约与非法配置用例仍超过 90 秒，证据：[`污点契约超时记录`](../.taie-agent/skip-taie-smoke/elevated-taint-contract-recheck-20261022-142221.json)。因此本次完整回归不记为全量通过，提升执行也未完全消除耗时问题，根因尚未确定。本轮未改检测器实现和测试阈值；[复跑汇总](../.taie-agent/skip-taie-smoke/java-rechecks-summary.json) 保留了各例结果。

## 人工选择修复与交互配置

验证日期：2026-10-22（Asia/Shanghai）。CLI 默认修复策略改为 `ask`，并支持 `auto`、`off`。聊天启动展示全部 18 项设置，`/config`、`/set`、`/repair`、`/analysis` 在宿主本地处理；配置从下一条任务生效。单轮覆盖新增 `--no-repair`，与已有 `--skip-taie` 可组合。使用方式见 [交互配置说明](interactive-settings.md)。

### 宿主与 UI 回归

- `npm run typecheck`：通过。
- `npm run test:host`：**53/53 通过**，不请求模型或运行 Java。
- 其中 5 项实际启动 CLI 子进程，预先输入多行本地配置命令，确认参数更新、无效值保留原状态、项目切换与配置优先级、完整帮助信息；子进程移除模型凭据并指定不存在的 JDK，未创建 agent/分析目录或修改项目配置文件。
- 修复状态机覆盖逐轮同意、拒绝、缺少回调、关闭修复、自动修复、预算耗尽与错误状态。工具权限检查覆盖同一批次中分析后出现的写文件调用，以及原有 Pi 工具策略的保留。
- 输入队列验证模型运行期间预输入不丢失、EOF、关闭与确认输入和下一任务输入的隔离。

CLI 默认 `ask`；为兼容已有程序接口，直接调用 agent API 且省略 `repairMode` 时仍采用 `auto`。JSON 模式下 `ask` 不进行交互询问，保留告警；人工等待时间不计入执行预算。

### 真实 DeepSeek 三阶段验证

执行 `npm run test:live:policy`，结果 **passed**。沿用已获授权的 DeepSeek API，在私有合成 Java 项目上使用同一个 agent 会话：

| 阶段 | 结果 | 修复与源码变化 |
| --- | --- | --- |
| `off`，模型主动调用 Tai-e 展示除零告警 | `unresolved` | 0 轮修复，源码哈希保持不变 |
| 切到 `ask`，同时更新检测器组合，确认回调拒绝 | `unresolved` | 询问一次，0 轮修复，源码哈希保持不变 |
| `ask` 确认回调明确同意 | `verified` | 执行 1 轮修复，真实 write/edit 成功，最终宿主编译与分析无告警 |

检测器组合在同一会话中从 `division-by-zero` 更新为 `division-by-zero,null-pointer`，宿主报告确认新配置生效，未丢弃会话历史。批准后的程序另由独立 `javac` / `java` 验证正数、负数、零分子、零分母、整数截断和负分母行为。

完整证据：[`result.json`](../.taie-agent/live-policy/2026-10-22T11-25-03-038Z-aafb4619/result.json)。独立执行证据：[`independent-execution.json`](../.taie-agent/live-policy/2026-10-22T11-25-03-038Z-aafb4619/independent-execution.json)。

本轮没有修改 Tai-e 检测器或 Java 适配器源码，也没有重新运行包含全部 Java 用例的 `npm test`；此前记录的原生调用耗时问题未在本轮修复。

## 首步 Maven 容器检查

本节保留告警分层修复前的运行记录；其中依赖告警影响顶层状态的行为已在后续修复，当前语义见下一节。

验证日期：2026-11-03（Asia/Shanghai）。本步增加独立 `check-maven`，尚未接入聊天与模型工具。运行方式和边界见 [Maven 容器检查](maven-check.md)。未调用大模型，未修改 Tai-e 检测器。

本机 Docker Linux 引擎 29.8.0 实际完成镜像构建及运行。容器使用 Maven 3.9.9、JDK 17.0.15、Node 22.19.0；实际镜像 ID 为 `sha256:d4d506626439f4a823686a3b958d029e02b3a3e15d31b5b793406746ebd3c101`。测试使用固定官方 Tai-e 0.5.4 和 `dropped-exception` 检测器。

### 本地定向检查

- `npm run typecheck`：通过。
- `npm run test:host`：**63/63 通过**，其中新增 10 项覆盖进程结果与超时、Maven 元数据与编译输入、Surefire 状态、快照隔离和变化识别。
- 既有 Java 测试中的编译错误与默认 JAR 篡改两项定向回归：**2/2 通过**。
- 真实宿主吞异常探针成功，编译、exporter 编译、分析阶段分别为 641、2242、3193 毫秒。证据：[report.json](../.taie-agent/host-stage-probe/2026-11-02T18-33-27-309Z/.taie-agent/runs/2026-11-02T18-33-27-330Z-1fd25834/report.json)。这次未复现历史超时，不代表已找到或修复其根因。

### 真实 Maven / Tai-e 五场景

`npm run test:maven`：**五个场景均通过预期断言**。项目在独立副本中修改；构建、JUnit 和 Tai-e 都真实执行。首次案例允许准备依赖联网，其余准备阶段离线；所有检查阶段均使用 `--network none`。结果与各阶段原始日志见 [result.json](../.taie-agent/maven-smoke/2026-11-02T19-11-48-167Z/result.json)。

| 场景 | 结果 | 已验证行为 | 总耗时 |
| --- | --- | --- | --- |
| 使用 Commons Lang 的正常项目 | `findings` | 编译与 1 个 JUnit 测试通过；保留 24 条依赖告警，项目类无告警。 | 247.45 秒 |
| 故意失败的 JUnit 断言 | `test_failed` | 编译通过，真实测试失败，未被分析结果覆盖。 | 139.67 秒 |
| Java 语法错误 | `build_failed` | 编译失败，不运行 Tai-e。 | 121.06 秒 |
| 项目类加入吞异常方法 | `findings` | 检出 `example.Greeter` 的 `DE_MIGHT_IGNORE`，连同依赖共 25 条。 | 212.35 秒 |
| 单独的 JDK 实现对照 | `passed` | 1 个测试通过，分析完成且无告警。 | 127.39 秒 |

报告同时确认：Tai-e 消费 Maven classes，无二次项目 javac；记录真实 classpath、镜像、阶段时间及 Surefire XML；`review: not_run`。这些结果不包含误报确认或产品级人工验收。

另以最终宿主代码运行真实 CLI，使用自定义 Maven 构建目录 `custom-output`：返回 `passed`、退出码 0，1 个测试通过、零告警，分析产物路径为 `custom-output/classes`，耗时 125.08 秒。检查前后原项目输入指纹一致，构建输出未被误判为 `stale`。证据：[CLI result.json](../.taie-agent/maven-cli-smoke/2026-11-03-custom-output/result.json)。

### 调试证据与未完成项

首次全量依赖准备触及 600 秒时限，命名容器随后被清理，结果为 `timeout`，见 [超时报告](../.taie-agent/maven-smoke/2026-11-02T18-27-14-588Z/project/.taie-agent/maven-runs/2026-11-02T18-27-14-614Z-4a7dc9e2/report.json)。随后确认全量 `go-offline` 下载了无关的发布插件，改为仅准备 clean 至 test 所需插件及项目依赖；未扩大默认时限。

离线 `help:evaluate` 的插件前缀解析失败后，源码发现改为读取实际编译生成的 `inputFiles.lst`，见 [失败阶段报告](../.taie-agent/maven-smoke/2026-11-02T18-48-46-736Z/project/.taie-agent/maven-runs/2026-11-02T18-48-46-766Z-5b9fc21f/report.json)。带依赖的首个成功分析还暴露了 `APP` 包含非 JRE 库类的事实，因此保留依赖告警，并独立设置零告警对照，没有删除告警来令测试通过。

以上耗时来自单次本机运行和已有依赖缓存，不是性能基准；最终实现尚未在全空 Maven 缓存下重新验收。注解处理专项、无测试和更多失败类型的容器端到端覆盖、隔离攻击探针、JDK 17 污点回归、聊天迁移与后续复核/补丁流程均仍待开发。本轮未重跑全量 `npm test` 或源码检测器原生套件。

## Maven 项目与依赖告警分层

本节保留 Linux 卷优化前的验证结果；后续提速和整轮回归进展见下一节。

修复日期：2026-11-03（Asia/Shanghai）。此前虽然记录了 APP 包含非 JRE 依赖的 limitation，仍把全部告警计入 `findings` 状态，无法用于项目告警复核与指标统计。本次修正 Maven 报告，保留旧运行证据。

顶层 Maven 协议升级为 `schemaVersion: 2`，状态范围为 `statusScope: "project"`。按真实编译输出类清单为告警添加 `origin`；`analysis.findings` 始终只含项目告警，`findingCounts` 分别统计项目、依赖及总数。默认隐藏依赖详情，`--include-dependencies` 将其单列显示；两个模式的项目状态及退出码一致。SARIF 记录 origin，复核模板保持项目与依赖列表分离。原始 APP 报告、传播证据和完整依赖告警文件保留。

本次没有改 Tai-e 分析范围、classpath、检测器规则或项目代码来消除告警。归属按主报告位置决定；依赖告警没有被认定为误报。尚未迁移的聊天及独立 `analyze` 入口维持原有语义。

- `npm run typecheck`：通过。
- `npm run test:host`：**67/67 通过**。新增覆盖类产物归属、无源码映射与内部类、同名不同包、完整证据不变、JSON/SARIF/复核分层和 CLI 参数适用范围。
- 镜像已重建；旧镜像缺少 `findingScope` 时无法被当作新的项目结果接受。

对此前保留的真实 Maven 编译产物和 Tai-e 报告重新执行归属分类，得到正常依赖项目 `0 项目 / 24 依赖`、含吞异常项目 `1 项目 / 24 依赖`、JDK 对照 `0 / 0`；每例总数守恒、原始记录不变。证据：[历史报告归属核对](../.taie-agent/origin-replay/2026-11-03/result.json)。这是历史证据重放，不是新的整轮分析。

本轮新增的六场景 `test:maven` 在首例触及原有 600 秒总时限，后五例未执行，**不得记为六例通过**。准备阶段成功，但 Maven 各阶段较此前明显变慢；例如插件准备 107.94 秒、离线 classpath 解析 119.54 秒。证据：[冒烟结果](../.taie-agent/maven-smoke/2026-11-03T02-06-27-856Z/result.json)。随后带 `--include-dependencies` 的真实 CLI 离线整轮仍超时，正确返回 `timeout` 和退出码 1，见 [CLI 结果](../.taie-agent/origin-cli/2026-11-03/result.json)。没有增加默认时限，也没有将超时当作无告警；耗时根因未确定，整轮回归仍待通过。

为单独验证新 worker，另建工作副本，复用上述已成功准备的有效 POM 与依赖缓存，以原有 600 秒时限重新执行离线 `clean compile`、JUnit、默认三项 Tai-e 检测及分层。该阶段 **通过**，耗时 431.11 秒，worker 退出码 0：构建完成、1 个测试通过、分析完成，`findingScope: project`，计数为 **0 项目 / 71 依赖 / 71 总计**，默认没有 `dependencyFindings` 详情。证据：[独立离线阶段结果](../.taie-agent/origin-worker/2026-11-03T02-26-57-640Z/result.json)。这是新的真实分析，但不包含同一总时限内的依赖准备，因此不替代前述整轮回归。显式展示的 JSON/SARIF/复核分层由定向测试覆盖，真实 CLI 整轮成功仍待验证。

## Linux 卷存储优化

验证日期：2026-11-03（Asia/Shanghai）。将 Maven 缓存、输入及构建工作目录移到 Docker 的 Linux 卷，以批量导入/导出替代运行期间的 Windows bind mount 小文件访问。保持 Maven 调用次数、默认三检测器、JDK、依赖版本、2 CPU / 2 GiB 和 600 秒预算不变；本步没有缓存分析结果或删除依赖分析。

- 类型检查通过；宿主测试 **70/70 通过**，新增 3 项存储导出测试，包括实际符号链接拒绝，未跳过。
- 旧缓存约 64 MB，一次性复制到 `taie-maven-repository-v1-15e22985384c` 用时 43.87 秒；旧目录保留。该迁移和镜像构建不计入后续检查。证据：[迁移结果](../.taie-agent/volume-migration/2026-11-03T03-03-23-243Z/result.json)。
- 首个完整检查返回 `passed`，包含准备、构建、JUnit、Tai-e、导入/导出和清理，共 **275.51 秒**；项目告警 0、依赖告警 71。

同一示例的离线阶段单次对照：

| 阶段 | Windows 挂载 | Linux 卷 |
| --- | ---: | ---: |
| Maven 编译 | 64.17 秒 | 22.14 秒 |
| classpath | 131.93 秒 | 24.60 秒 |
| Maven 测试 | 88.43 秒 | 27.77 秒 |
| exporter 编译 | 24.59 秒 | 13.24 秒 |
| Tai-e 进程 | 108.44 秒 | 58.14 秒 |
| 整个离线 worker | **431.11 秒** | **153.54 秒** |

离线阶段耗时减少 **64.39%**。前后源码指纹、分析器 SHA-256、三个依赖 JAR 哈希、检测器组合、分析实体数和全部 71 条依赖告警 ID 一致；导出后的依赖、classes 和报告文件实际存在。对照证据：[result.json](../.taie-agent/volume-performance/2026-11-03/result.json)。这是单机单次前后对照，不是统计性能基准；宿主负载可能不同，不能将旧版仅离线阶段耗时与新版整轮耗时混为同一口径。

正常结束后删除本轮容器及临时卷，仅保留缓存卷。导出失败时保留工作卷并记录 `storage.recoveryVolume`，同时返回失败；半写 JSON 或不安全文件不能被默默丢弃后判为通过。阶段证据导出与清理在超时/取消后仍使用独立时限。

另在依赖准备开始后主动取消：返回 `timeout`，部分 Maven 阶段日志成功导出，两个临时卷均经 Docker 查询确认不存在，未误删持久缓存；整次约 68.93 秒。证据：[取消结果](../.taie-agent/volume-cancel/2026-11-03T03-19-07-245Z/result.json)及同目录卷不存在检查日志。导出失败保留卷分支已做代码复查，未声称完成容器故障注入验收。

`npm run test:maven` 的六个真实场景全部通过预期断言，均在原有 600 秒执行预算内完成。证据：[六场景结果](../.taie-agent/maven-smoke/2026-11-03T03-04-44-780Z/result.json)。

| 场景 | 结果 | 项目 / 依赖告警 | 整轮耗时 |
| --- | --- | --- | ---: |
| 默认隐藏依赖详情 | `passed` | 0 / 71 | 275.51 秒 |
| 显式展示依赖详情 | `passed` | 0 / 71 | 311.42 秒 |
| JUnit 断言失败 | `test_failed` | 0 / 71 | 354.03 秒 |
| Java 编译失败 | `build_failed` | 未运行分析 | 184.94 秒 |
| 项目吞异常 | `findings` | 1 / 71 | 292.21 秒 |
| JDK 实现对照 | `passed` | 0 / 0 | 269.95 秒 |

最终 Docker 查询未发现本轮任务容器或临时工作/输入卷，仅保留专用 Maven 缓存卷。新导出/清理逻辑的类型检查也通过。本轮未请求模型，未重跑完整 `npm test` 或检测器原生套件；当前仍为分钟级检查，重复 Maven 调用和 exporter 编译尚未优化。

## 聊天手动检查与统一阶段报告

验证日期：2026-11-03（Asia/Shanghai）。新增手动 `/check`、后端/依赖联网/依赖展示三项交互配置，以及独立 `check.json`，保留原有后端报告。此步没有接入模型工具、自动自检或误报复核。

- `npm run typecheck` 通过；`npm run test:host` **82/82 通过**。覆盖统一状态、项目/依赖分层、无凭据 CLI 检查、单轮覆盖保留、Maven 选择后禁止模型入口回退、切换项目重置联网设置、模拟终端 Ctrl+C 后继续输入。
- 复查修正源码冻结回归后，类型检查以及配置/CLI 定向测试 **12/12 通过**。已冻结的 javac 源码范围不因改变检测器等配置重新推断，同时不作为 Maven 手工覆盖传入。
- 从无模型凭据的真实 CLI 进程预输入 `/set build-backend maven-docker`、`/set dependency-network off`、`/analysis off`、`/check`、`/config`、`/exit`。离线 Maven 全链路 **117.87 秒**，返回 `passed`，构建和 1 个测试通过，分析完成，项目 0 / 依赖 71 条，默认不展开依赖详情，复核为 `not_run`。进程退出码 0，只产生 Maven 证据目录，没有模型会话或修复。证据：[运行记录](../.taie-agent/check-ui-validation/2026-11-03T04-18-14-319Z/result.json)、[统一报告](../.taie-agent/check-ui-validation/2026-11-03T04-18-14-319Z/project/.taie-agent/maven-runs/2026-11-03T04-18-14-707Z-c746caa2/check.json)；同目录保留 stdout/stderr。
- javac 对干净示例执行真实 `/check`，**14.68 秒**完成编译和默认三项分析，项目/依赖均零告警；统一状态正确返回 `tests_not_run`，测试、复核均为 `not_run`，CLI 退出码 1。证据：[运行记录](../.taie-agent/check-ui-validation/javac-2026-11-03T04-20-51-478Z/result.json)、[统一报告](../.taie-agent/check-ui-validation/javac-2026-11-03T04-20-51-478Z/project/.taie-agent/runs/2026-11-03T04-20-51-827Z-5db8fc5b/check.json)。

本轮使用已有镜像和离线缓存，没有改动容器 worker 或重跑六场景 Maven 套件；时间是本次单次验证记录，不作为新的性能对照。未调用模型 API，也未重跑原生检测器套件。旧 `verified` 的含义暂时不变；Maven 模型任务集成和状态迁移为下一小步。

## 中文 Markdown 质检报告

验证日期：2026-11-03（Asia/Shanghai）。聊天 `/check` 与独立 `check-maven` CLI 自动输出 `check.md`；统一 JSON 增加 `humanReportPath` 和检测器列表 `analyses`。生成器只读取本次检查数据，不调用模型、不重新执行分析，后端原始报告不变。

- `npm run typecheck` 通过，`npm run test:host` **86/86 通过**。
- 报告测试覆盖中文结论、测试计数、检测器、依赖详情开关、失败/超时/过期时的零记录含义、超过十条告警完整展示、特殊文件名链接和代码/日志中的 Markdown 分隔符。真实 CLI 子进程验证 `/check` 失败时仍输出 Markdown，并验证 `check-maven` 在 JDK 配置拒绝时保留原 stdout JSON、另存统一 JSON 和可读报告；这些测试不启动 Docker 或模型。
- 复用已有四次真实 Maven 结果，分别生成 [项目零告警](../.taie-agent/readable-report-validation/dependency-findings/check.md)、[展开依赖](../.taie-agent/readable-report-validation/include-dependencies/check.md)、[测试失败](../.taie-agent/readable-report-validation/failed-test/check.md) 和 [项目有告警](../.taie-agent/readable-report-validation/findings/check.md) 的报告示例。已逐一检查共 13 个本地 JSON、源码、测试报告链接可达，并比对原始后端报告 SHA-256 未变。[生成验证记录](../.taie-agent/readable-report-validation/result.json) 保存路径、状态、计数和哈希。

本轮仅验证报告生成与输出，不把历史检查称为新一次 Maven 运行，也未重跑检测器原生套件或模型端到端验证。

## 模型工具与宿主验收接入统一检查

验证日期：2026-11-03（Asia/Shanghai）。`taie_analyze`、任务结束后的宿主检查和 `/check` 现共用 `checkProject`。agent 结果升级为 `schemaVersion: 2`，只有新的构建、实际测试和分析均通过且项目零告警才返回 `verified`；javac 未运行测试的干净结果为 `incomplete`，失败统一为 `check_failed`。修复反馈区分项目与依赖告警，保留 `ask/auto/off` 与跳过检测。

类型检查通过，宿主测试 **95/95 通过**。覆盖测试失败零告警、测试未运行、过期与基础设施失败、批准/拒绝/关闭修复、预算、跳过、模型查询默认项目范围、JSON/Markdown 报告和配置迁移。新增 CLI 鉴权测试首次在加载真实 Pi SDK 时超过原本用于本地命令的 20 秒时限；该用例单独改为 60 秒后通过，其他本地命令仍为 20 秒。纯告警查询测试移出 SDK 导入链，避免无关初始化。本步没有增加生产任务的默认时限。

执行 `npm run test:live:maven`，使用真实 `deepseek/deepseek-v4-flash`、既有 Docker 镜像及离线缓存，在复制出的 `maven-simple` 上验证完整流程。测试程序仅在观察到真实 JUnit 失败、零项目静态告警且 POM/测试未改动后，批准一次修复；并非模型自行批准。

| 顺序 | 发起方 | 状态 | 测试 | 项目 / 依赖告警 | 检查耗时 |
| --- | --- | --- | --- | --- | ---: |
| 1 | 模型 `taie_analyze` | `test_failed` | 1 个，失败 1 个 | 0 / 0 | 136.04 秒 |
| 2 | 宿主独立检查 | `test_failed` | 1 个，失败 1 个 | 0 / 0 | 120.28 秒 |
| 3 | 批准修复后的模型工具 | `passed` | 1 个通过 | 0 / 71 | 148.40 秒 |
| 4 | 最终宿主独立检查 | `passed` | 1 个通过 | 0 / 71 | 135.37 秒 |

整轮从 06:41:00 至 06:50:19 UTC，约 **559.41 秒（9 分 19 秒）**，结果 `verified`，宿主检查 2 次、批准修复 1 轮。错误实现返回固定 `BROKEN_GREETING`；修复恢复 Commons Lang 问候逻辑。模型确实调用了 `edit`、`taie_analyze` 和 `taie_get_finding`，不是只生成一段建议文字。

验证还确认：原 POM 和测试文件哈希未改变；失败报告字节未被修复覆盖；失败和成功快照指纹不同；模型工具报告与宿主报告属于不同运行；JSON 与 Markdown 文件均存在；最终 71 条依赖告警未触发项目失败或额外修复。

证据：[运行记录](../.taie-agent/live-maven/2026-11-03T06-41-00-205Z-43f68278/result.json)、[批准前的失败质检报告](../.taie-agent/live-maven/2026-11-03T06-41-00-205Z-43f68278/project/.taie-agent/maven-runs/2026-11-03T06-43-29-079Z-0afbfcd9/check.md)、[最终质检报告](../.taie-agent/live-maven/2026-11-03T06-41-00-205Z-43f68278/project/.taie-agent/maven-runs/2026-11-03T06-48-04-189Z-36a97ff2/check.md)。同目录保留提示、修复前后 Java 文件、模型事件及各阶段后端日志。

原有 javac live 脚本已适配 `incomplete/tests_not_run` 和新报告结构，本轮仅做类型检查，未重新执行它们或原生检测器套件。当前仍执行模型检查与新鲜宿主检查，不复用前者；Maven 构建、测试和分析在容器执行，模型 shell/文件工具仍使用宿主权限。只读误报复核与隔离候选补丁尚未实现。

## 修改前基线与告警变化对比

验证日期：2026-11-03（Asia/Shanghai）。模型任务默认在首次提示前采集一次真实检查基线；模型工具与后续宿主检查始终比较本轮原始基线。基线独立保存，不计入最终检查或修复轮数；失败仍允许原始编写任务继续。`--baseline off` 或 `/set baseline off` 只关闭基线，最终检查保留；`--skip-taie` 同时跳过两者。手动 `/check` 保持单次检查。

比较只处理项目告警，区分新增、延续、变化、消失。构建/分析未完成或环境指纹不兼容时不输出增减数字；测试失败但分析完成时可以比较静态告警，同时保留失败状态。既有告警不会被豁免，消失不等于修复正确。环境指纹使用记录的分析器、适配器、运行 JDK、编译设置、入口、规则和依赖内容；Maven 另含镜像、快照 POM/`.mvn` 与有效 POM。它是兼容性检查，不是完整环境等价或覆盖保证。

- `npm run typecheck` 通过。宿主回归 **112 项通过、1 项跳过、0 失败**；跳过项为 Windows 环境不允许创建符号链接，目录 classpath 内容变化测试已执行。随后收紧 `taie_get_finding` 的比较输出，避免完整比较数组绕过查询 `limit`；新增查询测试及相关上下文测试 **8 项通过、1 项同原因跳过**，类型检查再次通过。
- 另外完成仅本地 CLI 操作，确认 `--baseline off`、`/set baseline on` 与 `/config` 生效；设置面板现为 22 项。未请求真实模型。
- 执行 `npm run test:baseline`，由脚本确定性修改 Java，实际运行四次 javac/Tai-e。第一轮基线有 2 条吞异常告警，修改后仍有 2 条，但正确分成 **新增 1、延续 1、消失 1、变化 0**；仅移动行号的告警 ID 保持不变。结果为 `unresolved`。第二轮消除剩余两条，比较为消失 2，结果仍为 `incomplete`，因为 javac 不执行项目测试。四次检查耗时分别为 25.45、20.33、19.39、19.18 秒；基线报告未被后续修复覆盖。

真实 Java 证据：[运行记录](../.taie-agent/baseline-smoke/2026-11-03T07-18-40-617Z/result.json)、[新增与遗留告警对比报告](../.taie-agent/baseline-smoke/2026-11-03T07-18-40-617Z/project/.taie-agent/runs/2026-11-03T07-19-06-294Z-0526b229/check.md)、[清除告警但测试未运行的报告](../.taie-agent/baseline-smoke/2026-11-03T07-18-40-617Z/project/.taie-agent/runs/2026-11-03T07-19-46-087Z-dde5caff/check.md)。这是脚本修改与真实分析验证，不是新一次真实模型修复实验。

另执行 `node scripts/replay-baseline-maven.ts`，回放上节既有真实 Maven 失败/通过报告。源码和快照指纹不同，分析环境指纹相同；比较保留测试 `failed → passed`，项目告警增减均为 0，依赖计数 `0 → 71` 不污染项目比较。四份原始 Maven/分析报告 SHA-256 未变。证据：[回放记录](../.taie-agent/baseline-maven-replay/2026-11-03T07-20-44-283Z-3d54bcef/result.json)、[回放对比报告](../.taie-agent/baseline-maven-replay/2026-11-03T07-20-44-283Z-3d54bcef/current/check.md)。此步骤只消费历史证据，没有重新运行 Maven、Tai-e 或模型 API。

本阶段未实现只读误报复核、人工告警处置或隔离候选补丁；新报告中的复核状态仍为 `not_run`。

## 单告警只读复核最小闭环

验证日期：2026-11-03（Asia/Shanghai）。本阶段增加显式 `/review <告警ID>` 与 `review --report <check.json> --finding <id>`，详见 [使用说明](review.md)。只复核已完成构建和分析的单条项目告警；使用独立、无工具、无编码历史或项目资源加载的模型请求。模型只能提出建议，宿主不执行其工具调用或其他权限声明，不改变原始质检结果。

复核使用统一报告中已经保存的告警片段和阶段证据，不读取当前源码或任意证据路径。记录原报告 SHA-256、输入指纹、实际证据包与提示、模型响应及用量，另存 `review.json` 和中文 `review.md`。所有建议均为 E1 模型解释，`disposition: pending_human`、`affectsCheckStatus: false`；原检查中的 `stages.review: not_run` 保留检查当时的状态。复核期间原报告字节变化会返回 `stale`；当前工作区未核验，不能把历史建议直接当作当前输入的结论。

- `npm run typecheck` 通过。`npm run test:host`：**130 项通过、1 项跳过、0 失败**；跳过仍是 Windows 创建符号链接权限不足。新增测试涵盖证据按项目与单 ID 取用、旧片段与当前源码分离、报告变化、输入边界、秘密和路径脱敏、无工具请求、模型错误/截断/取消/超时、非法 JSON/权限字段/证据引用、单路径或证据不足的误报建议降为 `unknown`、原质检与源码保持不变、中文输出及 CLI 单轮覆盖保留。随后为命令行告警摘要补 ID 和 `/review` 提示，相关检查测试 **5/5 通过**。
- 脱敏回归特别验证 Java 除法、URL、SQL 与路径字面量不被泛化路径正则改写；只对结构化路径字段处理外部绝对路径，已知项目根与环境密钥另作替换。它不是通用源码秘密扫描器。
- 执行 `npm run test:live:review`：新建 `example.Parser`，运行真实 javac/Tai-e，检出 **1 条项目 `DE_MIGHT_IGNORE`**。检查耗时 **19.43 秒**，状态 `tests_not_run`。随后使用真实 `deepseek/deepseek-v4-flash` 单次请求，复核耗时 **7.42 秒**；模型返回 `true_positive`（中文显示“疑似真实缺陷”），并列出完整方法、业务错误处理契约等缺失信息。模型建议未转成人工确认或自动修复。
- 本次模型记录输入 **1336 token**、输出 **353 token**，合计 **1689 token**。整条脚本约 **26.92 秒**。源码、统一检查与后端报告哈希保持不变；原项目告警仍为 1，测试仍未运行，原 `stages.review` 未被追溯改写。复核 JSON/Markdown 与请求证据文件均存在。

证据：[真实运行记录](../.taie-agent/live-review/2026-11-03T07-40-40-787Z-b274628f/result.json)、[原质检报告](../.taie-agent/live-review/2026-11-03T07-40-40-787Z-b274628f/project/.taie-agent/runs/2026-11-03T07-40-40-836Z-7126d6c2/check.md)、[中文复核建议](../.taie-agent/live-review/2026-11-03T07-40-40-787Z-b274628f/project/.taie-agent/reviews/2026-11-03T07-41-00-329Z-cfb927c4/review.md)。

这验证了真实分析到真实模型建议的基本链路，没有验证误报识别准确率或声称模型判断正确。多路径 SQL 注入案例、固定版本的扩展取证、当前输入自动失效检查、可审计人工处置和隔离候选补丁仍未完成；本轮未重新运行 Maven 全链路或检测器原生回归。

## SQL 案例与真实复核能力探针

验证日期：2026-11-03（Asia/Shanghai）。新增 `tests/fixtures/sql-probe`、`scripts/probe-sql.ts` 和 `scripts/review-sql-probe.ts`，运行说明见 [SQL 探针](sql-probe.md)。本轮只增加实验入口、定向测试和文档，没有改动生产复核提示、协议校验器、Docker worker 或检测器。

执行 `npm run test:sql -- --prepare-dependencies`，使用已有固定镜像 `sha256:e8c4b690e014510665b70f382f83d70563e97916eaafb7a0f429c37080e487df`、容器 JDK 17.0.15、Maven 3.9.9 与 H2 2.3.232。首次联网准备 H2 等依赖；构建、测试和分析在断网阶段运行。实际 Tai-e 0.5.4 JAR SHA-256 为 `703d1750b66e8e621d628ac93b07a21315db795b3a1e2224001ad09190c1e4be`，即已有发布版字节；容器报告的 `artifactKind: custom` 来自显式暂存路径，不能据此称为本轮新编译的扩展版。

Maven 构建通过，真实 H2 执行的 **4 项 JUnit 测试全部通过**，导出 8 条 SQL/结果行观测。Tai-e 完成分析，项目 3 条告警、依赖 0 条、未映射项目告警 0 条。使用真实 JDBC `Statement.executeQuery` sink、显式调用点匹配、4 个输入 source 和两项 concat transfer，无 sanitizer。PTA 为 `cs: ci`，入口为 `example.Main`，关闭隐式入口。

| 案例 | Tai-e 告警数 | 独立判断依据 |
| --- | ---: | --- |
| A 输入拼接 SQL | 1 | 注入字符串实际改变查询结构，返回行从 `[1]` 变为 `[1,2]`，为真实缺陷。 |
| B 两次纯辅助方法调用 | 1 | 第一次输入结果丢弃，第二次常量独立返回；完整源码排除共享状态。抽象路径跨调用合并，为固定前提下的误报。 |
| C 互斥分支 | 1 | 同一稳定布尔值使污染赋值与 sink 无法同时执行，为固定前提下的误报。 |
| D 常量查询 | 0 | 固定字面量不受输入影响，为阴性对照，不记为模型识别误报。 |

检查耗时 **229.65 秒**，其中依赖准备 39.37 秒、Maven 阶段合计 39.07 秒、分析 119.17 秒，另有暂存/导出/清理开销。测试通过包含成功复现 A 的漏洞，不能解释为案例都安全；B/C 的安全论证依赖完整代码，有限测试只提供佐证。证据：[运行结果](../.taie-agent/sql-probe/2026-11-03T10-41-34-442Z-78487fae/result.json)、[实际告警矩阵及 SQL 观测](../.taie-agent/sql-probe/2026-11-03T10-41-34-442Z-78487fae/matrix.md)。

随后在该次固定证据上执行 `npm run test:sql:review -- <result.json>`，发起 **3 次**真实 `deepseek/deepseek-v4-flash` 请求，无工具、无会话历史、无重试。完整视图增加匹配已分析源码哈希的 Case/Main 历史快照和实际污点规则；缺证据视图只保留原告警片段、抽象路径及规则。模型看不到独立标签、测试断言、SQL 观测或预期答案。

| 视图 | 原始模型分类 | 协议/宿主结果 | 核对结论 |
| --- | --- | --- | --- |
| A 完整 | `true_positive` | 有效、保留真告警 | 主链成立；“测试没有覆盖注入安全性”不受所见证据支持。 |
| B 完整 | `suspected_false_positive` | 额外字段导致拒收 | 核心常量数据流解释成立，整体响应不可用；还错误地把 private static 方法的覆盖关系列为证据缺口。 |
| B 缺 helper/完整调用者 | `suspected_false_positive` | 降为 `unknown` | 按方法名猜测缺失实现，未主动弃权；宿主拦截生效。 |

三个请求均收到响应，有效协议结果 2 个、失败 1 个；总过程 **18.07 秒**。SDK 用量：非缓存输入 **6,624**、缓存读取 **3,200**、输出 **1,447**，总计 **11,271 token**。每次复核后所读历史输入及原报告哈希均未变化，原检查仍为 `findings`、3 条项目告警。没有把模型建议转换成人工批准、修复或质检放行。

首版统计在协议校验后才记录原始标签是否吻合，导致 B 完整视图的原始标签吻合未计入该字段。已将这项计数移到校验前，供后续运行使用；原始运行记录未覆盖，也未重发请求。独立解读保留该限制，并区分“原始标签吻合”与“有效协议结果”。

类型检查通过；新增证据构造测试 **3/3 通过**，覆盖标签和测试内容隔离、只读历史快照、部分视图保留原片段/路径，以及快照/策略/报告变化拒绝。未重跑完整宿主套件、六场景 Maven 套件或原生检测器回归。

本轮能力目标尚未达到：没有有效的疑似误报输出，缺证据时的模型主动弃权也未观察到。下一步先处理输出协议和必要证据/可选佐证的区别，加入带状态 helper 真缺陷与中性命名对照。没有测量人工投入，也没有比较组；这几个视图不能外推准确率或成本收益。证据：[可读结果与逐条核对](../.taie-agent/sql-review-probe/2026-11-03T10-54-40-266Z-ef9cf25c/interpretation.md)、[原始结果与用量](../.taie-agent/sql-review-probe/2026-11-03T10-54-40-266Z-ef9cf25c/result.json)。

## 复核提示 v2 与有状态 SQL 反例

验证日期：2026-11-03（Asia/Shanghai）。本步保留严格八字段解析，改进复核提示对决定性缺口、可选佐证、helper 副作用和测试内容的约定；新结果保存提示版本与摘要。没有新增工具、结构化输出供应商适配、自动重试或告警处置权限。

新增 E/F 同形调用案例：E 的局部 helper 首次保存输入，第二次仍返回该值；F 的 helper 只返回当前参数。真实运行 `npm run test:sql`，用已有镜像和离线缓存，构建、**6 项 JUnit** 与 Tai-e 分析完成，导出 **12 条实际 SQL 观测**。E 的整条查询输入可将结果从 `[1]` 改为 `[1,2]`；F 的同类输入仍执行常量查询。A/B/C/E/F 各报告 1 条，D 无告警，项目共 **5 条**、依赖 **0 条**。镜像、JDK 17.0.15、Maven 3.9.9 与 Tai-e JAR 与上一轮相同；这不是纯方法名消融。

检查共 **216.02 秒**，其中离线准备 36.46 秒、Maven 44.88 秒、分析 99.67 秒，其余为暂存/导出/清理。证据：[运行结果](../.taie-agent/sql-probe/2026-11-03T11-10-25-586Z-b15c4e0e/result.json)、[实际告警与 SQL 矩阵](../.taie-agent/sql-probe/2026-11-03T11-10-25-586Z-b15c4e0e/matrix.md)。

在模型请求前检查实际 E 部分视图，发现原始路径已包含 `INSTANCE_STORE/LOAD` 和字段读取语句，因此将预定目标从只允许未知调整为“保留疑似真告警或弃权”，不删改真实路径。其他部分视图仍要求缺少关键实现时弃权。[API 前固定的七视图目标](../.taie-agent/sql-probe/2026-11-03T11-10-25-586Z-b15c4e0e/review-plan-v2.md) 与模型标签隔离。

执行 `test:sql:review -- <本轮结果> --suite v2`，固定 `deepseek/deepseek-v4-flash`、提示版本 `2`，七次独立无工具请求，无重试。系统提示 SHA-256 为 `c2cc4b98f5ca1b1e639889f98a057444bc47e8ff8823f541234d4327dd736c6a`。

| 视图 | 原始及宿主分类 | 解释核对 |
| --- | --- | --- |
| A 完整 | `true_positive` | 拼接流成立，未再虚构测试覆盖。 |
| B 完整 | `suspected_false_positive` | 依据完整纯方法证明唯一 sink 接收常量。 |
| B 部分 | `analysis_incomplete` | 弃权合理，但误把跨调用抽象合并称为记录矛盾。 |
| E 完整 | `true_positive` | 准确识别首次保存、第二次保留与同一实例状态传递。 |
| E 部分 | `analysis_incomplete` | 看到了状态线索，未凭常量实参判安全；缺失条件的表述仍可更精确。 |
| F 完整 | `suspected_false_positive` | 纯 helper 论证成立；前提段误称 Main 未提供。 |
| F 部分 | `analysis_incomplete` | 主动承认 helper 缺失；误把丢弃 helper 返回值说成丢弃 read 返回值。 |

**7 次响应全部格式有效，预定分类目标全部观察到**；没有宿主降级、真缺陷误排建议或失败重试。三次部分视图均原始返回 `analysis_incomplete` / `insufficient`、空 `assumptions`，属于模型主动弃权。本轮只能报告分类目标与核心论证结果，不能称七份理由全都准确。

模型流程共 **26.63 秒**，SDK 记录非缓存输入 **15,353**、缓存读取 **11,008**、输出 **2,855**，总计 **29,216 token**。没有计量人工投入或设置比较组，不估计提效。类型检查通过；相关宿主测试 **21/21 通过**（复核协议、证据、模型调用 16 项，SQL 实验 5 项）。未重跑完整宿主、六场景 Maven 或原生检测器套件。

原检查仍为 `findings`，5 条告警全部保留。当前所读的 9 个历史输入和首轮 8 个结果/交互文件哈希复查均未改变，旧失败未覆盖。证据：[可读解读与逐条交互](../.taie-agent/sql-review-probe/2026-11-03T11-17-31-044Z-44db6a55/interpretation.md)、[原始结果与计数](../.taie-agent/sql-review-probe/2026-11-03T11-17-31-044Z-44db6a55/result.json)、[完整性记录](../.taie-agent/sql-review-probe/2026-11-03T11-17-31-044Z-44db6a55/integrity.json)。后续冻结提示，在未参与这次调整的新案例上验证，并继续单独核对解释准确性。

## 冻结提示 held-out：分类与解释事实分开计分

验证日期：2026-11-03（Asia/Shanghai）。按用户要求固定现有提示 v2、证据载入/解析/模型调用实现和预算；系统提示 SHA-256 保持 `c2cc4b98f5ca1b1e639889f98a057444bc47e8ff8823f541234d4327dd736c6a`。新增独立 fixture、分析/复核/事实计分三个脚本及六项定向测试，不修改冻结的生产代码。[协议](../evaluations/sql-heldout-v1/protocol.json)、[评分口径](../evaluations/sql-heldout-v1/rubric.md)、[数据与脚本锁](../evaluations/sql-heldout-v1/dataset-lock.json) 在模型请求前固定。

新集合 G–L 没有参与 v2 提示调整，包含多分支跨方法传播、数值区间、循环和对象别名、数组索引、switch 穿透、异常/finally 覆盖；oracle 在看模型回复前由完整代码与独立 SQL 测试建立并核对。这是六个合成案例的 held-out 验证，不代表真实项目分布。真值、测试内容和评分关键事实没有发送给模型。

`npm run test:sql:heldout` 使用同一既有镜像、JDK 17.0.15、Maven 3.9.9、H2 2.3.232 与 Tai-e JAR，默认离线。真实构建、**6 项 JUnit** 和分析完成，导出 **64 条 SQL 观测**；六例各有 1 条项目 `TAINT_FLOW`，依赖 0 条、未报告 0 例、未映射 0 条。总耗时 **191.27 秒**，离线准备 26.33 秒、Maven 31.83 秒、分析 109.67 秒，剩余为暂存/导出/清理。证据：[真实分析结果](../.taie-agent/sql-heldout/2026-11-03T11-52-38-347Z-6deaf3f7/result.json)、[案例矩阵](../.taie-agent/sql-heldout/2026-11-03T11-52-38-347Z-6deaf3f7/matrix.md)。

对全部六条实际告警各发一次独立 `deepseek/deepseek-v4-flash` 请求，统一提供历史 Case/Main 全文和策略，保持原证据模板，无工具、无历史、无重试。全部响应格式有效，原始与宿主分类相同：G/I/K 真缺陷，H/J/L 疑似误报。

| 指标 | 本次值 |
| --- | ---: |
| 分类正确 / 全部可复核告警 | **6/6，100%** |
| 二分类覆盖率 | 6/6，100% |
| 真缺陷保留 / 误报识别 | 3/3、3/3 |
| 去重后的事实主张获支持 | **112/116，96.6%** |
| 回复级全部事实获支持 | **3/6，50%** |
| 预定关键事实提及 / 获支持 | 16/18、14/18 |

事实核对覆盖全部四个解释字段，121 条摘录按同一响应的语义去重为 116 项；全部绑定原始回复哈希、精确引用、历史文件及行范围。4 项错误均在路径关系类（25/29 获支持）：G 将 LOCAL_ASSIGN/多定义摘要说成只对应 mode>1；I 把 mode<0 与 mode==1 串成一条路径，并扩大为各分支都无法消除污染；K 把实际由 L28 覆盖的 mode=0 也列为污染到达 sink。G/I/K 分类仍正确，因为各自还有其他真实路径，故单独记录为“分类对、解释错”。

其余类别获支持：方法/绑定 11/11、值/副作用 28/28、行号/位置 22/22、证据/策略 26/26。J 没有 Java 行号主张，不能据聚合值说每例行号能力都通过。纯范围前提不当成动态事实，具体代码断言仍评分；重复、未计前提和解释歧义的处理理由保留。这些语义判定为 **agent-assisted / provisional / pending human approval**，不是独立人类标注或自动证明，计分脚本只验证来源与算术。

六次模型流程耗时 **22.92 秒**；SDK 非缓存输入 **19,954**、缓存读取 **3,840**、输出 **2,117**，总计 **25,911 token**。事实核对劳动未计入成本比较。类型检查以及新增宿主测试 **6/6 通过**，覆盖冻结失效、标签隔离、失败/弃权分母、重复事实、引述证据和空/缺评分处理；未重跑完整宿主及原生检测器套件。

复核前后冻结内容及本轮所读 11 个历史输入未变，原检查仍为 `findings`，六条告警全部保留；没有接入日常 `/review` 自动取证或自动排除告警。证据：[可读结果与错误案例](../.taie-agent/sql-heldout-review/2026-11-03T11-58-04-618Z-39a9bd1c/interpretation.md)、[双指标报告](../.taie-agent/sql-heldout-review/2026-11-03T11-58-04-618Z-39a9bd1c/evaluation.md)、[全部事实引述与证据](../.taie-agent/sql-heldout-review/2026-11-03T11-58-04-618Z-39a9bd1c/evaluation.json)、[完整性检查](../.taie-agent/sql-heldout-review/2026-11-03T11-58-04-618Z-39a9bd1c/integrity.json)。本轮不根据结果调整提示；后续若使用本集合调优，须另备新的 held-out 数据。

## 聊天等待与取消修复（2026-11-12）

用户反馈发送消息后没有回复。复查确认原实现存在两个交互缺口：默认基线完成前及模型首个 token 到达前没有阶段提示；普通模型任务没有接入 CLI 的 Ctrl+C 控制器，按键只关闭输入，任务仍继续等待。

本次增加会话准备、基线开始、模型等待和最终检查开始提示；普通任务接收外部取消信号，同时取消模型请求和后端检查，在阶段交界停止后续工作。修复确认等待也可取消，并保留下条聊天输入。取消仍使用 schemaVersion 2 的 `agent_error`，错误为 `Agent task cancelled.`，与 `Agent task timed out.` 分开。

`npm run typecheck` 通过；完整 `npm run test:host` 为 **148 项通过、1 项因环境不允许创建符号链接而跳过、0 失败**。新增七项测试覆盖取消后的阶段停止、证据保留、修复确认输入，以及真实 Pi SDK 请求被取消后同一会话仍可继续回复。SDK 测试拦截全部 fetch，不调用外部模型。

网络诊断中，受限执行环境解析 DeepSeek 域名失败；正常网络权限下 HTTPS 返回 401（无密钥探针），携带已授权密钥的最小聊天返回 `TAIE_CHAT_OK`。两次结果区分诊断环境的访问限制和实际模型服务可用性。

修复后使用隔离的 clean 示例，通过 `with-source-taie.mjs chat` 实测扩展 JAR 和五个检测器：基线编译/分析完成，DeepSeek 返回 `TAIE_CHAT_OK`，最终编译/分析完成，项目和依赖告警均为 0，阶段提示齐全。全流程 **60.03 秒**，后端基线 **25.59 秒**、最终检查 **25.43 秒**；模型未调用工具。使用 javac 后端，没有运行项目测试，因此预期结果为 `incomplete`、退出码 1。证据：[运行断言与结果](../.taie-agent/chat-diagnosis/2026-11-12/extended-flow-1794486891418/result.json)、[完整终端输出](../.taie-agent/chat-diagnosis/2026-11-12/extended-flow-1794486891418/stdout.log)、[阶段输出](../.taie-agent/chat-diagnosis/2026-11-12/extended-flow-1794486891418/stderr.log)。本轮没有重新验证 Maven 容器或重新运行 held-out 模型实验；冻结的复核提示、实现、数据与实验脚本哈希检查通过。

## 受委托标注与 v3 回归（2026-11-17）

用户委托 AI 代为复核并继续下一步。六例完整源码、策略、模型请求与回复已逐项核对：G/I/K 真缺陷，H/J/L 误报。独立 H2 重放覆盖每例 9 个 int 边界值，共 **54/54 条观测通过**；宿主使用 JDK 21、编译目标 17。本轮没有重跑 Maven/Tai-e，历史报告和输入通过哈希核验。

旧解释标注另存修订副本，补齐 K17 复合句的前半句并与 K14 去重。原来的 116 项事实仍为 112 正确、4 错误，分类 6/6、整份解释全部获支持 3/6。原始文件保留。受委托标注状态为 completed，`humanReviewed: false`；冻结评分器遗留的 provisional/pending 字段保留人类签收含义，不表示仍在等待用户完成本次标注。

新增独立的 v3 提示、冻结协议、回归脚本与一项配置冻结测试。请求前锁定系统提示 SHA-256 `0dd31cfa6918acfaee3182eba65596b415d7a85a650d3d056b9e9b47c35764ea` 和脚本 SHA-256 `8f7f07e0dec48bc597b0eecd3fef442cd2ace12915fe6634c00ee4c454fec9ba`；证据正文沿用旧输入，不发送标签、测试源码或独立重放观测。G–L 在新实验中作为 regression。

固定 `deepseek/deepseek-v4-flash`、4096 输出 token 上限，六次真实请求全部格式有效，无重试、无宿主降级。**分类 6/6，整份解释全部事实获支持 1/6，关键事实获支持 14/18**；164 条引用去重为 151 项，其中正确 135、错误 14、无依据 2。错误包括 9 项位置引用、1 项方法属性、3 项路径关系和 1 项证据属性，另有 2 项无依据断言。预先冻结的 6/6 完整解释及 18/18 关键事实目标未通过，v3 不晋升为日常版本。

模型流程 **41.09 秒**；SDK 非缓存输入 20,264、缓存读取 5,120、输出 2,955，总计 **28,339 token**。`npm run typecheck` 通过；完整 `npm run test:host` **149 通过、1 因符号链接权限跳过、0 失败**。原检查仍为 findings、六条告警全部保留，未接入日常自动取证或自动排除。

证据：[中文复核与失败案例](sql-regression-v3.md)、[最终标注和门槛判定](../.taie-agent/delegated-review/2026-11-17/annotations.json)、[独立重放](../.taie-agent/delegated-review/2026-11-17/replay-result.json)、[逐项事实评分](../.taie-agent/sql-regression-v3/2026-11-17T06-23-23-019Z-08cfe4ef-8162-43ee-b23e-6ff26a59f3dc/evaluation.json)、[125 项运行完整性检查](../.taie-agent/sql-regression-v3/2026-11-17T06-23-23-019Z-08cfe4ef-8162-43ee-b23e-6ff26a59f3dc/integrity.json)。

## 宿主生成的源码引用（2026-11-17）

新增独立 source-citations-v1 实验：宿主对哈希核验后的源码按 8 行编号，模型按解释项选择 sourceIds；报告从目录展开文件、行范围和代码，不接受模型结构化提交的 file/quote/line。未知编号、无引用和过期输入分别记录，语义状态固定为 not_checked。日常 /review 和冻结 v2/v3 不变。

类型检查通过；新增 5 项定向测试通过；完整宿主测试 **154 通过、1 因符号链接权限跳过、0 失败**。对案例 J 执行一次真实 DeepSeek 请求，无重试：9 个供选片段、6 条解释、4 个不同编号全部匹配；第 5 条报告事实没有源码引用，单独展示。耗时 **15.85 秒**；SDK 输入 4,556、输出 462，总计 **5,018 token**。

独立逐行核验确认全部 9 个片段与历史源码对应，6 个原始输入哈希和冻结版本未变；原检查仍为 findings，保留全部 6 条告警。模型第一条解释误称两个分支都先写 slots[1]，实际负数分支先写 slots[0]；该语义错误另存 AI 观察，未被引用匹配结果掩盖。本次是引用功能验证，没有重跑 Maven/Tai-e 或进行新的解释准确率评测。

证据：[使用与实现说明](source-citations.md)、[可读报告](../.taie-agent/source-citations/2026-11-17T07-20-58-644Z-ed19b0a6/report.md)、[完整请求](../.taie-agent/source-citations/2026-11-17T07-20-58-644Z-ed19b0a6/request.json)、[原始回复与结果](../.taie-agent/source-citations/2026-11-17T07-20-58-644Z-ed19b0a6/result.json)、[独立核验](../.taie-agent/source-citations/2026-11-17T07-20-58-644Z-ed19b0a6/validation.json)。

## 单方法执行顺序校验（2026-11-17）

新增独立 Java CFG 导出器、TypeScript 序列校验器、无模型探针和一次模型实验入口。导出器用真实 CFGBuilder 对 CaseJ.execute 构建普通控制流，保留 18 个节点、18 条边及源码位置；不运行 PTA，不改既有适配器或冻结 v2/v3。选中源码经原哈希核验后，用 Microsoft JDK 17.0.20.1 编译为新的补充字节码，明确区别于历史 class 文件。

实际探针 **19.08 秒**，两条正确完整序列通过；交换负数分支写入产生 4 处缺失连接，跨分支拼接产生 2 处缺失连接，均被拒绝。IR 条件是 mode >= 0，其 IF_FALSE 对应 Java 的负数分支；节点顺序并非源码行号排序。

随后一次真实 DeepSeek 请求，无重试，返回两条完整序列，均为 connected。报告中的语句、边类型、条件和源码由宿主展开。模型流程 **5.00 秒**；SDK 输入 6,641、输出 272，总计 **6,913 token**。模型输入没有测试序列或独立标签。原检查仍为 findings、保留 6 条告警，自动处置未启用。

类型检查通过；新增 **6 项定向测试通过**；完整宿主测试 **160 通过、1 因符号链接权限跳过、0 失败**。路径连通性检查不判断条件可满足性、值传播、别名或全部路径覆盖；异常边未纳入本轮。此结果为 Case J 功能验收，不作为新 benchmark 分数。

证据：[使用说明](control-flow-review.md)、[真实导出与序列验收](../.taie-agent/control-flow/2026-11-17T07-40-06-913Z-887a5a8f/result.json)、[中文模型报告](../.taie-agent/control-flow-review/2026-11-17T07-43-42-558Z-3ca18db3/report.md)、[完整交互结果](../.taie-agent/control-flow-review/2026-11-17T07-43-42-558Z-3ca18db3/result.json)。
