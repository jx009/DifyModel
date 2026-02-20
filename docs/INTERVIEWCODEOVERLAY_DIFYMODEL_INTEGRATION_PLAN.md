# InterviewCodeOverlay3333 与 DifyModel 对接稳妥方案

## 1. 总体策略

最稳妥方式是先改 `InterviewCodeOverlay3333/backend`，保持 Electron 与前端接口不变，把 DifyModel 作为下游推理引擎。

- 现有前端与主进程不动（避免大范围回归）
- 后端内部引入 DifyModel 适配层
- 通过配置开关灰度切流，支持快速回滚

---

## 2. 推荐对接路径

1. 在 `backend/src/services/AIProcessingService.ts` 中增加 `DifyModelClient` 调用链：
   - `POST /v1/infer`
   - `GET /v1/infer/stream/:trace_id`
2. `backend/src/routes/ai-processing.ts` 继续输出现有 `requestId/status` 协议，不改前端 `src/hooks/useAIProcessing.ts`。
3. 增加开关：
   - `AI_PROVIDER_MODE=legacy|difymodel`
   - 默认 `legacy`，灰度后切换 `difymodel`。

---

## 3. 改造点清单

## 3.1 协议适配层

- 新建 `backend/src/services/DifyModelClient.ts`
  - 封装请求、超时、重试、错误映射
- 新建 `backend/src/services/DifyStreamBridge.ts`
  - 把 Dify SSE 事件转换为现有 SSE 事件：
    - `processing`
    - `content_update`
    - `completed`
    - `error`

## 3.2 字段映射

- 题型与触发类型映射到 DifyModel（按业务语义对齐）：
  - `question_type=programming` -> `scenario_id=coding_qa`
  - `question_type=single_choice|multiple_choice` -> `scenario_id=choice_qa`
  - `question_type=universal` -> `scenario_id=hybrid_router`（或先落到 `choice_qa`）
- 截图映射为 `input.images`
  - 支持 base64 或 URL
  - 控制图片体积，避免超出 DifyModel `MAX_REQUEST_BYTES`
- 用户模型选择映射为偏好字段：
  - `options.model_preference`
  - `options.model_mode`（`prefer|strict`）

## 3.3 鉴权与租户

- 后端到 DifyModel 使用服务间 Token（`Authorization: Bearer ...`）
- 不透传客户端敏感信息
- 将用户身份映射为 `tenant_id`，兼容 DifyModel 限流与审计

## 3.4 业务一致性

- 积分逻辑仍留在 `AIProcessingService` 外围（先扣减、失败回滚）
- 仅替换模型执行内核，保持计费行为稳定
- 统一错误码映射（如 `INVALID_INPUT`、`UPSTREAM_TIMEOUT` 等）到前端当前可识别结构

## 3.5 可观测与回滚

- 记录 `requestId <-> trace_id` 映射
- 日志与问题记录同时保存两端关键信息
- DifyModel 异常时自动降级 `legacy`，保证可用性

---

## 4. DifyModel 侧最小改动建议

- 可选增加兼容入口（如 `/v1/infer/compat`），减少后端映射复杂度
- 先固定 Admin 配置（routes/workflow keys/prompt），再灰度切流

---

## 5. 业务语义对齐方案（重点）

## 5.1 模型选择对接（InterviewCodeOverlay 可选模型）

- 保留前端“可选模型”交互，不直接把前端模型名绑定到单一底层 provider。
- 由 `InterviewCodeOverlay/backend` 透传模型偏好到 DifyModel：
  - `model_preference`: 用户选择模型标识
  - `model_mode`: `prefer`（推荐默认）或 `strict`
- DifyModel 内做 profile 映射（配置化）：
  - 如：`gpt-4o -> quality_tier=strict/workflow_variant=pro`
  - 如：`gpt-4o-mini -> quality_tier=fast/workflow_variant=lite`
- 结果中返回 `execution_model`，用于计费、审计与争议追溯。

## 5.2 题型选择对接（InterviewCodeOverlay 可选题型）

- 现有约束：上游仅传“图片 + 题型”，缺少结构化上下文。
- 采用“两级路由”：
  1. 一级：按 `question_type` 决定 `scenario_id`（`coding_qa/choice_qa/...`）
  2. 二级：在场景内判定 `sub_type`，走 `sub_type_routes`
- 用户选择题型作为先验，不是最终执行路由；可允许自动修正并在返回中标注。

## 5.3 同题型分配不同 workflow（选择题示例）

- 当用户选择“选择题”：
  - 先进入 `choice_qa`
  - 再判定 `sub_type`：
    - `xingce` -> `wf_choice_xingce`
    - `coding_choice` -> `wf_choice_coding`
    - `common_choice` -> `wf_choice_common`
  - 低置信度走 `fallback_workflow_id`
- 依托 DifyModel 现有 `sub_type_routes + retry + fallback` 机制实现。

## 5.4 仅“图片+题型”场景下的实现原理

- 原理：先用视觉能力做子类型分类，再路由到对应解题 workflow。
- 分类输出最少包含：
  - `sub_type`
  - `confidence`
  - 可选 `reason`
- 如果 `confidence` 低于阈值，直接进入 fallback workflow，保证稳定性。

## 5.5 分类实现方案选择

- 方案A（推荐，本次采用）：
  - 在 DifyModel 代码内新增“图片子类型分类器”（不新增 Dify 分类 workflow）
  - 优点：改动集中、调试简单、上线快
  - 代价：分类逻辑在服务代码侧维护
- 方案B（备选）：
  - 分类也做成独立 Dify workflow
  - 优点：配置化强
  - 代价：链路更长、排障复杂度更高

## 5.6 方案A下 DifyModel 必要改造

- 新增场景配置：
  - `configs/scenarios/choice_qa.scenario.json`
  - `configs/scenarios/coding_qa.scenario.json`
- 扩展子类型分类逻辑（建议在 `src/core/subTypeClassifier.js` 或其现有链路）：
  - 支持纯图片分类 `xingce/coding_choice/common_choice`
- 在场景中配置执行 workflow（注意：执行 workflow 基本需要新增/拆分）：
  - `wf_choice_xingce`
  - `wf_choice_coding`
  - `wf_choice_common`
- 复用现有重试与回退：
  - `quality_policy`
  - `fallback_workflow_id`

---

## 6. 低风险落地顺序

1. 先完成后端适配层与开关，不改前端
2. 先联调非流式，再联调 SSE 桥接
3. 小流量灰度，做 `legacy` 与 `difymodel` 双写对比
4. 稳定后切默认 provider 到 DifyModel
5. 保留快速回滚开关
