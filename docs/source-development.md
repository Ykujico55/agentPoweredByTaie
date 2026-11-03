# Tai-e 源码开发

源码位于 `vendor/Tai-e/`，它是独立的 Git 检出；本项目只在 `tai-e-source.lock.json` 中记录官方仓库、基线标签和精确提交。基线为：

- 标签：`v0.5.4`
- 提交：`6474e7da62fb1f3b692331040e66692cbf4d630d`

`vendor/Tai-e/` 已从外层项目的 Git 跟踪中排除。Tai-e 的源码改动、分支和提交需要在它自己的仓库内管理。

## 下载、构建与选择

```powershell
npm run setup:taie-source
npm run build:taie-source
npm run test:taie-source
```

setup 会验证已有检出的来源和固定基线，并自动应用 `patches/tai-e-agent.patch` 中的检测器补丁。已经应用过的补丁会跳过；无法安全应用时会停止，保留本地修改和以基线为祖先的开发提交，不自动 reset、清理或覆盖已有检出。

build 调用上游自带的 Gradle wrapper 执行 `fatJar`，缓存放在项目的 `.tools/gradle-user-home/`。初次构建需要联网下载 Gradle、插件和 Maven 依赖。上游的 Java toolchain 固定为 17；脚本默认关闭自动下载 JDK，Gradle 会查找已安装的工具链。构建完成后，`.tools/tai-e/source-build.json` 记录 JAR 路径、SHA-256、源码提交、工作区修改状态和构建时间。

本机已经构建成功：Gradle 运行在 JDK 21 上，实际编译工具链是 Gradle 发现的已有 Microsoft JDK 17（`C:\Users\kunji\.jdks\ms-17.0.20.1`）。没有安装新的系统 JDK，也没有修改上游构建文件。

选择 JDK 可以设置 `TAIE_JAVA_HOME` 或 `JAVA_HOME`。以本地安装的 JDK 17 为例：

```powershell
$env:TAIE_JAVA_HOME = "C:\path\to\jdk-17"
npm run build:taie-source
```

确需让 Gradle 自动供应缺少的工具链时，可显式设置 `TAIE_AUTO_DOWNLOAD_JDK=true`；缓存仍在当前项目的 `.tools/gradle-user-home/` 中。

构建成功后可显式选择本地 JAR：

```powershell
npm run analyze -- --project examples/buggy --jar vendor/Tai-e/build/tai-e-all-0.5.4.jar
npm start -- chat --project examples/playground --jar vendor/Tai-e/build/tai-e-all-0.5.4.jar
```

使用扩展启动器会校验构建 manifest 和 JAR 摘要，并默认启用基础三项、空指针和整数除零检测：

```powershell
npm run analyze:extended -- --project examples/division-buggy
npm run start:extended -- chat --project examples/playground
```

或设置环境变量，以便多次运行：

```powershell
$env:TAIE_JAR = (Resolve-Path vendor/Tai-e/build/tai-e-all-0.5.4.jar).Path
npm start -- chat --project examples/playground
Remove-Item Env:TAIE_JAR
```

`--jar` 的相对路径基于命令的启动目录；项目配置文件中的 `jarPath` 相对于目标 Java 项目。环境变量建议使用绝对路径。未显式选择 JAR 时，继续使用固定的官方发行版及其严格 SHA-256 校验。

## 适合修改的位置

| 目标 | 源码位置 |
| --- | --- |
| 新增和调整 bug 检测器 | `vendor/Tai-e/src/main/java/pascal/taie/analysis/bugfinder/` |
| 空指针检测器 | `vendor/Tai-e/src/main/java/pascal/taie/analysis/bugfinder/nullpointer/` |
| 注册分析与依赖关系 | `vendor/Tai-e/src/main/resources/tai-e-analyses.yml` |
| 污点分析与传播模型 | `vendor/Tai-e/src/main/java/pascal/taie/analysis/pta/plugin/taint/` |
| 分析器测试 | `vendor/Tai-e/src/test/java/pascal/taie/analysis/` |
| agent 侧调用和结果转换 | 本项目 `src/taie.ts` |
| Java 结果导出和 PTA 证据插件 | 本项目 `java-adapter/` |
| SARIF、告警 ID 和复核模板 | 本项目 `src/reporting.ts` |

建议把改动集中在分析器、插件和结果导出接口；涉及底层 IR、指针分析等核心算法时，补充相应回归测试。

首次修改前可以建立自己的本地分支：

```powershell
git -C vendor/Tai-e switch -c taie-agent-dev
```

setup 检出基线并应用补丁，不自动创建开发分支。后续如需推送自己的 GitHub fork，请为官方仓库保留 `upstream` remote，以便继续验证和同步基线。

源码检出不由外层项目跟踪，因此修改完成后应同步导出补丁：

```powershell
npm run export:taie-patches
npm run test:taie-patches
```

导出脚本包含相对固定基线的修改和新增文件；验证脚本在干净基线上实际应用补丁，并逐文件对比当前检出。这样重新下载源码也能恢复这些扩展。

## 当前接入契约

本地 JAR 会作为 `custom` artifact 记录，保留实际版本、Git commit 标记和 SHA-256。自定义 JAR 仍需成功编译并执行 Java exporter，返回预期 JSON schema、分析覆盖数量、合法 finding 和完成标记；编译或运行失败不会被当成干净结果。

目前适配层支持六种分析 ID：`dropped-exception`、`clone-idiom`、`dead-code`、`null-pointer`、`division-by-zero` 和 `taint`。源码补丁修复已复现的 null 常量分析异常，并新增原生整数除零检测器；污点证据插件和 Java exporter 在 `java-adapter/` 独立维护，每轮与所选 JAR 一起编译。插件使用真实 PTA 结果，报告中的传播路径保留抽象图语义。

继续新增分析时，需在 `src/taie.ts` 注册允许的 ID 和依赖配置，在 `java-adapter/TaieAgentExporter.java` 读取对应作用域的结果，并补充原生与宿主集成验证。详细配置、结果文件和当前检测范围见 [扩展功能说明](extensions.md)。

`npm run test:taie-source` 不调用大模型；它校验构建 manifest 的 JAR 摘要，使用实际源码构建验证 clean/buggy、空指针回归、除零正反例、污点与检测器组合，以及 `TAIE_JAR` 环境变量选择。普通 `npm test` 以官方发行版为基线，另测真实污点插件、自定义 artifact 和默认 JAR 被篡改时的拒绝行为。`npm run test:live:extended` 进一步调用真实模型，验证宿主发现除零告警后，模型取证、修复并重新分析的完整闭环。

上游构建说明：[Tai-e v0.5.4 README](https://github.com/pascal-lab/Tai-e/blob/v0.5.4/README.md#how-to-obtain-runnable-tai-e)。
