# Maven 容器检查

`check-maven` 是接入真实构建的第一个独立入口，检查普通单模块 Maven `jar` 项目。它不请求模型，不修改原项目源码；现有 `run`、`chat` 和 `analyze` 尚未迁移到这个容器后端。

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

| 参数 | 含义 |
| --- | --- |
| `--project` | Maven 项目目录。 |
| `--dependency-network on\|off` | 准备阶段网络开关，默认 `off`，仅用于 `check-maven`。 |
| `--timeout` | 包含准备、构建、测试和分析的总时限，默认 600000 毫秒。 |
| `--analyses`、`--jar` | 检测器组合及 Tai-e JAR，支持显式选择源码扩展构建。 |
| `--main-class`、`--taint-config`、`--taint-implicit-entries` | 沿用污点入口与策略配置。 |

源码目录、classpath 和编译产物由 Maven 提供，暂不接受手工覆盖。`--java-version` 若指定，必须为 17。聊天中的构建后端切换属于下一步集成。

## 执行与结果

宿主复制项目快照，排除旧构建产物、`.git`、`.taie-agent`、`.tools`、`node_modules` 和 `.env` 文件；当前不支持项目内符号链接。原项目只用于读取和检查变化，不挂入容器。

构建后对照输入指纹检查变化。有效 POM 声明的自定义输出目录不作为源码变化；输出目录若覆盖项目根、主源码或标准测试源码目录，当前返回 `unsupported`。

容器只挂载本次工作目录、只读输入和专用 Maven 缓存。运行用户无额外 capabilities，根文件系统只读，限制为 2 CPU、2 GiB 内存和 256 个进程；`/tmp` 为 256 MiB 临时文件系统，可执行以支持 Jansi 等 JVM 原生库。模型密钥不传入容器，Docker 管理接口不挂载。超时或取消后宿主清理本次命名容器，不回退到本机执行。

Maven 提供有效 POM、主类产物及依赖 classpath；源码来自编译器生成的 `compile/*/inputFiles.lst`，另记录实际存在的注解生成目录。编译沿用项目的注解处理设置；测试读取真实 Surefire XML。Tai-e 直接分析 Maven 生成的 classes，不再次编译项目。当前 classpath 包含测试依赖，报告明确标记这一范围。

运行报告保存在项目 `.taie-agent/maven-runs/<runId>/report.json`，同时保留快照、各阶段日志与耗时、Maven 结果和原始 Tai-e JSON/SARIF。原始报告保留容器路径；`analysis/` 中另存映射到本地路径的 JSON/SARIF，方便查看源码和证据。

| 状态 | 含义 |
| --- | --- |
| `passed` | Maven 构建和至少一个实际测试通过，所选 Tai-e 分析完成且无告警。 |
| `findings` | 构建和测试通过，分析完成但有告警。 |
| `build_failed`、`test_failed` | 构建或测试执行阶段失败。 |
| `tests_not_run` | 没有实际执行成功的测试，包括没有报告或全部跳过。 |
| `analysis_failed`、`unsupported` | 分析未完成，或适配器不支持该项目或配置。 |
| `timeout`、`error`、`stale` | 超时或取消、运行错误、原项目或构建副本中的输入已经变化。 |

退出码为 `passed → 0`、`findings → 2`、其余 `1`。`review` 始终为 `not_run`，本入口没有误报复核或自动修复；`passed` 不代表产品级复核完成或程序无缺陷。`test` 阶段不覆盖 Maven `verify` 的集成测试生命周期。

Tai-e 0.5.4 的 `APP` 将已加载的非 JRE 依赖类也视为应用类，因此告警可能来自第三方库。当前保留这些原始告警；本次修改与历史/依赖告警的归类属于后续基线功能，不通过自动过滤来取得零告警结果。

## 当前范围与验证

当前要求 Maven Compiler Plugin 生成实际编译输入清单；缺失清单时返回 `unsupported`，不会通过扫描整个项目来猜测编译范围。

支持常规单模块 jar 路径；多模块、非 jar、外部目录、独立 compiler/test toolchain 和额外编译输出等配置明确拒绝。准备阶段只解析 clean、compile、test 所需的插件及传递依赖，再单独解析项目依赖；不使用会准备无关发布插件的全量 `go-offline`。某些插件运行时动态下载的依赖仍可能缺失，此时离线检查失败并保留原因。

生成代码目录可随 Maven 编译结果进入分析，但只过滤生成代码自身告警、复杂插件配置和注解处理器专项验收还未完成。修改前基线、聊天工具隔离、只读复核和候选补丁流程仍按 [开发计划](development-plan.md) 后续实施。

```powershell
npm run test:maven
```

该回归在独立临时项目检查依赖告警、测试失败、编译失败、项目自身吞异常以及 JDK 实现的零告警对照，不请求模型。首次运行允许准备依赖，后续案例离线执行；结果保存在仓库 `.taie-agent/maven-smoke/`。
