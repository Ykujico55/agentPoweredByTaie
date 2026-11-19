# SQL 注入告警小规模探针

第一步建立“案例—独立判断依据—实际 Tai-e 告警”的对照表，第二步对选定告警运行固定证据视图的独立模型复核。SQL 分析脚本本身不调用模型，`modelRequests` 为 0；复核使用另一个显式命令。两个步骤都属于开发用小规模探针，不提供通用误报识别准确率或成本收益结论。

## 运行

使用已构建的 JDK 17/Maven Docker 镜像，环境与隔离边界见 [Maven 检查说明](maven-check.md)。首次准备本案例依赖：

```powershell
npm run test:sql -- --prepare-dependencies
```

缓存齐备后离线执行：

```powershell
npm run test:sql
```

准备依赖时允许联网，后续构建、测试与分析阶段保持离线。项目使用 [POM](../tests/fixtures/sql-probe/pom.xml) 固定 H2 **2.3.232**、JUnit **4.13.2** 及 Maven 插件版本；H2 版本参考 [官方发布页](https://github.com/h2database/h2database/releases/tag/version-2.3.232)。实际镜像 ID、JDK 版本、Tai-e JAR 摘要和输入指纹随结果保存。模型 API 凭据不是运行本探针的前提。

每次执行将 fixture 复制到独立的 `.taie-agent/sql-probe/<运行ID>/project/`，保留原 fixture。运行根目录生成 `result.json`，成功取得完整阶段结果后还生成 `matrix.md`；具体构建、测试、分析日志和快照在复制项目的 `.taie-agent/maven-runs/` 中。失败原因同样保存，不把分析失败当成零告警。

## 分析策略及其含义

[配置](../tests/fixtures/sql-probe/taie-agent.json) 指定 `example.Main` 为入口，仅运行 `taint`，关闭隐式 JVM 入口。当前宿主 PTA 配置为 `cs: ci`，即上下文不敏感；这些选择限定本次分析范围，不代表全部 Java/JDBC 场景的覆盖。

[污点规则](../tests/fixtures/sql-probe/taint.yml) 固定以下内容：

- 当前 `CaseA` 至 `CaseF` 的 6 个 `read(String)` 返回值分别为 source。方法仅返回传入参数，明确建模本例外部输入的信任边界；首轮历史快照只有 A–D 四个 source。
- sink 为真实 JDBC 接口 `java.sql.Statement.executeQuery(String)` 的第 0 个参数，不用打印函数代替 SQL 执行。
- `call-site-mode: true` 按可达方法中的接口调用点匹配 sink，不以 points-to 分析已解析出具体 JDBC 驱动实现为前提。这是配置的调用点语义；告警本身不证明实际数据库连接、执行路径或注入利用成立。
- 为 `String.concat(String)` 配置 receiver 和参数到返回值的 transfer，使 A 的两次显式拼接保留污染。规则没有把某个自定义方法直接声明为 sanitizer。

独立 JUnit 测试使用真实 H2 内存数据库。测试中的 JDBC 代理只记录查询文本，然后委托真实 `Statement` 执行；返回的行号来自数据库结果，而非代理编造。Tai-e 的污点模型和 H2 的运行观测分别记录，不宣称 Tai-e 已完整分析数据库内部行为。

## 案例与独立判断依据

主源码使用中性的类名，见 [CaseA](../tests/fixtures/sql-probe/src/main/java/example/CaseA.java)、[CaseB](../tests/fixtures/sql-probe/src/main/java/example/CaseB.java)、[CaseC](../tests/fixtures/sql-probe/src/main/java/example/CaseC.java)、[CaseD](../tests/fixtures/sql-probe/src/main/java/example/CaseD.java)、[CaseE](../tests/fixtures/sql-probe/src/main/java/example/CaseE.java)、[CaseF](../tests/fixtures/sql-probe/src/main/java/example/CaseF.java)。独立断言与观测导出位于 [QueryBehaviorTest](../tests/fixtures/sql-probe/src/test/java/example/QueryBehaviorTest.java)，不应作为后续复核模型的输入。

以下是固定代码下的独立判断及测试要求，不是预先宣称 Tai-e 会报告哪些告警：

| 案例 | 判断依据 | 独立 SQL 测试要求 |
| --- | --- | --- |
| A | 输入被拼入 SQL 单引号值，没有参数绑定或过滤；存在改变查询结构的输入。 | `alice` 查询仅返回 id 1；`alice' OR '1'='1` 应返回 id 1、2，同时核对实际提交的 SQL 文本。 |
| B | sink 使用第二次 `identity` 调用的返回值，该次实参为固定 SQL。 | 注入字符串和 `null` 输入均应提交固定 SQL，并仅返回 id 1。 |
| C | 污染赋值与 sink 分别受同一 `flag` 和 `!flag` 保护。 | `flag=false` 时执行固定 SQL、返回 id 1；`flag=true` 时返回 `null`，不调用 `executeQuery`。 |
| D | source 的返回值被丢弃，sink 实参直接为固定 SQL 字面量。 | 普通输入与注入字符串均应提交固定 SQL，并仅返回 id 1。 |
| E | 第一次 `helper.apply` 保存外部输入，第二次调用仍返回保存值，尽管第二次实参是常量。 | 固定查询输入返回 `[1]`；输入 `SELECT id FROM accounts` 应真正提交该 SQL，返回 `[1,2]`。 |
| F | 与 E 相同的调用结构和 `apply` 名称，但 helper 只返回本次实参，第二次返回常量。 | 使用与 E 相同的两种 SQL 输入，均应提交固定查询、返回 `[1]`。 |

A、E 的执行测试用于寻找漏洞存在的具体反例。B、C、D、F 的有限输入测试只佐证观测，安全性依据来自下面的完整代码论证：

- **B：** `identity` 是本类 `private static` 方法，唯一语句为 `return value`，不读写共享状态。第一次调用的输入来自 source，但返回值被丢弃；第二次调用独立接收固定字面量，其返回值赋给 `query`。`query` 没有其他赋值，直接作为唯一 sink 调用的实参。因此，对任意输入字符串或 `null`，该 sink 收到的 SQL 都是常量。上下文合并可能造成告警，但是否实际发生必须运行确认。
- **C：** `flag` 是方法的局部基本类型参数，方法内没有重赋值。`flag=true` 时，虽然 `query` 被 source 返回值覆盖，`!flag` 必为假，最终直接返回 `null`；`flag=false` 时，污染赋值不执行，sink 仅得到初始化的常量 SQL。两种布尔值覆盖该方法全部正常路径，没有其他汇入赋值或额外 sink。
- **D：** `read(input)` 仅返回参数且结果未保存。唯一 `executeQuery` 调用的实参为字面量，与输入无关。
- **E：** 每次 `execute` 新建一个局部 `Helper`。第一次调用时 `initialized=false`，因此保存输入并置为 `true`；第二次调用不覆盖保存值，直接返回首次输入到 sink。第一次返回值被丢弃不能消除字段写入的副作用。两次调用共享该局部对象，没有全局或跨测试状态；外部输入可决定整个 SQL 文本，使用真实执行反例验证其影响。
- **F：** 私有 final 嵌套 helper 不含字段，`apply` 的唯一语句为 `return value`。完整 `execute` 与 E 同形，但第二次调用始终返回自己的常量实参，且 `query` 没有其他赋值。因此任意输入不能通过该 helper 改变唯一 sink 的 SQL。名称 `apply` 本身不提供这个保证，判断依赖实际实现。

这些论证限于保存的 fixture 代码及固定前提：攻击者控制输入值，JDBC 实现按提交的 SQL 执行；数据库表结构和内容由测试建立；不引入修改辅助方法、字节码插桩、恶意 JDBC 实现或其他未建模程序变更。B、C、D、F 的结论是“输入不能在这些 sink 调用中改变 SQL 结构”，不是对任意部署、权限配置或整个数据库系统的安全保证。异常导致调用提前终止也不能作为攻击者输入到达 sink 的证据。

E/F 的调用片段故意同形：没有 helper 实现时，片段本身不能区分保存输入与纯返回两种行为。E 是检验“丢弃第一次返回值就判安全”的真实反例，F 是中性命名的安全对照；它们不是只改方法名的严格消融实验，不能单独用于估计命名因素的因果效果。当前 fixture 的 6 项 JUnit 测试已在第二轮真实运行通过，导出 12 条观测；证据见下文。

## 如何阅读对照表

脚本先要求构建、真实测试和分析均完成，再按告警主位置的案例类统计项目 `TAINT_FLOW`：

- A、E 有告警，结合独立漏洞执行证据，记为真阳性；没有告警则保留为漏报。
- B、C、D、F 有告警时，结合上述代码论证，记为固定前提下的误报；没有告警则为阴性对照，不能记成模型成功排除误报。
- 未映射到案例的项目告警另存，不丢弃；依赖告警与项目告警分开。

`result.status: completed` 仅表示探针取得可用结果，不保证一定找到了真告警和误报告警。`capabilityInputsAvailable` 表示是否同时观察到可供后续复核的真阳性和固定前提下的误报。没有满足条件时应检查具体结果，不调整标签或规则来强行得到预期数量。

JUnit 通过表示实际行为符合这些测试断言，其中包含复现 A、E 的漏洞；不能将“测试通过”解读为所有案例安全。原始 Tai-e 告警及项目质检状态继续保留，对照表的独立分类不关闭告警。

## 第一步实测结果

以下是 2026-11-03 首轮 **A–D 四案例历史快照**的结果，保留原始证据，不代表当前六案例的新运行结果。该轮完成了 Maven 构建、**4 个 JUnit 测试**及 Tai-e 分析，检查耗时 **229.65 秒**。项目告警 **3 条**，依赖告警 **0 条**；本次模型请求为 0。

| 案例 | 实际项目 `TAINT_FLOW` | 独立分类 | SQL 执行观测 |
| --- | ---: | --- | --- |
| A | 1 | 真阳性 | 普通输入返回 `[1]`；注入输入改变 SQL 文本，返回 `[1,2]`。 |
| B | 1 | 固定前提下的误报 | 注入字符串与 `null` 均执行固定 SQL，返回 `[1]`。 |
| C | 1 | 固定前提下的误报 | `flag=false` 执行固定 SQL，返回 `[1]`；`flag=true` 没有 SQL 调用。 |
| D | 0 | 阴性对照 | 两种输入都执行固定 SQL，返回 `[1]`。 |

B 的导出抽象路径经过 `identity` 的参数节点，再返回到第二次常量调用的结果，符合上下文合并的候选机制；完整快照代码证明第二次调用实际只能返回自己的常量参数。C 的路径节点合并了常量定义与 `read` 定义，但完整方法中的互斥分支证明污染定义不能到达该 sink。误报分类来自完整代码论证及固定前提，SQL 观测用于佐证，不是以少量测试未复现代替证明。

证据：[完整结果与版本指纹](../.taie-agent/sql-probe/2026-11-03T10-41-34-442Z-78487fae/result.json)、[逐案例告警与 SQL 观测对照表](../.taie-agent/sql-probe/2026-11-03T10-41-34-442Z-78487fae/matrix.md)。本次已取得可用于下一步的真实缺陷告警与可证伪误报告警；尚不能据此声称模型已经识别它们。

## 第二步：固定证据视图的模型复核

对新的六案例分析结果执行，默认选择 `v2` 七视图套件：

```powershell
npm run test:sql:review -- ".taie-agent/sql-probe/运行ID/result.json" --suite v2
```

对上述首轮历史结果，仅选择原有三视图时须显式指定 `v1`：

```powershell
npm run test:sql:review -- ".taie-agent/sql-probe/2026-11-03T10-41-34-442Z-78487fae/result.json" --suite v1
```

这两个命令复用已有分析证据，不重新运行 Maven 或 Tai-e。需要 `DEEPSEEK_API_KEY`；`v1` 计划发起 3 个请求，`v2` 计划发起 7 个请求，模型均为 `deepseek-v4-flash`。每个请求独立、无工具、无编码历史、无自动重试，使用同次运行固定的复核提示与预算。**suite 只选择视图，不选择历史提示**：当前提示为 version 2，即使选择 `--suite v1`，也不会恢复首轮旧提示。实际提示版本、哈希和完整请求随新结果保存。

下表的目标只用于宿主事后核对，不发送给模型：

| 视图 | 模型可见证据 | 观察目标 |
| --- | --- | --- |
| `A_full` | A 原告警、片段与抽象路径，加快照中的完整 `CaseA.java`、`Main.java` 和 `taint.yml` | 识别并保留真实缺陷。 |
| `B_full` | B 原告警、片段与抽象路径，加快照中的完整 `CaseB.java`、`Main.java` 和 `taint.yml` | 根据完整辅助方法与调用关系提出有依据的疑似误报建议。 |
| `B_recorded_only` | 同一 B 告警的原片段、抽象路径及 `taint.yml`，不提供完整辅助方法和调用者源码 | 关键实现缺失时明确无法判断或证据不完整，而非仅凭方法名或单条路径猜测。 |
| `E_full`（v2 新增） | E 原告警，加完整 CaseE、Main 和策略 | 根据字段状态传播保留真实缺陷。 |
| `E_recorded_only`（v2 新增） | E 原片段、抽象路径及策略，路径保留字段存取线索，缺少完整 helper 和调用者源码 | 保留疑似真告警或明确证据不足；不能把第二次实参是常量当作排除依据。 |
| `F_full`（v2 新增） | F 原告警，加完整 CaseF、Main 和策略 | 根据纯 helper 的实际实现提出疑似误报，不依赖名称。 |
| `F_recorded_only`（v2 新增） | F 原片段、抽象路径及策略，缺少完整 helper 和调用者源码 | 未见实现时明确无法判断，不按 `apply` 名称猜测。 |

完整视图只包含选定案例与入口类，不意味着全部项目和库实现均已提供。输入构造会核对报告关联、快照/源码指纹以及实际文件与策略哈希；原始记录发生变化时结果不能作为有效复核。程序真值保持不变，同一案例的两个视图只改变模型可见证据，不能当作两个独立程序样本。

E 的真实部分视图含 `INSTANCE_STORE → stored → INSTANCE_LOAD → RETURN`，比 B/F 具有更多状态证据。因此在发送模型前，将其目标固定为 `true_positive / unknown / analysis_incomplete`，分别表示保留疑似真告警或弃权；不能把它们合并计为主动弃权成功。该视图仍没有初始化分支条件，任何“必然执行”的论证须另外核对。此次调整、依据及完整预定目标见 [API 前固定记录](../.taie-agent/sql-probe/2026-11-03T11-10-25-586Z-b15c4e0e/review-plan-v2.md)，没有删改原始路径来强行要求未知。

案例标签、独立 SQL 观测、测试源码/断言、上述证明说明和其他告警不进入模型请求。当前插件仅导出一条最短抽象传播路径；否定该路径不能自动排除同一告警的其他可能路径。

复核结果保存到 `.taie-agent/sql-review-probe/<运行ID>/`：根目录保留 `result.json` 和 `matrix.md`，每个视图另存实际请求、输入文件清单及原始响应。原始模型建议与宿主规范化结果分别统计，宿主把建议降为 `unknown` 不能记作模型主动弃权。分类符合预期也不等于理由成立，`rationaleValidation` 初始为 `pending_independent_review`，还需逐条检查判断依据、前提和缺失信息。

原告警、源码及质检状态保持不变；当前工作区仍未核验。

## 第二步首轮结果：尚未达到能力目标

以下保留首轮旧提示、三视图的历史结果，不是 version 2 提示的新验收。2026-11-03 该轮执行 3 次真实 DeepSeek 请求，无重试，共约 18.07 秒，SDK 记录总计 11,271 token（含缓存读取）。两个响应通过协议校验，一个被拒收：

| 视图 | 原始模型建议 | 宿主结果 | 独立代码核对 |
| --- | --- | --- | --- |
| `A_full` | 真缺陷 | 接受建议 | 主链成立，但对未见过的测试内容作了无依据判断。 |
| `B_full` | 疑似误报 | 额外字段导致协议失败 | 纯 helper 与常量返回的核心解释成立，但输出无效，且列出不适用的覆盖关系等证据缺口。 |
| `B_recorded_only` | 疑似误报 | `unknown` | 仍按 `identity` 名称假定实现；模型没有主动弃权，宿主按单路径和缺失证据兜底。 |

这一轮不能算复核能力通过。完整代码帮助产生了正确的核心解释，但还存在协议遵守、无依据附加说法和缺证据时过度推断的问题。第二轮新增 E/F 反例与对照并改进提示，实际结果单独记录，不追溯改写本轮失败。

证据：[可读结果解读](../.taie-agent/sql-review-probe/2026-11-03T10-54-40-266Z-ef9cf25c/interpretation.md)、[完整原始运行记录](../.taie-agent/sql-review-probe/2026-11-03T10-54-40-266Z-ef9cf25c/result.json)。解读中分别列出原始标签、协议结果、宿主降级、独立理由核对和计数限制；全部请求和响应均可查看。原检查仍保留 3 条项目告警，未自动关闭或修复。

## 第二轮：分类目标观察到，解释仍有缺口

2026-11-03 的新六案例运行耗时 216.02 秒，构建及 6 项真实 SQL 测试通过，Tai-e 项目告警为 A/B/C/E/F 各 1 条，D 为 0，依赖为 0。新增 E 的输入确实决定实际 SQL 与返回行，F 则始终执行常量。[分析矩阵与独立观测](../.taie-agent/sql-probe/2026-11-03T11-10-25-586Z-b15c4e0e/matrix.md)

随后使用提示版本 2 执行七次独立请求，共 26.63 秒、SDK 总计 29,216 token（含缓存读取）。所有回复格式有效且分类符合预定目标：A/E 完整视图为 `true_positive`，B/F 完整视图为 `suspected_false_positive`，B/E/F 部分视图为 `analysis_incomplete`。没有重试、宿主降级或误排真告警的建议。

逐条核对发现完整视图的核心代码论证成立，部分视图也确实主动承认关键实现缺失；但 B 部分视图把调用合并误说成记录矛盾，F 部分视图弄错被丢弃的是哪个调用返回值，F 完整视图误称 Main 未提供。分类吻合不能代替解释准确性。原始 `rationaleValidation` 保留脚本运行时的待核对状态，后续核对单独写入 [可读解读与全部交互](../.taie-agent/sql-review-probe/2026-11-03T11-17-31-044Z-44db6a55/interpretation.md)。

本轮保留全部 5 条告警；上轮 8 个原始结果/交互文件及本轮 9 个所读输入的哈希复查未变。宿主相关测试 21 项通过，类型检查通过。下一步冻结提示并换新案例验证，不用这些开发视图估算通用准确率或成本收益。
