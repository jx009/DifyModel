# DifyModel 开发执行清单（题型分流 + Dify知识库提准）

## 1. 目标

- 将搜题链路升级为“按题型走不同 workflow + 题型专属知识库”。
- 在不新增上传 API 的前提下，直接使用 Dify Dataset 完成知识增强。
- 形成可持续迭代的评测与回灌机制。

---

## 2. 开发阶段与步骤

## Phase 0：冻结口径与命名（Day 1）

### Step 0.1 定义题型清单与命名
- 确认题型：`figure_reasoning`、`xingce`、`logic`、`language`、`data_analysis`、`common_knowledge`。
- 确认 workflow 命名：`wf_exam_figure`、`wf_exam_xingce`、`wf_exam_logic`、`wf_exam_language`、`wf_exam_data`、`wf_exam_common`。
- 确认 KB 命名：`kb_exam_*`。

### Step 0.2 冻结统一输出结构
- 输出字段统一：`answer`、`evidence[]`、`confidence`、`sub_type`。
- 所有 workflow 保持相同字段名与类型。

### 验收
- 出一份“命名对照表”，后续配置与 workflow 全部按此执行。

---

## Phase 1：配置与路由打通（Day 1~2）

### Step 1.1 场景配置完善
- 更新 `configs/scenarios/exam_qa.scenario.json`：
  - `workflow_binding.sub_type_routes`
  - `sub_type_profiles`（每题型的 classifier_hints + workflow_guidance）
  - `quality_policy.sub_type_overrides`

### Step 1.2 KB 注册与映射
- 更新 `configs/kb/KB_REGISTRY.json`（注册所有 Dify Dataset）。
- 更新 `configs/kb-mappings/exam_qa.kbmap.json`（题型 -> KB 映射）。

### Step 1.3 路由参数透传检查
- 确认 `DifyModel` 透传到 Dify 的输入包含：
  - `sub_type`
  - `sub_type_profile`
  - `prompt_plan`
  - `kb_plan`

### 验收
- 通过 `/health` 可看到场景加载正常。
- 发起 `/v1/infer` 后，trace 里可看到正确的 route/kb 信息。

---

## Phase 2：Dify 工作流实现（Day 2~4）

### Step 2.1 创建 6 个题型 workflow
- 每个 workflow 使用统一节点模板：
  1) 输入标准化
  2) 知识检索（题型对应 Dataset）
  3) 推理
  4) 一致性检查
  5) 结构化输出

### Step 2.2 接入题型专属提示词
- 每个 workflow 读取 `prompt_plan`：
  - `solving_steps`
  - `prompt_focus`
  - `answer_constraints`
- 统一要求：先过程后结论，结论可追溯证据。

### Step 2.3 配置 fallback workflow
- 为关键题型配置备用流程，避免主流程异常导致降级到 mock。

### 验收
- 六个 workflow 都可单独跑通并返回标准字段。
- 在 DifyModel 侧按题型能路由到对应 workflow。

---

## Phase 3：质量策略与提准（Day 4~5）

### Step 3.1 置信度与重试策略
- 调整 `quality_policy.sub_type_overrides`：
  - 图推/资料分析阈值更高
  - 行测综合允许有限重试

### Step 3.2 一致性规则落地
- workflow 内增加规则：
  - 单选唯一
  - 多选完整
  - 计算题含关键中间量
  - answer 与 evidence 一致

### Step 3.3 低置信度二次处理
- 低于阈值触发二次推理（同流程不同提示角度）或 fallback workflow。

### 验收
- 错误样本复测中，明显减少“答非所问/证据不匹配”。

---

## Phase 4：评测与灰度（Day 5~7）

### Step 4.1 构建评测集
- 每题型 50~100 题，优先覆盖高频和易错场景。
- 评测集固定版本，支持回放。

### Step 4.2 跑基线对比
- 记录指标：
  - 准确率（按题型）
  - 低置信度率
  - 重试率
  - P95 时延

### Step 4.3 灰度策略
- 先灰度 `figure_reasoning + xingce`。
- 稳定后逐步放量其余题型。

### 验收
- 关键题型准确率较基线有量化提升，且时延在预算内。

---

## Phase 5：持续迭代机制（Week 2+）

### Step 5.1 错题回灌
- 使用 `/v1/feedback` 收集低分样本。
- 每周回灌到：
  - 对应 Dataset
  - 对应 workflow 提示词
  - 对应 `classifier_hints`

### Step 5.2 版本治理
- 每次变更都更新版本：
  - scenario version
  - kb_version
  - workflow 发布记录

### Step 5.3 运营看板
- 以题型维度看趋势：准确率、低置信度、重试、时延。

### 验收
- 形成“周迭代 -> 周评测 -> 周发布”的稳定节奏。

---

## 3. 每日执行模板（建议）

## Day N 开始前
- 明确当天唯一目标（只改一类变量：题库/提示词/阈值）。

## Day N 开发中
- 完成配置或 workflow 变更。
- 用固定样本做小规模回放验证。

## Day N 结束前
- 记录结果与问题。
- 更新变更日志与版本号。

---

## 4. 任务看板（可直接复制到项目管理工具）

- [ ] 完成题型/workflow/KB 命名冻结
- [ ] 完成 `exam_qa` 场景配置增强
- [ ] 完成 KB 注册表与映射配置
- [ ] 完成 6 个题型 workflow 实现
- [ ] 完成 prompt_plan 在 workflow 中的消费
- [ ] 完成一致性规则节点
- [ ] 完成低置信度二次策略
- [ ] 完成评测集与基线报告
- [ ] 完成第一阶段灰度发布
- [ ] 完成反馈回灌机制与周迭代流程

---

## 5. 风险与应对

- 风险：题型识别不准导致错路由  
  应对：优先扩充 `classifier_hints`，并增加题型特征样本。

- 风险：知识库命中不足导致“有流程无提准”  
  应对：按错题反推缺失知识点，优先补短知识单元。

- 风险：提准后时延超预算  
  应对：限制检索 top_k、减少重试次数、分题型设置预算。

- 风险：频繁改动无法归因  
  应对：一次只改一个维度，严格保留版本与评测记录。

