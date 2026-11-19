# 单方法执行顺序校验

本步在源码编号引用之上增加控制流结构检查：Tai-e 导出一个方法的普通控制流图，模型提交完整节点序列，宿主核对相邻连接并生成语句顺序报告。首个验收案例为 J，尚未接入日常 `/review`。

## 运行

先从历史源码生成补充控制流证据并运行确定性验收，不调用模型：

```powershell
npm run test:cfg -- ".taie-agent/sql-heldout/2026-11-03T11-52-38-347Z-6deaf3f7/result.json"
```

命令核验原报告及源码哈希，在新目录用 `javac --release 17 -g -proc:none` 编译 CaseJ，编译独立导出器，并使用原报告记录且哈希一致的 Tai-e JAR 导出控制流。可通过 `TAIE_JAVA_HOME` 指定 JDK；本次验证使用 Microsoft JDK 17.0.20.1。补充字节码来自同一份源码，新旧字节码的身份分别记录，不称它为历史编译产物。

然后把上一步输出的 `result.json` 传给模型复核：

```powershell
npm run test:cfg:review -- ".taie-agent/control-flow/2026-11-17T07-40-06-913Z-887a5a8f/result.json"
```

第二个命令发起一次真实模型请求，会产生 API 用量；没有重试。模型能看到原告警、源码片段、策略和控制流，不能看到测试序列、验收答案或独立真值标签。日常复核及冻结 v2/v3 保持不变。

## 检查内容

导出器调用真正的 `CFGBuilder`，保留节点编号、IR 语句、源码行号、分支条件、调用签名和控制流边。只对选中的具体应用方法构建普通控制流，不运行 PTA 或修改原告警。

模型提交图编号及 `paths: [{ nodeIds: [...] }]`。每条路径必须：

- 使用本次图中的节点，从入口开始、在出口结束。
- 经过指定的 sink 调用。
- 包含全部中间节点；每对相邻节点之间存在真实控制流边。

程序拒绝错误图编号、未知节点、缺入口/出口/sink、跳步和不存在的连接。证据或实现变化使结果变为 `stale`。报告里的语句、条件、行号和源码由宿主生成，模型不再手写赋值顺序说明。

`connected` 表示上述结构检查通过。条件可满足性、值传播、别名关系和全部路径覆盖仍为 `not_checked`；异常边没有纳入本步。例如，两个互斥条件仍可能在 CFG 中通过连续边连接，单纯连通检查不能认定该路径实际可执行。定向测试明确保留这个区别。

## 案例 J 的验收

真实导出含 18 个节点、18 条边，关键节点如下：

| 节点 | 实际内容 |
| --- | --- |
| s5 | IR 条件 `mode >= 0` |
| s6 → s8 | 负数分支：先写 `slots[0] = value`，再写 `slots[1] = 常量`；两者之间还有常量赋值节点 s7 |
| s11 → s12 | 非负分支：先写 `slots[1] = 常量`，再写 `slots[0] = value` |
| s14 | 共同的 `executeQuery` 调用 |

IR 条件方向与 Java 的 `mode < 0` 相反，因此 `IF_FALSE` 才进入负数分支。常量准备节点也可能先于源码行号较小的调用节点，不能用行号排序替代控制流。

验收结果：

| 提交序列 | 结果 |
| --- | --- |
| 完整负数分支 | connected |
| 完整非负分支 | connected |
| 交换负数分支的两处数组写入 | invalid，4 处缺失连接 |
| 将另一分支的写入拼进负数路径 | invalid，2 处缺失连接 |

确定性探针耗时 **19.08 秒**，不调用模型。随后一次真实 DeepSeek 请求返回上述两条完整正确序列，均通过检查，建议仍为疑似误报；模型流程 **5.00 秒**，SDK 输入 6,641、输出 272，总计 **6,913 token**。没有通过反复请求筛选成功结果。

类型检查通过。新增 6 项定向测试覆盖分支、跳步、错编号、失效、宿主渲染和结构/语义区别；完整宿主测试 **160 通过、1 因符号链接权限跳过、0 失败**。原检查仍保留全部 6 条告警，不自动排除。

## 文件与证据

- [Java 控制流导出器](../java-adapter/AgentControlFlowExporter.java)
- [序列校验与报告](../src/control-flow-review.ts)
- [无模型探针](../scripts/probe-control-flow.ts)、[模型实验入口](../scripts/review-control-flow.ts)、[实验提示](../evaluations/control-flow-v1/system-prompt.txt)
- [定向测试](../tests/control-flow-review.test.ts)
- [实际导出及四个验收用例](../.taie-agent/control-flow/2026-11-17T07-40-06-913Z-887a5a8f/result.json)
- [真实控制流 JSON](../.taie-agent/control-flow/2026-11-17T07-40-06-913Z-887a5a8f/cfg.json)
- [模型生成的中文报告](../.taie-agent/control-flow-review/2026-11-17T07-43-42-558Z-3ca18db3/report.md)
- [完整模型请求](../.taie-agent/control-flow-review/2026-11-17T07-43-42-558Z-3ca18db3/request.json)、[原始回复与校验结果](../.taie-agent/control-flow-review/2026-11-17T07-43-42-558Z-3ca18db3/result.json)
- [独立核验：20 项文件哈希、9 个源码片段和两条模型序列](../.taie-agent/control-flow-review/2026-11-17T07-43-42-558Z-3ca18db3/validation.json)
