# DifyModel 题型分流 + Dify 知识库提准方案

## 1. 目标与边界

- 目标：通过「按题型走不同 workflow + 题型专属知识库」提升搜题准确率。
- 边界：不新增题库上传 API；题库上传与切分全部使用 Dify Dataset 能力。
- 角色分工：
  - `InterviewCodeOverlay3333`：截图采集、交互展示。
  - `DifyModel`：题型识别、路由、策略、审计、回退。
  - Dify：workflow 编排、知识库检索、模型推理。

---

## 2. 总体架构

统一链路：

1. 客户端调用 `DifyModel /v1/infer`
2. `DifyModel` 做题型识别（含场景画像提示）
3. 按题型路由至对应 Dify workflow
4. workflow 内按题型使用对应 Dataset 检索
5. 输出结构化结果（answer/evidence/confidence）
6. 低置信度触发重试或回退
7. 全链路记录审计与检索计划日志

---

## 3. 题型与工作流规划

建议先固定 6 类题型：

- `figure_reasoning`（图推题）
- `xingce`（行测综合）
- `logic`（逻辑判断）
- `language`（言语理解）
- `data_analysis`（资料分析）
- `common_knowledge`（常识判断）

对应 workflow 命名建议：

- `wf_exam_figure`
- `wf_exam_xingce`
- `wf_exam_logic`
- `wf_exam_language`
- `wf_exam_data`
- `wf_exam_common`

要求所有 workflow 保持统一输出字段：

- `answer`（string）
- `evidence`（array<string>）
- `confidence`（number, 0~1）
- `sub_type`（string）

---

## 4. Dify 知识库分层设计

## 4.1 Dataset 分层

- `kb_exam_global`：通用题库、共性规则、术语定义。
- `kb_exam_figure`：图推规律、图形变换模板、易错点。
- `kb_exam_xingce`：行测综合策略与高频套路。
- `kb_exam_logic`：论证/真假/削弱加强规则。
- `kb_exam_language`：言语理解题型规则与语义陷阱。
- `kb_exam_data_rules`：资料分析公式、速算规则、常见陷阱。
- `kb_exam_common`：常识知识点。

## 4.2 入库规范

- 以“短知识单元”切分：一条知识只讲一个规律/公式/陷阱。
- 元数据建议至少包含：题型、主题、来源、更新时间、版本。
- 明显错误或过时内容不删，标记为失效（便于回溯）。

## 4.3 版本治理

- 每次题库更新同步更新 `kb_version`。
- 在 `DifyModel` 侧保留 KB 注册版本，便于回放定位。

---

## 5. DifyModel 配置落地

## 5.1 场景配置

文件：`configs/scenarios/exam_qa.scenario.json`

- `workflow_binding.sub_type_routes`：维护题型到 workflow 的映射。
- `sub_type_profiles`：为每个题型定义：
  - `classifier_hints`（关键词、图像偏好）
  - `workflow_id`（题型专用 workflow 覆盖）
  - `workflow_guidance`（解题步骤、提示重点、答案约束）

## 5.2 知识库注册表

文件：`configs/kb/KB_REGISTRY.json`

- 为每个 Dify Dataset 注册：
  - `kb_id`
  - `kb_version`
  - `status`（建议仅 `active` 参与线上）
  - `domain/source/tags`

## 5.3 题型到 KB 映射

文件：`configs/kb-mappings/exam_qa.kbmap.json`

- 配置 `sub_type_kb_map`（题型 -> KB 列表）。
- 配置 `default_kb_ids`（兜底 KB）。
- 支持后续按 `env/tenant` 做差异映射。

---

## 6. Dify Workflow 设计模板（每个题型复用）

建议节点顺序：

1. 输入标准化（题干/选项/图像摘要）
2. 题型内子判断（可选）
3. Knowledge Retrieval（绑定题型 Dataset）
4. 推理节点（读取 `prompt_plan`）
5. 结果一致性校验（答案-证据-结论）
6. 结构化 JSON 输出

Prompt 约束建议（每个题型共通）：

- 先给步骤化分析，再给结论。
- 证据必须可追溯（题干信息或检索证据）。
- 严格遵守题型答案约束（单选唯一、多选完整、计算给关键中间量）。

---

## 7. 提准策略（核心）

## 7.1 分题型阈值

- 在 `quality_policy.sub_type_overrides` 设置不同置信度阈值与重试次数。
- 高歧义题型（如图推、资料）可适当提高阈值并允许一次重试。

## 7.2 低置信度重试

- 优先同 workflow 二次推理（换提示角度）。
- 必要时走 fallback workflow。

## 7.3 一致性规则

- 答案必须与 evidence 一致。
- 单选必须唯一选项；多选必须完整列举。
- 计算题必须给关键公式或中间量。

## 7.4 错题闭环

- 利用 `/v1/feedback` 收集错误样本。
- 每周将低分样本回灌：
  - 对应题型 Dataset
  - 对应 workflow 提示词
  - 对应 `classifier_hints`

---

## 8. 评测与灰度发布

## 8.1 评测集

- 每题型建立固定评测集（建议 50~100 题/题型）。
- 覆盖易错边界案例（相似选项、图形干扰、数据陷阱）。

## 8.2 指标

- 准确率（按题型拆分）
- 低置信度率
- 重试率
- P50/P95 时延

## 8.3 发布方式

1. 先上线 `figure_reasoning + xingce`
2. 通过评测后逐步放量其它题型
3. 每次只改一个变量（题库或提示词或路由），便于归因

---

## 9. 运维与排障

重点日志：

- 审计记录：`data/audit/traces.jsonl`
- 检索计划：`data/retrieval/retrieval.jsonl`
- 运行日志：`data/logs/app.log.jsonl`

排障优先级：

1. 题型是否识别正确
2. 路由 workflow 是否匹配题型
3. KB 映射是否命中正确数据集
4. 输出字段是否合规且证据一致

---

## 10. 里程碑建议

## M1（1~2 天）

- 完成题型/workflow/KB ID 统一命名
- 配齐 `exam_qa` 的 `sub_type_profiles` 与 KB 映射

## M2（2~4 天）

- 在 Dify 内完成 6 个题型 workflow 模板
- 打通每个 workflow 的题型专属 Dataset

## M3（3~5 天）

- 跑固定评测集，形成基线报告
- 调整阈值/重试/提示词，稳定后灰度

## M4（持续）

- 每周错题回灌与小步迭代
- 维持版本化与回放可追溯

---

## 11. 成功标准

- 题型路由准确率显著提升，错路由率下降。
- 目标题型（图推、行测）准确率相比当前基线有可量化提升。
- 线上异常可通过 trace + 检索日志快速定位并回滚。

