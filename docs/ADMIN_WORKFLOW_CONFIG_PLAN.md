# Admin 工作流配置与测试平台方案

## 1. 背景与目标

当前项目已具备后端推理链路与 Dify 对接能力，但 workflow key、路由策略、prompt/prompt_plan 仍主要依赖配置文件与环境变量。为降低调试和迭代成本，建设一个内置管理 Web 平台（`/admin`），实现可视化配置和低成本测试。

核心目标：

1. 可视化配置 workflow 与路由关系。
2. 可视化配置 workflow key 与 prompt。
3. 可视化配置 `prompt_plan/路由信息`（即 `sub_type_profiles`）。
4. 支持上传图片并调用 Dify workflow，在线查看结果。
5. 支持配置热生效、审计、回滚。

## 2. 现状分析

项目中当前相关事实：

- 场景配置：`configs/scenarios/exam_qa.scenario.json`
- prompt 模板：`configs/workflows/exam_qa/*.prompt.md`
- workflow 清单：`configs/workflows/exam_qa/workflow-manifest.json`
- 路由与 prompt_plan 构建：`src/core/examRouter.js`
- 推理执行主链路：`src/core/inferenceEngine.js`
- Dify 调用：`src/core/difyConnector.js`

说明：

- prompt 并非纯硬编码在 JS 中，主要在配置文件与 Dify 工作流中。
- key 当前主要来自环境变量，不支持前端配置。
- 现有系统缺少可视化配置、版本管理和在线验证能力。

## 3. 方案总览

采用“配置覆盖层 + 管理 API + 管理 Web + 测试台”的最小侵入方案：

1. 新增 `/admin` 前端页面（由当前 Node 服务托管静态文件）。
2. 新增 `/admin/api/*` 管理接口。
3. 新增覆盖配置持久化文件：`data/admin/workflow-overrides.json`。
4. 运行时按优先级合并配置：`override > env > configs 默认`。
5. 测试台经后端代理调用 Dify，避免 key 泄露与 CORS 问题。

## 4. 功能范围

### 4.1 工作流配置（Workflow）

- 展示 8 个子题型及其当前 workflow 映射关系。
- 可编辑：
  - `sub_type_routes`
  - `workflow_id`
  - `fallback_workflow_id`
  - 启用状态（可选）
  - 备注（可选）
- 保存后热生效。

### 4.2 Key 与 Prompt 配置

- 每个 workflow 配置独立 API Key。
- key 页面仅掩码展示，不回显明文。
- 每个 workflow 可配置 prompt 文本。
- 支持 prompt 版本号和回滚。

### 4.3 PromptPlan / 路由信息配置（重点）

前端可配置 `sub_type_profiles`，包含：

- `display_name`
- `classifier_hints`
  - `keywords`
  - `require_images`
  - `prefer_images`
  - `image_only_default`
- `workflow_guidance`
  - `solving_steps`
  - `prompt_focus`
  - `answer_constraints`

以上配置保存后，直接影响：

- 子类型识别策略
- 路由 workflow 选择
- 推理中输出的 `prompt_plan`

### 4.4 在线测试台

- 选择 workflow/sub_type，支持强制 sub_type。
- 输入 text/options（stream、quality_tier、latency budget）。
- 上传图片（经后端上传至 Dify Files API，获得 `upload_file_id`）。
- 发起调用并展示：
  - 原始响应 JSON
  - answer/evidence/confidence
  - trace_id、耗时
  - route/prompt_plan/workflow 命中信息
  - SSE 事件流（可选）

## 5. 数据与配置设计

## 5.1 覆盖配置文件

建议路径：`data/admin/workflow-overrides.json`

建议结构（示意）：

```json
{
  "version": "1.0.0",
  "updated_at": "2026-02-16T00:00:00.000Z",
  "updated_by": "admin",
  "routes": {
    "main_workflow_id": "wf_exam_qa_main",
    "fallback_workflow_id": "wf_exam_qa_fallback",
    "sub_type_routes": {
      "figure_reasoning": "wf_exam_figure"
    }
  },
  "sub_type_profiles": {
    "figure_reasoning": {
      "display_name": "图推题",
      "classifier_hints": {
        "keywords": ["图推", "旋转"],
        "require_images": true,
        "prefer_images": true,
        "image_only_default": true
      },
      "workflow_guidance": {
        "solving_steps": ["..."],
        "prompt_focus": ["..."],
        "answer_constraints": ["..."]
      }
    }
  },
  "workflow_keys": {
    "wf_exam_figure": {
      "masked": "sk-***abcd",
      "encrypted": "<ciphertext>"
    }
  },
  "workflow_prompts": {
    "wf_exam_figure": {
      "version": 3,
      "content": "..."
    }
  }
}
```

## 5.2 生效优先级

1. Admin 覆盖配置（`data/admin`）
2. 环境变量（`.env`）
3. 默认配置（`configs/*`）

## 5.3 回滚策略

- 每次变更生成快照（如 `data/admin/history/<timestamp>.json`）。
- 支持按版本回滚并热生效。

## 6. 后端接口规划

- `GET /admin/api/config`
  - 返回“合并后有效配置”（敏感字段掩码）。
- `PUT /admin/api/routes`
  - 更新路由：`workflow_id/fallback/sub_type_routes`。
- `PUT /admin/api/subtypes/:subType/profile`
  - 更新 `sub_type_profiles`。
- `PUT /admin/api/workflows/:workflowId/key`
  - 更新 workflow key（不回传明文）。
- `PUT /admin/api/workflows/:workflowId/prompt`
  - 更新 workflow prompt，带版本号。
- `POST /admin/api/test/upload`
  - 上传图片到 Dify Files API，返回 `upload_file_id`。
- `POST /admin/api/test/run`
  - 触发一次测试调用（支持 sync/stream）。
- `GET /admin/api/test/stream/:trace_id`
  - SSE 流式查看测试进度（可复用现有 stream 机制）。

## 7. 安全与审计

必须项：

1. 管理端鉴权（独立 Admin Token，后续可升级账号体系）。
2. key 不明文回显、不写普通业务日志。
3. key 存储加密或最少文件权限隔离。
4. 所有管理操作落审计日志：
   - 操作者
   - 时间
   - 变更对象
   - 变更摘要
   - trace_id
5. 测试接口限流，防止成本失控。

## 8. 兼容性与风险控制

- 不改动对外主业务接口（`/v1/*`）协议。
- 管理能力通过 `/admin/*` 独立扩展。
- 覆盖层读取失败时回退默认配置，避免服务不可用。
- 可通过环境变量开关 `ADMIN_CONSOLE_ENABLED` 实现灰度。

## 9. 验收标准

1. 前端修改 `sub_type_routes` 后，下一次推理命中新 workflow。
2. 前端修改 `sub_type_profiles.workflow_guidance` 后，返回 `prompt_plan` 同步变化。
3. 前端修改 key 后，目标 workflow 调用成功且不泄露明文。
4. 测试台可完成“上传图片 -> 调用 Dify -> 返回结果”全链路。
5. 配置变更可审计、可回滚，服务无需重启即可生效。

