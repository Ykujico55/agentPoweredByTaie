# 交互配置与修复确认

启动聊天后，可以直接查看和修改当前会话的配置，无需退出进程：

```powershell
npm start -- chat --project examples/playground
```

聊天中的 `/config` 和 `/settings` 显示同一份完整配置面板，包括全部 21 项设置、对应 CLI flag、有效默认值和解析后的绝对路径。`/help` 显示完整 CLI 帮助，`/exit` 退出聊天。

```text
/config
/set model deepseek-v4-flash
/set max-turns 40
/repair ask
/analysis on
```

这些配置命令由宿主处理，不会向模型发送消息，也不会触发 Tai-e 分析；修改默认只保存在当前进程中，不写入项目的 `taie-agent.json`。未知设置、缺少值或不合法的枚举、数组、数值会直接报错，原配置保留。模型与供应商的组合、凭据在下一条任务开始前验证，因此可以分两条命令修改 provider 和 model。

## 手动检查 `/check`

`/check` 直接调用宿主检查入口，无需模型凭据，不进行误报复核或修复。即使 `/analysis off`，显式 `/check` 仍执行；它不消耗已预定的 `--skip-taie` 或 `--no-repair`。检查期间 Ctrl+C 请求取消，保存部分证据并清理后返回聊天。

例如，先按 [Maven 说明](maven-check.md) 构建镜像，再启动 `npm start -- chat --project tests/fixtures/maven-simple`：

```text
/set build-backend maven-docker
/set dependency-network on
/check
/set dependency-network off
/set include-dependencies on
/check
```

首次准备依赖可显式联网；缓存齐备后关闭。检查阶段始终离线。默认不展示依赖告警详情，开关只控制单列的依赖明细，不改变项目状态。已有手工源码或 classpath 覆盖时，先用 `/set source-root auto` 和 `/set classpath auto` 清除；Maven 从真实构建中取得它们。

`build-backend` 同时控制模型的 `taie_analyze`、任务结束后的宿主验收和手动 `/check`，三者使用相同的阶段报告。Maven 后端不可用时保留错误，不回退宿主 javac。模型的 shell 和文件工具仍在宿主执行；当前隔离范围是 Maven 构建、测试和 Tai-e 链路。

例如启动 `npm start -- chat --project tests/fixtures/maven-simple --build-backend maven-docker`，输入代码任务即可使用 Maven 自检；CLI 默认 `ask`，发现可修复的构建错误、测试失败或项目告警后，展示阶段结果和质检报告，再询问是否允许修复。未运行测试、分析器故障、超时、后端错误或过期结果不会自动转成代码修复任务。javac 若有项目告警可按策略修复，但清除告警后仍因未运行测试返回 `incomplete`。

统一结果保存为本次后端运行目录中的 `check.json`（`schemaVersion: 1`），原有 `report.json` 不变，`backendReportPath` 和 `backendStatus` 保留原始证据与状态。`stages` 分别记录构建、测试、分析、复核；`findings` 只含项目告警，`findingCounts` 分列项目和依赖计数。javac 入口同样按实际编译出的类分层，原始 APP 报告保留全部告警。

每次 `/check` 还会自动生成同目录的 **`check.md` 中文质检报告**，无需额外参数。它包含检查结论、阶段结果和测试数量、项目告警详情、依赖告警计数、诊断与限制，以及指向 JSON、测试证据和源码的链接。项目告警全部列出，有代码片段时一并显示；依赖明细遵循 `include-dependencies` 设置。失败、超时或测试未运行也会生成报告，并明确说明检查未通过，不能把零条记录当作安全结论。报告直接由检查数据生成，不额外调用模型或重新分析。

命令行输出可读报告路径；JSON 中的 `humanReportPath` 指向该文件。在 VS Code 等支持 Markdown 的编辑器中打开预览即可阅读。JSON 模式仍保持 stdout 为 JSON，路径提示输出到 stderr。`check-maven` 独立命令也会额外生成 `check.json` 和 `check.md`，原有后端 JSON 输出保持不变。

| `/check` 状态 | 含义 |
| --- | --- |
| `passed` | Maven 构建、实际项目测试及所选分析通过，项目零告警；复核仍为 `not_run` |
| `findings` | Maven 构建、测试通过，分析发现项目告警 |
| `tests_not_run` | 测试未运行；javac 完成分析时始终返回此状态，告警仍在结果中展示 |
| `build_failed`、`test_failed`、`analysis_failed` | 对应阶段失败，零告警也不能通过 |
| `unsupported`、`timeout`、`error`、`stale` | 不支持、超时/取消、运行错误或输入已变化，详见诊断 |

退出码为 `passed → 0`、`findings → 2`、其余 `1`；聊天保持可继续输入。默认显示阶段摘要和前十条项目/依赖告警，完整数据在报告中；`/set json on` 将完整结果输出到 stdout，面板和提示留在 stderr。`analysis-timeout` 控制单次 `/check` 预算，javac 默认 120000 毫秒、Maven 默认 600000 毫秒；`timeout` 仍控制模型任务预算。两种后端都不能据零告警证明代码没有缺陷。

可在项目 `taie-agent.json` 持久设置：

```json
{
  "buildBackend": "maven-docker",
  "dependencyNetwork": false,
  "includeDependencies": false
}
```

## 修复策略

CLI 默认采用 `repair-mode=ask`。模型可以根据原始任务编写示例或功能；发现检测告警后，由宿主控制是否继续修改这些缺陷。

| 模式 | 发现告警或编译错误后的处理 |
| --- | --- |
| `ask` | 每一轮追加修复前询问用户；明确输入 `y` / `yes`（也支持“是”“修复”）才同意，默认 `N`，空输入、拒绝或 EOF 都不开始修复 |
| `auto` | 在 `max-repairs`、模型轮数和时间预算内自动反馈并修复 |
| `off` | 保留缺陷、编译错误及其证据，不追加宿主修复任务 |

可在启动时指定，也可以在聊天中切换：

```powershell
npm start -- run --project examples/playground --repair-mode off --prompt '编写一个演示整数除零的 Java 示例'
npm start -- chat --project examples/playground --repair-mode ask
```

```text
/repair off
/repair ask
/repair auto
/set max-repairs 2
```

`/repair` 是 `/set repair-mode` 的快捷写法。选择 `ask` 只同意当前确认的那一轮；下一轮仍会再次询问。`max-repairs=0` 表示不追加修复轮次。

确认提示中可输入 `/config` 查看设置；普通任务或其他配置命令不会被当作修复同意，会留到下一轮处理。等待人工确认的时间不计入任务执行预算。JSON 模式下 `ask` 不进行交互询问，保留告警；需要自动修复时应显式选择 `auto`。配置面板和提示输出到 stderr，任务 JSON 输出到 stdout。

直接调用 agent API 时，为兼容原有调用，省略 `repairMode` 仍采用 `auto`。需要人工确认时，应传入 `repairMode: "ask"` 和 `confirmRepair` 回调；没有确认回调视为不同意。

`confirmRepair` 现在接收统一 `CheckResult`，可据 `stages.test`、项目告警和 `humanReportPath` 展示待修复证据。直接 API 调用 `configure` 时，配置省略 `sourceRoots` 会保留已冻结的 javac 范围；显式传入 `sourceRoots: undefined` 表示重新推断。Maven 的源码范围始终从构建取得。

## 当前任务覆盖与会话默认值

给聊天消息加前缀，可以只改变当前任务：

```text
--no-repair 编写一个保留空指针错误的演示程序，并解释检测结果
--skip-taie 先讨论设计
```

`--no-repair` 相当于本轮使用 `repair-mode=off`，仍会运行已启用的检测并保留告警。`--skip-taie` 则停用本轮两个 Tai-e 工具，宿主不执行 Tai-e 编译、分析或修复循环；普通读写与 shell 工具仍可使用。两者都不会永久改变会话设置；下一条任务继续按会话默认值运行。单独输入这些标志，会把覆盖预定到下一条实际任务。

单次 CLI 任务也支持这两个选项：

```powershell
npm start -- run --project examples/playground --no-repair --prompt '编写一个包含吞异常问题的示例'
npm start -- run --project examples/playground --skip-taie --prompt '解释静态分析'
```

在 `chat` 启动时传入这些标志，只覆盖启动输入或首条实际任务。`--prompt` 和 `--prompt-file` 也只提供启动时的一条输入，不会替换后续用户输入，不能通过 `/set` 修改。

需要改变以后每条任务的检测默认值时，使用会话设置：

```text
/analysis off
这轮只讨论设计
/analysis on
按讨论结果实现 Java 程序
```

`/analysis` 是 `/set analysis` 的快捷写法。会话默认关闭分析时，后续任务会一直跳过，直到再次开启；一次 `--skip-taie` 结束后也只恢复会话默认值。

## 全部设置及示例

设置命令为 `/set <设置名> <值>`，设置名也可以写成 `--model` 等 CLI flag 形式。布尔值接受 `on/off` 或 `true/false`；整数必须满足对应下限。

| 设置 | 默认值或含义 | 聊天示例 |
| --- | --- | --- |
| `project` | 当前项目目录 | `/set project ../other-java-project` |
| `build-backend` | 模型工具、宿主验收和 `/check` 共用后端，默认 `javac` | `/set build-backend maven-docker` |
| `dependency-network` | Maven 准备阶段联网，默认 `off` | `/set dependency-network on` |
| `include-dependencies` | `/check` 展示单列依赖告警，默认 `off` | `/set include-dependencies on` |
| `provider` | `deepseek`，启动时可由环境变量覆盖 | `/set provider deepseek` |
| `model` | `deepseek-v4-flash`，启动时可由环境变量覆盖 | `/set model deepseek-v4-flash` |
| `repair-mode` | CLI 默认 `ask` | `/set repair-mode ask` |
| `analysis` | 默认 `on` | `/set analysis off` |
| `max-repairs` | 默认 `2`，最小 `0` | `/set max-repairs 1` |
| `max-turns` | 默认 `30`，最小 `1` | `/set max-turns 40` |
| `timeout` | 任务执行的毫秒预算，不含人工等待，默认 `600000` | `/set timeout 900000` |
| `analysis-timeout` | 单次检查毫秒预算，默认 javac `120000` / Maven `600000` | `/set analysis-timeout 600000` |
| `analyses` | 基础模式默认三个检测器；扩展模式采用扩展组合 | `/set analyses ["null-pointer", "division-by-zero"]` |
| `source-root` | 默认自动推断源码目录 | `/set source-root ["src/main/java", "generated sources"]` |
| `classpath` | javac 默认空；Maven 从构建取得；`auto` 清除手工覆盖 | `/set classpath ["lib/one.jar", "D:/Java libraries/two.jar"]` |
| `main-class` | 默认未设置；污点分析需显式入口 | `/set main-class example.Main` |
| `taint-config` | 默认未设置；污点策略 YAML 文件 | `/set taint-config policies/taint.yml` |
| `taint-implicit-entries` | 默认 `on`，是否建模 JVM 隐式入口 | `/set taint-implicit-entries off` |
| `java-version` | 默认不指定 `javac --release` | `/set java-version 17` |
| `jar` | 显式配置、`TAIE_JAR` 或固定官方 JAR | `/set jar vendor/Tai-e/build/tai-e-all-0.5.4.jar` |
| `json` | 默认 `off`；任务结果使用 JSON 输出 | `/set json on` |

实际面板会展示项目配置和启动选项合并后的当前值。`taint-implicit-entries off` 会减少隐式 JVM 入口覆盖，结果中会记录这一限制。`java-version` 只控制编译目标；分析运行库仍由所选 JDK 提供。

### 数组、清除值与路径

数组接受 JSON，也接受简单逗号分隔列表。路径包含逗号或需要保留空格时，优先使用 JSON 数组；Windows 路径可使用 `/`，或按 JSON 规则把反斜杠写为 `\\`。

```text
/set analyses dropped-exception,clone-idiom,dead-code
/set source-root ["src/main/java", "generated sources"]
/set classpath ["D:/Java libraries/dependency,one.jar", "lib/two.jar"]
/set classpath []
/set source-root auto
/set main-class unset
/set taint-config unset
/set java-version unset
/set jar unset
```

`classpath []` 显式清空依赖，`classpath auto` 删除手工覆盖；`source-root auto` 清除显式源码目录，下一轮重新推断。Maven 不接受手工覆盖，空数组也算覆盖。源码目录和检测器数组不能设为空数组。`main-class`、`taint-config`、`java-version`、`jar` 可以用 `unset` 清除；清除 JAR 设置后，会重新使用 `TAIE_JAR` 或官方默认 JAR。

交互路径按以下基准解析：

- `/set project` 的相对路径以当前项目为基准。
- `/set jar`、`/set taint-config`、`source-root`、`classpath` 的相对路径以所选项目为基准。
- 环境变量 `TAIE_JAR` 的相对路径以启动进程的工作目录为基准。

例如，当前项目是 `D:/work/demo` 时，`/set project ../other` 切换到 `D:/work/other`；随后 `/set taint-config policy.yml` 指向 `D:/work/other/policy.yml`。面板显示解析后的绝对路径，Java home 环境状态仅供查看，不提供 API key 的显示或设置入口。

## 配置生效与会话历史

多数设置在原会话中修改，保留对话历史，并在下一条任务中应用；正在执行的任务不会中途切换配置。模型、修复策略、预算和分析配置都可以通过面板管理。

切换 `project` 会加载目标目录的 `taie-agent.json`，并开启新的 agent 会话，原项目的对话历史不带入新项目。全局模型选择、修复策略、模型轮数和任务时限等会话级预算继续保留。对于后端默认值，目标配置未指定 `jarPath` 或 `analyses` 时，分别沿用原会话的 JAR 或检测器组合；目标项目显式指定的值优先。

构建后端、准备联网和依赖告警设置以目标项目配置为准；未配置时恢复 javac/off/off，不把原项目的联网设置带到新项目。javac 模型任务冻结的源码范围不因修改检测器等无关配置而重新推断；手动 `/check` 独立解析当前配置。

污点规则在首次实际分析时读取为快照，跳过分析的任务不会读取规则文件。修改分析配置后，后续任务使用更新后的配置；单次分析及其修复过程保持对应快照。只修改规则文件内容时，可先清除再设回策略路径，或开启新会话，以读取新快照；仅重复设置相同路径不会构成配置变更。

## 结果含义

agent 结果现为 **`schemaVersion: 2`**，`checks` 保存统一 `CheckResult`（含 `stages`、项目/依赖计数、JSON 与 Markdown 路径），不再直接保存旧 `AnalysisReport`。`taie_analyze` 返回同一结构；`taie_get_finding` 默认查询项目告警，显式选择依赖归属且配置允许展示时才返回依赖详情。模型拿到的检查结果与最终宿主检查各自保留，宿主总会重新检查当前代码，不因模型工具刚报告通过就省略验收。

| `outcome` | 含义 |
| --- | --- |
| `verified` | 新的宿主构建、实际测试和分析均通过，项目零告警；误报复核仍未运行 |
| `skipped` | 本轮按显式选项或会话默认值跳过 Tai-e，任务正常完成 |
| `unresolved` | 保留了告警，例如关闭修复、拒绝修复或用尽预算 |
| `incomplete` | 项目测试未运行，例如 javac 编译和分析成功且项目零告警 |
| `check_failed` | 构建或测试失败未解决、分析失败、后端错误、超时或结果过期；具体原因见最后一次 check |
| `agent_error` | 模型调用、任务预算或其他 agent 执行错误 |

`verified` 和 `skipped` 的 CLI 退出码均为 `0`，其余为 `1`。自动化调用需要检查 `outcome`；`skipped` 没有通过静态检查，记录的 `checks` 为空、`repairRounds` 为 `0`。关闭修复或拒绝修复不会删除原始告警与证据。

兼容性变化：旧 `analysis_error` 统一为 `check_failed`；旧 javac 零告警任务原来可能返回 `verified`，现在返回 `incomplete`、退出码 1。独立 `analyze` 命令仍返回原分析协议及退出码，不能把其成功等同于运行了项目测试。检查中的 `sourceFingerprint` 和 Maven 的 `snapshotFingerprint` 对应后端记录，`analysisReportPath`、`backendReportPath` 可追溯完整版本和日志。

## 验证命令

```powershell
npm run typecheck
npm run test:host
npm run test:live:policy
npm run test:live:maven
```

`test:host` 包含本地宿主、修复权限、配置面板和真实 CLI 子进程测试，不请求模型或运行 Java。`test:live:policy` 调用环境中的 DeepSeek API，使用私有合成示例验证 off、ask 拒绝、ask 同意三个阶段，并独立编译执行 Java 断言；会产生 API 用量。

`test:live:maven` 在项目副本中调用真实模型和 Maven 容器，先验证测试失败不能因零静态告警放行，再由测试程序批准一次修复并核验新的构建、测试和分析结果。默认总预算 900000 毫秒，可通过 `TAIE_SMOKE_TIMEOUT_MS` 调整；只使用已有离线依赖缓存。
