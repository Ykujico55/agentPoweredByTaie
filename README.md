# Tai-e Coding Agent

基于 **Pi SDK + Tai-e** 的 Java coding agent 原型。模型可以读写代码、执行命令、调用 `taie_analyze`；宿主程序在模型完成后独立执行一次新的编译和分析。CLI 默认采用 `repair-mode=ask`，发现告警或编译错误后，先询问用户，再决定是否交回模型修复。讨论或其他无需检查的任务可以显式跳过本轮 Tai-e。

当前阶段验证工程闭环，尚未进行模型或框架的比较实验。

后续产品范围与实施顺序已确认，见 [产品规格](docs/product-spec.md) 和 [开发与验收计划](docs/development-plan.md)。两份文档区分已确认目标与当前实现；第一阶段聚焦 JDK 17、单模块 Maven 和隔离执行。

第一步新增独立的 `check-maven`：在项目快照和 JDK 17 容器中运行真实 Maven 构建、单元测试及 Tai-e。使用 `npm run build:maven-image` 构建镜像，运行方式与范围见 [Maven 容器检查](docs/maven-check.md)。聊天任务的构建与工具执行尚未迁移到这个后端。

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

启动 `chat` 会显示完整的 18 项设置面板，包括 CLI flag、当前有效值和绝对路径。聊天中使用 `/config` 或 `/settings` 再次查看，使用 `/set <设置名> <值>` 修改；`/help` 显示完整 CLI 帮助。

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

跳过期间，两个 Tai-e 工具停用，宿主不执行为 Tai-e 准备的编译、分析和自动修复循环；读写代码和普通 shell 工具仍可使用。正常完成的结果为 `outcome: "skipped"`、`skipTaie: true`、`checks: []`、`repairRounds: 0`，CLI 退出码为 `0`。`skipped` 表示未做 Tai-e 验证，不属于 `verified`；模型调用失败或超时仍会报错。

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

现有 `run`、`chat` 和 `analyze` 面向可由 `javac` 编译的普通 Java 项目，也支持 Maven/Gradle 常见源码目录；**不会自动解析依赖或运行这些构建系统的测试生命周期**。这些入口的第三方依赖需在 `classpath` 中提供。真实单模块 Maven 检查使用新增的 `check-maven`。Spring/Android 等框架的入口和运行语义尚未专门建模。

## 自动复查如何运行

以下是启用 Tai-e 时的流程；跳过的任务只执行模型任务并记录结果，下一条任务按照会话检测默认值运行。

1. Pi 根据任务调用读写、编辑和 shell 工具，真正生成或修改代码。
2. 模型可主动调用 `taie_analyze`，获得新的编译结果、结构化告警和证据文件。
3. 模型停止后，宿主独立重新编译和分析；单个任务内源码范围和分析配置固定，可在用户任务之间通过配置命令更新。污点规则在该配置首次分析时读取为快照。
4. 有告警或编译错误时，`ask` 每轮先征得同意，`auto` 自动将证据交回模型，`off` 保留结果；最多追加两轮修复，可用 `--max-repairs` 调整。
5. 返回机器可读的结果，不以模型自行声称“已通过”为准。

结果中的 `outcome`：

| 值 | 含义 |
| --- | --- |
| `verified` | 最后一次新的编译成功，所配置检测器分析完成且没有告警 |
| `skipped` | 按本轮选项或会话默认值跳过 Tai-e，模型任务正常完成；没有执行宿主检查或修复循环 |
| `unresolved` | 仍有告警，包括关闭修复、拒绝修复或修复预算用完的情况 |
| `analysis_error` | 编译错误未解决，或分析未能完成 |
| `agent_error` | 模型请求失败、任务超时或超过模型轮数预算 |

`verified` 不表示功能测试通过或所有 bug 已排除。宿主当前不自动判定和删除误报；未解决告警会保留。默认任务超时 10 分钟，模型轮数上限 30，可通过 `--timeout` 和 `--max-turns` 调整。

`run` / `chat` 对 `verified` 和 `skipped` 返回退出码 `0`，其他结果返回 `1`。需要确认静态检查通过时，应检查 `outcome === "verified"`，不能只看进程退出码。

每个项目的 `.taie-agent/` 保存编译与分析证据、模型完成消息和工具调用，以及 `last-agent-run.json`。每次分析输出 schema v2 的 `report.json`、SARIF 2.1.0 的 `results.sarif` 和独立的 `triage.json`；exporter 成功运行后还会生成 `findings.raw.json`。agent 可通过 `taie_get_finding` 按 ID 获取局部证据。每次分析使用新的输出目录，避免旧 `.class` 文件导致结果过期。通过 `--json` 仅输出最终 JSON。

现有 `run`、`chat` 的 Pi shell 和文件工具使用启动进程的操作系统权限，尚无独立沙箱。新增的 `check-maven` 只隔离其构建、测试和分析链路。请在专用项目目录运行。

## 验证

```powershell
npm run typecheck
npm test
npm run test:live
```

普通测试不请求模型，包含真实 `javac`/Tai-e 集成检查和宿主复查逻辑测试。`test:live` 使用环境中的 API key 请求模型，会产生正常 API 用量；脚本检查实际写入的 Java 文件、`taie_analyze` 工具调用、宿主分析证据，并独立编译和执行 Java 断言。证据保存在本仓库 `.taie-agent/live-smoke/`。

## 代码入口

- `src/cli.ts`：`run`、`chat`、`analyze`、`doctor` 命令。
- `src/agent.ts`：Pi SDK 会话、自定义分析工具和运行证据。
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
