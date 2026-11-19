# Tai-e Coding Agent

基于 **Pi SDK + Tai-e** 的 Java coding agent 原型。模型可以读写代码、执行命令、调用 `taie_analyze`；宿主默认在模型动手前记录基线，完成后独立执行一次新的质检并对比告警。Maven 后端包含真实构建、项目测试与分析。CLI 默认采用 `repair-mode=ask`，发现项目告警、构建或测试错误后，先询问用户，再决定是否交回模型修复。讨论或其他无需检查的任务可以显式跳过本轮 Tai-e。

当前阶段验证工程闭环，尚未进行模型或框架的比较实验。

后续产品范围与实施顺序已确认，见 [产品规格](docs/product-spec.md) 和 [开发与验收计划](docs/development-plan.md)。两份文档区分已确认目标与当前实现；第一阶段聚焦 JDK 17、单模块 Maven 和隔离执行。

独立 `check-maven`、聊天 `/check`、模型工具和任务自动验收已共用质检接口。选择 `maven-docker` 后，在项目快照和 JDK 17 容器中运行真实 Maven 构建、单元测试及 Tai-e。使用 `npm run build:maven-image` 构建镜像，运行方式与范围见 [Maven 容器检查](docs/maven-check.md)。

`check-maven` 的状态只计入项目告警，默认隐藏依赖告警详情；`--include-dependencies` 可查看单列的依赖告警，开关不改变项目状态。完整 APP 分析证据始终保留，报告记录两类计数与 `origin`。

Maven 缓存与构建工作目录使用 Docker 管理的 Linux 卷，检查后导出可在宿主查看的证据并清理临时卷。升级后需重新构建镜像；首次可用 `--dependency-network on` 填充缓存。性能对照和六场景回归见 [验证记录](docs/validation.md)。

已加入源码扩展：修复临时 `null` 常量导致的分析异常，新增整数/long 除零检测，接入带跨方法传播证据的污点分析插件。完整用法见 [扩展功能说明](docs/extensions.md)。

## 环境与安装

- Node.js **22.19+**，直接运行可擦除类型的 TypeScript。
- JDK **17+**，`java`、`javac` 可从 PATH 找到；本项目在 JDK 21 上验证。
- 模型调用默认使用 DeepSeek；分析命令本身不需要 API key。

```powershell
npm ci --ignore-scripts
npm run setup:taie
npm run doctor
```

Tai-e 下载自官方 GitHub Release，固定为 **0.5.4**，并校验固定 SHA-256。文件安装到当前仓库的 `.tools/tai-e/`。安装和模型调用需要网络；正常分析不会自动下载其他内容。Pi SDK 固定为 **0.85.1**。

默认从进程环境读取 `DEEPSEEK_API_KEY`，无需把密钥写进项目：

```powershell
$env:DEEPSEEK_API_KEY = "你的密钥"
npm start -- run --project examples/playground --prompt "编写一个 Java 命令行程序，读取名字并输出问候语，处理没有参数的情况。写入 src/main/java，完成后调用 taie_analyze。"
```

如果已经配置环境变量，直接运行最后一行。也可使用 `--prompt-file task.txt`。多轮对话：

```powershell
npm start -- chat --project examples/playground
```

输入 `/exit` 退出。也可通过 `--provider`、`--model` 或 `TAIE_AGENT_PROVIDER`、`TAIE_AGENT_MODEL` 选择固定 Pi 版本目录中支持的模型；默认 `deepseek/deepseek-v4-flash`。

## 在聊天中配置和修复

启动 `chat` 会显示全部设置、CLI flag、当前有效值和绝对路径。聊天中使用 `/config` 或 `/settings` 再次查看，使用 `/set <设置名> <值>` 修改，`/help` 显示完整 CLI 帮助。

手动 `/check` 无需模型、不会修复，输出构建/测试/分析/复核阶段及项目/依赖告警。用 `/set build-backend maven-docker` 为模型工具、宿主验收和手动检查选择 Maven，`/set dependency-network on` 显式允许依赖准备联网。javac 未运行测试，干净检查状态为 `tests_not_run`，模型任务最终结果为 `incomplete`。完整说明见 [交互配置](docs/interactive-settings.md)。

Maven 编码任务可在 `run` 或 `chat` 启动时指定 `--acceptance-java <验收文件.java>`，也可在聊天中输入 `/set acceptance-java ../acceptance/Verifier.java`。每个启用检测的任务在模型写代码前固定验收文件内容。项目检查通过后，宿主用同一批构建产物执行验收。业务断言失败会按现有修复策略处理，修复后重新运行项目检查和业务验收。输入 `/set acceptance-java unset` 可清除该设置。输出约定与示例见 [交互配置](docs/interactive-settings.md#独立业务验收)。

```powershell
npm start -- chat --project tests/fixtures/maven-simple --build-backend maven-docker --dependency-network off
```

以上命令使用已有依赖缓存；首次准备可显式设为 `on`，检查阶段仍离线。模型编写代码后调用 `taie_analyze`，宿主随后独立复查。Maven 不可用时保留错误，不自动回退到宿主 javac。

`/check` 和 `check-maven` CLI 每次都会同时生成中文 **`check.md` 质检报告**，包含结论、各阶段结果、告警详情和证据链接；命令行会显示其路径，现有 JSON 结果继续保留。

模型任务的 `baseline` 默认 `on`，每轮额外执行一次真实检查，记录修改前状态；这部分耗时计入任务预算。启动时传 `--baseline off` 或聊天输入 `/set baseline off` 可以只关闭基线，仍保留模型工具和最终宿主验收。`--skip-taie` 同时跳过基线与最终检查；手动 `/check` 始终只检查一次。

需要解释某条项目告警时，先从 `check.md` 或 `check.json` 取得 ID，再输入 `/review <告警ID>`。它使用当前模型对最近检查中记录的局部证据进行一次只读复核，另外生成 `review.json` 和中文 `review.md`。模型没有文件或 shell 工具，建议不会修改代码、关闭告警或改变质检状态；当前工作区未核验，输入变化后应重新 `/check`。复核只在显式调用时执行，会产生模型 API 用量。独立命令与证据限制见 [只读复核说明](docs/review.md)。

```text
/config
/set model deepseek-v4-flash
/set max-turns 40
/repair ask
/analysis on
```

修复策略有三种，CLI 默认 `ask`：

| 模式 | 发现告警或编译错误后的行为 |
| --- | --- |
| `ask` | 每轮修复前询问 `是否允许修改代码并重新检测？[y/N]`；输入 `y` 或 `yes` 确认后继续 |
| `auto` | 在修复轮数、模型轮数和时间预算内自动反馈与修复 |
| `off` | 保留缺陷和分析证据，不追加宿主修复任务 |

`/repair ask`、`/repair auto`、`/repair off` 是 `/set repair-mode` 的快捷方式。默认 `N`、空输入、拒绝或 EOF 都不会开始修复。`--json` 模式下，`ask` 不进行交互确认，直接保留告警；需要自动修复时显式选择 `--repair-mode auto`。等待人工修复决定的时间不计入任务执行 `--timeout`。

仅本轮保留演示缺陷、继续检测时，可给消息加前缀：

```text
--no-repair 编写一个演示整数除零的 Java 示例，保留缺陷并解释检测结果
```

`--no-repair` 只把当前任务的修复模式设为 `off`，下一条任务恢复会话设置。`/analysis on`、`/analysis off` 则修改会话默认检测开关，持续影响后续任务；`--skip-taie` 只跳过一轮。

配置命令不调用模型或 Tai-e，也不默认写入 `taie-agent.json`。多数设置在原会话中保留历史，下一条任务生效；修改 `project` 会加载目标项目配置并开始新会话。完整设置、路径、数组及项目切换规则见 [交互配置与修复确认](docs/interactive-settings.md)。

## 仅本轮跳过 Tai-e

单次任务使用 `--skip-taie`：

```powershell
npm start -- run --project examples/playground --skip-taie --prompt '解释静态分析'
```

交互对话中，在当前消息前加同一标志即可：

```text
--skip-taie 先讨论设计
为刚才的方案编写 Java 实现
```

第一条消息跳过检测，第二条恢复会话默认值（初始为开启）。单独输入 `--skip-taie` 会预定下一条实际任务跳过；通过 `npm start -- chat --skip-taie` 启动时，也只影响首条实际任务。该开关仅适用于 `run` / `chat`。

跳过期间，两个 Tai-e 工具停用，宿主不执行基线、最终检查和自动修复循环；读写代码和普通 shell 工具仍可使用。正常完成的结果为 `outcome: "skipped"`、`skipTaie: true`、`baseline.status: "skipped"`、`checks: []`、`repairRounds: 0`，CLI 退出码为 `0`。`skipped` 表示未做 Tai-e 验证，不属于 `verified`；模型调用失败或超时仍会报错。

## 单独分析 Java 项目

```powershell
npm run analyze -- --project examples/buggy
npm run analyze -- --project examples/clean
```

分析命令返回 JSON；退出码 `0` 表示完成且无告警，`2` 表示完成且有告警，`1` 表示编译或分析失败。它不调用大模型。

默认启用三个真实的 Tai-e 检测器：

| ID | 检查内容 |
| --- | --- |
| `dropped-exception` | 捕获异常后丢弃异常信息等问题 |
| `clone-idiom` | `clone()` 实现习惯相关问题 |
| `dead-code` | 死代码相关问题 |

**官方发行版限制：** Tai-e 0.5.4 的 `null-pointer` 检测器对简单的直接 `null` 解引用输入可能抛出 `UnsupportedOperationException`，因此基础模式没有默认启用。本项目的源码补丁已修复这个已复现的异常；`start:extended` 使用包含补丁的本地构建，同时启用空指针和除零检测。本原型不声称对任意 Java 缺陷提供 soundness 保证。

将 `taie-agent.example.json` 复制为目标项目中的 `taie-agent.json` 即可配置：

```json
{
  "sourceRoots": ["src/main/java"],
  "classpath": ["lib/example-dependency.jar"],
  "analyses": ["dropped-exception", "clone-idiom", "dead-code"],
  "timeoutMs": 120000
}
```

`classpath` 示例须替换为存在的依赖或留空。相对路径以目标项目为基准。`mainClass` 可选；`javaVersion` 可设置 `javac --release`，分析的运行库仍来自运行 Tai-e 的 JDK。通过 `TAIE_JAVA_HOME` 或 `JAVA_HOME` 选择 JDK，通过 `TAIE_JAR` 或 `--jar` 指定其他 Tai-e JAR。

`run`、`chat` 默认仍使用 `javac`，需手工提供 classpath，且不运行项目测试；可用 `--build-backend maven-docker` 接入真实单模块 Maven 生命周期。独立 `analyze` 保留原 javac 协议和行为。Gradle 构建以及 Spring/Android 等框架入口和运行语义尚未专门建模。

## 自动复查如何运行

以下是启用 Tai-e 时的流程；跳过的任务只执行模型任务并记录结果，下一条任务按照会话检测默认值运行。

1. 默认先检查未修改的项目，保存本轮基线。基线失败仍允许原任务继续，例如创建首个 Java 文件；保留失败证据，不伪造空的干净基线。
2. Pi 根据任务调用读写、编辑和 shell 工具，真正生成或修改代码。
3. 模型可主动调用 `taie_analyze`，通过所选后端取得构建、测试、分析结果和中文质检报告。
4. 模型停止后，宿主独立重新质检；javac 源码范围和分析配置保持冻结，Maven 每次从新快照的真实构建取得产物。污点规则在该配置首次分析时读取为快照。
5. 有项目告警或可修复的构建/测试错误时，`ask` 每轮先征得同意，`auto` 自动将证据交回模型，`off` 保留结果；最多追加两轮修复，可用 `--max-repairs` 调整。单纯缺少测试或分析器/环境故障不会触发盲目修复。
6. 返回机器可读的结果，不以模型自行声称“已通过”为准。

agent 结果协议为 `schemaVersion: 2`，`baseline` 独立保存修改前检查，不计入 `checks` 或修复次数；后续检查的 `comparison` 及中文报告展示新增、消失、延续和变化的项目告警。环境不一致或构建/分析证据不可用时不计算增减数字。测试失败但构建和分析完成时仍可比较静态告警，测试失败状态保留。比较只描述两次报告的差异，不证明修复或误报，也不免除既有告警和失败测试。

结果中的 `outcome`：

| 值 | 含义 |
| --- | --- |
| `verified` | 最后一次构建、实际项目测试、分析均通过，项目零告警，已配置的独立业务验收通过 |
| `skipped` | 按本轮选项或会话默认值跳过 Tai-e，模型任务正常完成；没有执行宿主检查或修复循环 |
| `unresolved` | 仍有项目告警或业务断言失败，例如关闭修复、拒绝修复或用尽预算 |
| `incomplete` | 未运行项目测试；例如 javac 编译与分析成功且无项目告警 |
| `check_failed` | 构建或测试失败未解决，分析或验收运行器错误，后端失败、超时或输入过期 |
| `agent_error` | 模型请求失败、任务超时或超过模型轮数预算 |

`verified` 表示已配置的构建、项目测试和分析通过，不证明所有 bug 已排除。检查报告中的复核阶段仍为 `not_run`；之后显式运行的单告警复核另存记录，不追溯改写原检查。旧 `analysis_error` 已统一为 `check_failed`；旧 javac 干净任务现在返回 `incomplete`，退出码 1。默认任务超时 10 分钟，模型轮数上限 30，可通过 `--timeout` 和 `--max-turns` 调整。

`run` / `chat` 对 `verified` 和 `skipped` 返回退出码 `0`，其他结果返回 `1`。需要确认静态检查通过时，应检查 `outcome === "verified"`，不能只看进程退出码。

每个项目的 `.taie-agent/` 保存编译与分析证据、模型完成消息和工具调用，以及 `last-agent-run.json`。每次分析输出 schema v2 的 `report.json`、SARIF 2.1.0 的 `results.sarif` 和独立的 `triage.json`；exporter 成功运行后还会生成 `findings.raw.json`。agent 可通过 `taie_get_finding` 按 ID 获取局部证据。每次分析使用新的输出目录，避免旧 `.class` 文件导致结果过期。通过 `--json` 仅输出最终 JSON。

`run`、`chat` 的 Pi shell 和文件工具使用启动进程的操作系统权限，尚无独立沙箱。`maven-docker` 只隔离构建、测试和分析链路。请在专用项目目录运行。

## 验证

```powershell
npm run typecheck
npm test
npm run test:baseline
npm run test:live
npm run test:live:maven
npm run test:live:review
npm run test:sql -- --prepare-dependencies
# 使用上一条命令输出的 result.json 路径：
npm run test:sql:review -- ".taie-agent/sql-probe/运行ID/result.json" --suite v2
```

普通测试不请求模型，包含真实 `javac`/Tai-e 集成检查和宿主复查逻辑测试。`test:live` 使用环境中的 API key 请求模型，会产生正常 API 用量；脚本检查实际写入的 Java 文件、`taie_analyze` 工具调用、宿主分析证据，并独立编译和执行 Java 断言。证据保存在本仓库 `.taie-agent/live-smoke/`。

`test:baseline` 运行真实 Java/Tai-e 检查，由脚本确定性修改示例，验证基线与修改后报告的比较；不调用模型 API，不代表真实模型已经正确完成修复。

`test:live:maven` 使用离线 Maven 缓存与真实模型，验证“模型写入错误实现 → 测试失败但项目零静态告警 → 确认修复 → 模型修复 → 新的宿主检查通过”；测试同时确认 POM 和既有测试未被修改。javac 系列 live 脚本保留独立运行断言，但不把独立断言结果伪装成 agent 已执行的项目测试。

`test:live:review` 运行真实 Java/Tai-e 检查，再发起一次真实模型复核，检查建议与证据文件；会产生 API 用量。执行结果以 [验证记录](docs/validation.md) 为准，命令存在不代表误报识别能力已通过 benchmark。

`test:sql` 使用真实 JDBC/H2、JUnit 和 Tai-e，建立六个 SQL 案例的独立依据与实际告警矩阵，不调用模型。`test:sql:review` 读取该次运行的固定快照，分别复核真告警、误报告警和缺少关键实现的证据视图；默认 `--suite v2` 请求 DeepSeek 七次，记录提示版本并保存完整交互，不关闭告警。旧四案例报告须用 `--suite v1` 选择原三个视图，它仍使用当前提示。详见 [SQL 能力探针](docs/sql-probe.md)。这是开发用小样本验证，尚未集成到聊天中的扩展取证。

[Held-out 验证](docs/sql-heldout.md) 使用另六个新案例，冻结 v2 提示及复核实现，分别统计分类和解释事实。`test:sql:heldout` 运行真实构建/SQL/Tai-e；`test:sql:heldout:review -- <结果路径>` 对实际告警逐条请求模型；`test:sql:heldout:score -- <复核结果路径> <事实核对路径>` 从另存的逐项核对记录生成评分。事实核对为待人工复验的 agent-assisted 记录，不自动关闭告警，也未接入日常 `/review` 自动取证。

用户委托的六例 AI 标注现已完成。新增 `test:sql:regression -- <历史分析结果路径>`，在独立冻结的 v3 实验配置下复用相同证据；运行会调用真实模型。首次回归分类 6/6、整份解释事实全对 1/6，未通过质量门槛，日常版本保持不变。[复核与 v3 结果](docs/sql-regression-v3.md)。

[源码引用实验](docs/source-citations.md) 由宿主给历史源码片段编号，模型按解释项选择编号，中文报告自动展开文件、行范围和原文。`test:sql:citations -- <历史分析结果路径> <G|H|I|J|K|L>` 发起一次真实请求；引用匹配与语义正确性分开记录，暂不接入日常 `/review`。

[单方法执行顺序实验](docs/control-flow-review.md) 用真实 Tai-e CFG 核对模型提交的完整语句序列。`test:cfg -- <历史分析结果路径>` 导出 Case J 并检查正确/错误序列；`test:cfg:review -- <控制流探针结果路径>` 发起一次真实模型请求并生成报告。结构连通、条件可满足性和值流分别记录。

## 代码入口

- `src/cli.ts`：`run`、`chat`、`analyze`、`check-maven`、`review`、`doctor` 命令。
- `src/agent.ts`：Pi SDK 会话、自定义分析工具和运行证据。
- `src/review.ts`：单告警只读复核建议、输入版本绑定及独立报告。
- `src/verification.ts`：由宿主控制的有界复查和修复循环。
- `src/taie.ts`：Java 编译、真实 Tai-e 分析和结构化结果。
- `scripts/setup-taie.mjs`：固定版本下载与 SHA-256 校验。
- `scripts/smoke-live.ts`：真实模型端到端验证。

上游：[Tai-e](https://github.com/pascal-lab/Tai-e)、[Pi](https://github.com/earendil-works/pi)。Tai-e 源码扩展保存在 `patches/tai-e-agent.patch`；上游源码、JAR 和 Pi 依赖保留各自的许可证。

## Tai-e 源码二次开发

源码独立检出在 `vendor/Tai-e/`，以 `v0.5.4` 的精确提交为基线，保留自己的 Git 历史。下载、构建和本地构建功能检查：

```powershell
npm run setup:taie-source
npm run build:taie-source
npm run test:taie-source
npm run start:extended -- chat --project examples/playground
```

构建成功后，显式选择本地 JAR 即可用于分析或 agent：

```powershell
npm run analyze -- --project examples/buggy --jar vendor/Tai-e/build/tai-e-all-0.5.4.jar
npm start -- chat --project examples/playground --jar vendor/Tai-e/build/tai-e-all-0.5.4.jar
```

默认仍使用固定的官方 JAR。显式 `--jar`、项目配置中的 `jarPath` 或 `TAIE_JAR` 表示选择自定义构建：记录实际版本、提交和 SHA-256，并继续要求真实分析完成、结构化结果和覆盖检查。详细构建环境、源码入口和开发方式见 [源码开发说明](docs/source-development.md)。
