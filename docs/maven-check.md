# Maven 容器检查

`check-maven` 是接入真实构建的独立入口，检查普通单模块 Maven `jar` 项目。聊天可用 `/set build-backend maven-docker` 后执行 `/check`，也可提交代码任务，让模型工具和宿主自动验收使用相同后端，详见 [交互配置](interactive-settings.md)。手动检查不请求模型、不修改原项目源码；代码任务由模型修改工作区，Maven 在每次新快照中检查。独立 `analyze` 仍是原 javac 入口。

## 运行

需要 Docker Linux 引擎。首次构建镜像及准备项目依赖需要网络：

```powershell
npm ci --ignore-scripts
npm run setup:taie
npm run build:maven-image
npm run check:maven -- --project tests/fixtures/maven-simple --dependency-network on
```

镜像固定 Maven 3.9.9、JDK 17、Node 22.19.0，基础镜像按 digest 固定，Node 依赖使用锁文件。每次检查记录实际镜像 ID。修改容器内使用的 TypeScript 或 Java 适配器后，需要重新运行 `build:maven-image`。

`--dependency-network on` 只允许准备阶段联网；随后构建、测试和分析在另一个 `--network none` 容器中执行。默认 `off`，缓存齐备后可直接离线检查。缺依赖时保留失败日志，不自动回退联网。准备阶段执行 Maven 项目配置，也在隔离环境中进行。

Maven 缓存现保存在 Docker 管理的 Linux 卷中，名称记录在报告 `storage.repositoryVolume`；按本仓库安装路径区分缓存。每轮工作目录与输入也使用独立 Linux 卷，通过批量拷入/导出与宿主交换文件，运行期间不反复读取 Windows bind mount。旧 `.tools/maven-repository` 不再被自动使用；升级后首次可用 `--dependency-network on` 填充新缓存。本次开发验证单独导入了已有缓存，迁移耗时不计入后续检查。

| 参数 | 含义 |
| --- | --- |
| `--project` | Maven 项目目录。 |
| `--dependency-network on\|off` | 准备阶段网络开关，默认 `off`，用于 `check-maven` 和 `run/chat`。 |
| `--include-dependencies` | 显示独立的依赖告警列表；默认不显示详情，且始终不影响项目状态，用于 `check-maven` 和 `run/chat`。 |
| `--timeout` | 包含准备、构建、测试和分析的总时限，默认 600000 毫秒。 |
| `--analyses`、`--jar` | 检测器组合及 Tai-e JAR，支持显式选择源码扩展构建。 |
| `--main-class`、`--taint-config`、`--taint-implicit-entries` | 沿用污点入口与策略配置。 |

源码目录、classpath 和编译产物由 Maven 提供，暂不接受手工覆盖。`--java-version` 若指定，必须为 17。聊天用 `/set source-root auto`、`/set classpath auto` 清除已有手工覆盖。`/check` 使用 `analysis-timeout` 预算，并另存统一 `check.json`，原始后端协议不变。

使用 Maven 后端的模型任务默认启用修改前基线，每轮在模型开始前额外执行一次真实检查，耗时计入任务预算，不计入修复次数。`run/chat --baseline off` 或聊天 `/set baseline off` 只关闭基线，最终验收仍执行；`--skip-taie` 同时跳过两者。独立 `check-maven` 与手动 `/check` 仍是单次检查。

## 执行与结果

宿主复制项目快照，排除旧构建产物、`.git`、`.taie-agent`、`.tools`、`node_modules` 和 `.env` 文件；当前不支持项目内符号链接。原项目只用于读取和检查变化，不挂入容器。

构建后对照输入指纹检查变化。有效 POM 声明的自定义输出目录不作为源码变化；输出目录若覆盖项目根、主源码或标准测试源码目录，当前返回 `unsupported`。

容器只挂载本次工作卷、只读输入卷和专用 Maven 缓存卷。项目以 uid/gid 1000 运行，无额外 capabilities，根文件系统只读，限制为 2 CPU、2 GiB 内存和 256 个进程；`/tmp` 为 256 MiB 临时文件系统，可执行以支持 Jansi 等 JVM 原生库。仅受信的初始化助手使用 root 和 CHOWN 修正拷入文件的所有权，不执行项目命令。模型密钥不传入容器，Docker 管理接口不挂载。

阶段结束后先停止项目进程，验证导出目录中没有符号链接或特殊文件，再导出源码、产物、报告及本次使用的依赖文件；复制依赖时检查真实路径的仓库边界。成功导出后清理本次容器和临时卷，缓存卷保留。超时/取消后的导出与清理有独立短时限，因此最终墙钟时间可能超过项目执行预算；不回退本机执行。导出失败时不会通过，并在 `storage.recoveryVolume` 中记录保留的工作卷，避免删除尚未导出的故障证据。

Maven 提供有效 POM、主类产物及依赖 classpath；源码来自编译器生成的 `compile/*/inputFiles.lst`，另记录实际存在的注解生成目录。编译沿用项目的注解处理设置；测试读取真实 Surefire XML。Tai-e 直接分析 Maven 生成的 classes，不再次编译项目。当前 classpath 包含测试依赖，报告明确标记这一范围。

运行报告保存在项目 `.taie-agent/maven-runs/<runId>/report.json`，同时保留快照、各阶段日志与耗时、Maven 结果和原始 Tai-e JSON/SARIF。原始报告保留容器路径；`analysis/` 中另存映射到本地路径的 JSON/SARIF，方便查看源码和证据。

通过 `check-maven` CLI 或聊天 `/check` 运行时，同目录还会自动生成统一 `check.json` 和便于阅读的中文 **`check.md`**。Markdown 报告列出阶段结论、测试计数、项目告警详情、依赖计数及证据链接，依赖详情遵循 `include-dependencies` 设置；失败也会生成报告。CLI 显示文件路径，原有 `report.json` 与 `check-maven` 的 stdout JSON 协议保持不变。

模型任务的后续检查还会与本轮原始基线比较，在 `comparison` 和中文报告中展示项目告警的新增、消失、延续和变化。基线失败保留实际报告并允许原任务继续，不伪造空基线；构建或分析未完成、分析环境不一致时不给增减数字。测试失败但构建和分析完成时仍可比较静态告警，原测试失败保留。差异描述不证明修复或误报，不豁免既有告警或失败测试。

准备和检查分别导出到 `prepare-workspace/`、`check-workspace/`，不合并覆盖，以便发现构建期间的输入删除或修改。报告中的依赖路径指向各自 `dependencies/` 下导出的真实文件，而不是宿主不可访问的卷路径。导入、导出和清理也有独立进程耗时日志。

| 状态 | 含义 |
| --- | --- |
| `passed` | Maven 构建和至少一个实际测试通过，所选 Tai-e 分析完成且无项目告警。依赖仍可能有告警。 |
| `findings` | 构建和测试通过，分析完成且有项目告警。 |
| `build_failed`、`test_failed` | 构建或测试执行阶段失败。 |
| `tests_not_run` | 没有实际执行成功的测试，包括没有报告或全部跳过。 |
| `analysis_failed`、`unsupported` | 分析未完成，或适配器不支持该项目或配置。 |
| `timeout`、`error`、`stale` | 超时或取消、运行错误、原项目或构建副本中的输入已经变化。 |

退出码为 `passed → 0`、`findings → 2`、其余 `1`。`review` 始终为 `not_run`，本入口没有误报复核或自动修复；`passed` 不代表产品级复核完成或程序无缺陷。`test` 阶段不覆盖 Maven `verify` 的集成测试生命周期。

Tai-e 0.5.4 的 `APP` 将已加载的非 JRE 依赖类也视为应用类。分析仍保留完整 classpath 和传播关系；报告按实际 Maven classes 清单分层，不改变分析范围，也不把依赖告警判为误报。

Maven 顶层协议为 `schemaVersion: 2`、`statusScope: "project"`。`analysis.findings` 只包含 `origin: "project"` 的告警，`analysis.findingCounts` 分别记录 `project`、`dependency` 和 `total`。默认 JSON、SARIF、复核模板不包含依赖告警详情；开启 `--include-dependencies` 后，JSON 在 `analysis.dependencyFindings` 中单列 `origin: "dependency"` 的告警，SARIF 的每条结果带 origin，复核模板也分成两个列表。开关不改变顶层状态、退出码或项目告警列表。

归属按告警主位置的 `className` 是否属于 Maven 产物精确判断，因此内部类、匿名类和生成类即使没有源码映射也保留为项目代码；不按库包名前缀判断。污点告警按 sink 所在调用方法的类归属，完整 source/sink/path 证据保留。origin 表示报告位置的归属，不证明依赖缺陷不会影响项目。评测和项目复核使用项目列表，依赖告警需独立统计。

完整原始 APP 报告通过 `analysis.evidence.containerReport` 保留，所有带 origin 的依赖告警另存于 `analysis.evidence.dependencyFindings` 指向的文件，类清单由 `analysis.evidence.projectClasses` 记录。旧镜像缺少分层结果时返回错误并提示重建，不能把旧的混合列表当作项目结果。手动 `/check`、模型工具及自动验收都按项目/依赖分层；独立 `analyze` 保留原有 APP 报告语义。

## 当前范围与验证

当前要求 Maven Compiler Plugin 生成实际编译输入清单；缺失清单时返回 `unsupported`，不会通过扫描整个项目来猜测编译范围。

支持常规单模块 jar 路径；多模块、非 jar、外部目录、独立 compiler/test toolchain 和额外编译输出等配置明确拒绝。准备阶段只解析 clean、compile、test 所需的插件及传递依赖，再单独解析项目依赖；不使用会准备无关发布插件的全量 `go-offline`。某些插件运行时动态下载的依赖仍可能缺失，此时离线检查失败并保留原因。

生成代码目录可随 Maven 编译结果进入分析，但只过滤生成代码自身告警、复杂插件配置和注解处理器专项验收还未完成。基础修改前基线已接入模型任务；聊天工具隔离、只读复核和候选补丁流程仍按 [开发计划](development-plan.md) 后续实施。

```powershell
npm run test:maven
```

该回归在独立临时项目检查默认隐藏依赖、显式展示依赖、测试失败、编译失败、项目自身吞异常以及 JDK 实现的零告警对照，不请求模型。首次运行允许准备依赖，后续案例离线执行；结果保存在仓库 `.taie-agent/maven-smoke/`。
