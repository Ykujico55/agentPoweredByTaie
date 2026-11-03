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
