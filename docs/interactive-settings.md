# 交互配置与修复确认

启动聊天后，可以直接查看和修改当前会话的配置，无需退出进程：

```powershell
npm start -- chat --project examples/playground
```

聊天中的 `/config` 和 `/settings` 显示同一份完整配置面板，包括全部 18 项设置、对应 CLI flag、有效默认值和解析后的绝对路径。`/help` 显示完整 CLI 帮助，`/exit` 退出聊天。

```text
/config
/set model deepseek-v4-flash
/set max-turns 40
/repair ask
/analysis on
```

这些配置命令由宿主处理，不会向模型发送消息，也不会触发 Tai-e 分析；修改默认只保存在当前进程中，不写入项目的 `taie-agent.json`。未知设置、缺少值或不合法的枚举、数组、数值会直接报错，原配置保留。模型与供应商的组合、凭据在下一条任务开始前验证，因此可以分两条命令修改 provider 和 model。

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
| `provider` | `deepseek`，启动时可由环境变量覆盖 | `/set provider deepseek` |
| `model` | `deepseek-v4-flash`，启动时可由环境变量覆盖 | `/set model deepseek-v4-flash` |
| `repair-mode` | CLI 默认 `ask` | `/set repair-mode ask` |
| `analysis` | 默认 `on` | `/set analysis off` |
| `max-repairs` | 默认 `2`，最小 `0` | `/set max-repairs 1` |
| `max-turns` | 默认 `30`，最小 `1` | `/set max-turns 40` |
| `timeout` | 任务执行的毫秒预算，不含人工等待，默认 `600000` | `/set timeout 900000` |
| `analysis-timeout` | 单次编译与分析的毫秒时限，默认 `120000` | `/set analysis-timeout 180000` |
| `analyses` | 基础模式默认三个检测器；扩展模式采用扩展组合 | `/set analyses ["null-pointer", "division-by-zero"]` |
| `source-root` | 默认自动推断源码目录 | `/set source-root ["src/main/java", "generated sources"]` |
| `classpath` | 默认空数组 | `/set classpath ["lib/one.jar", "D:/Java libraries/two.jar"]` |
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

`classpath []` 清空依赖；`source-root auto` 清除显式源码目录，下一轮重新推断。源码目录和检测器数组不能设为空数组。`main-class`、`taint-config`、`java-version`、`jar` 可以用 `unset` 清除；清除 JAR 设置后，会重新使用 `TAIE_JAR` 或官方默认 JAR。

交互路径按以下基准解析：

- `/set project` 的相对路径以当前项目为基准。
- `/set jar`、`/set taint-config`、`source-root`、`classpath` 的相对路径以所选项目为基准。
- 环境变量 `TAIE_JAR` 的相对路径以启动进程的工作目录为基准。

例如，当前项目是 `D:/work/demo` 时，`/set project ../other` 切换到 `D:/work/other`；随后 `/set taint-config policy.yml` 指向 `D:/work/other/policy.yml`。面板显示解析后的绝对路径，Java home 环境状态仅供查看，不提供 API key 的显示或设置入口。

## 配置生效与会话历史

多数设置在原会话中修改，保留对话历史，并在下一条任务中应用；正在执行的任务不会中途切换配置。模型、修复策略、预算和分析配置都可以通过面板管理。

切换 `project` 会加载目标目录的 `taie-agent.json`，并开启新的 agent 会话，原项目的对话历史不带入新项目。全局模型选择、修复策略、模型轮数和任务时限等会话级预算继续保留。对于后端默认值，目标配置未指定 `jarPath` 或 `analyses` 时，分别沿用原会话的 JAR 或检测器组合；目标项目显式指定的值优先。

污点规则在首次实际分析时读取为快照，跳过分析的任务不会读取规则文件。修改分析配置后，后续任务使用更新后的配置；单次分析及其修复过程保持对应快照。只修改规则文件内容时，可先清除再设回策略路径，或开启新会话，以读取新快照；仅重复设置相同路径不会构成配置变更。

## 结果含义

| `outcome` | 含义 |
| --- | --- |
| `verified` | 新的宿主编译、分析均完成，所配置检测器无告警 |
| `skipped` | 本轮按显式选项或会话默认值跳过 Tai-e，任务正常完成 |
| `unresolved` | 保留了告警，例如关闭修复、拒绝修复或用尽预算 |
| `analysis_error` | 编译错误未解决，或分析未能完成 |
| `agent_error` | 模型调用、任务预算或其他 agent 执行错误 |

`verified` 和 `skipped` 的 CLI 退出码均为 `0`，其余为 `1`。自动化调用需要检查 `outcome`；`skipped` 没有通过静态检查，记录的 `checks` 为空、`repairRounds` 为 `0`。关闭修复或拒绝修复不会删除原始告警与证据。

## 验证命令

```powershell
npm run typecheck
npm run test:host
npm run test:live:policy
```

`test:host` 包含本地宿主、修复权限、配置面板和真实 CLI 子进程测试，不请求模型或运行 Java。`test:live:policy` 调用环境中的 DeepSeek API，使用私有合成示例验证 off、ask 拒绝、ask 同意三个阶段，并独立编译执行 Java 断言；会产生 API 用量。
