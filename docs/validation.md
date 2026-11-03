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
