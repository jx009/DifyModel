# Admin 工作流配置与测试平台开发方案

## 1. 开发目标

基于当前 DifyModel 项目，在不破坏现有 `/v1/*` 推理链路前提下，新增一个可视化管理与测试平台，实现：

1. workflow 路由配置。
2. workflow key 配置。
3. prompt 与 `prompt_plan/路由信息` 配置。
4. 图片上传与 Dify workflow 在线测试。

## 2. 实施原则

1. 最小侵入：优先新增模块，不大改现有核心推理代码。
2. 可回滚：所有配置变更保留历史版本。
3. 可观测：管理操作与测试调用可审计。
4. 可灰度：功能可通过开关启停。

## 3. 里程碑与步骤

## Phase A：配置覆盖层与运行时集成

### A1. 新增覆盖层存储模块

- 新建模块：`src/core/adminConfigStore.js`
- 功能：
  - 加载 `data/admin/workflow-overrides.json`
  - 校验结构合法性
  - 内存缓存与热加载
  - 写入时原子更新（先写临时文件再替换）
  - 快照归档到 `data/admin/history/`

### A2. 配置合并器

- 新建模块：`src/core/adminConfigResolver.js`
- 功能：
  - 合并 `configs/*`、env、admin override
  - 输出“有效场景配置视图”
  - 输出“有效 Dify key 视图”

### A3. 接入推理链路

- 在 `src/core/inferenceEngine.js` 读取“合并后配置”：
  - `sub_type_routes`
  - `workflow_binding`
  - `sub_type_profiles`
- 在 `src/core/difyConnector.js` 接入 per-workflow key 覆盖读取逻辑。
- 保障读取失败时回退默认配置与 `.env`。

### A4. 基础验证

- 新增单测/集成测试：
  - 覆盖层加载成功/失败
  - 配置合并优先级正确
  - 路由与 `prompt_plan` 生效验证

---

## Phase B：管理 API（后端）

### B1. 管理鉴权与路由骨架

- 新增 `src/core/adminAuth.js`（例如 `ADMIN_TOKEN` 鉴权）。
- 在 `src/server.js` 挂载 `/admin/api/*`。
- 增加开关：`ADMIN_CONSOLE_ENABLED=true/false`。

### B2. 配置读取与更新接口

- 实现接口：
  - `GET /admin/api/config`
  - `PUT /admin/api/routes`
  - `PUT /admin/api/subtypes/:subType/profile`
  - `PUT /admin/api/workflows/:workflowId/prompt`
  - `PUT /admin/api/workflows/:workflowId/key`
- 每个写接口要求：
  - 参数校验
  - 保存前结构校验
  - 生成历史快照
  - 写审计日志

### B3. 测试相关接口

- `POST /admin/api/test/upload`
  - 接收上传文件
  - 代理调用 Dify Files API
  - 返回 `upload_file_id`
- `POST /admin/api/test/run`
  - 接收测试参数（workflow/sub_type/text/images/options）
  - 触发一次测试调用
  - 返回结果与调试信息
- `GET /admin/api/test/stream/:trace_id`（可选）
  - 输出测试过程 SSE 事件

### B4. API 验证

- 编写接口级 smoke：
  - 配置读写
  - key 掩码逻辑
  - prompt 保存/回滚
  - 上传+测试调用

---

## Phase C：前端管理台

### C1. 管理台工程初始化

- 目录建议：`admin-web/`（或 `src/admin-web/`）
- 页面路由：
  - `/admin/workflows`
  - `/admin/strategies`
  - `/admin/test`

### C2. 页面一：Workflow 配置页

- 功能：
  - workflow 列表
  - sub_type 路由编辑
  - fallback 配置
  - 保存/撤销
  - 生效状态提示

### C3. 页面二：Prompt 与 PromptPlan 策略页

- 功能：
  - 子题型配置卡片
  - `classifier_hints` 可视化编辑
  - `workflow_guidance` 三段内容编辑
  - workflow prompt 编辑器
  - 版本历史与回滚

### C4. 页面三：在线测试台

- 功能：
  - 选择 workflow/sub_type（支持强制 sub_type）
  - 上传图片并显示上传状态
  - 发起调用（sync/stream）
  - 展示返回结果、路由命中、trace、耗时、原始 JSON

### C5. 前端验收

- 关键验证：
  - 修改配置后可立即影响测试结果
  - 上传图片成功并完成 Dify 调用
  - key 从不明文展示

---

## Phase D：安全、审计与发布

### D1. 安全加固

- 管理端强制鉴权。
- key 字段写入加密存储（或至少系统级最小权限）。
- 增加接口限流与输入大小限制。

### D2. 审计与日志

- 审计日志建议文件：`data/audit/admin-actions.jsonl`
- 记录字段：
  - actor
  - action
  - target
  - before/after 摘要
  - timestamp
  - trace_id

### D3. 发布与灰度

- 在 dev 先启用 `ADMIN_CONSOLE_ENABLED=true`。
- staging 完成联调后上线 prod。
- 生产建议先只读模式，再放开写权限。

## 4. 任务拆分（建议）

1. 后端配置层与合并器（A1-A3）
2. 管理 API（B1-B3）
3. 前端三页面（C1-C4）
4. 测试与安全加固（B4 + D1 + D2）
5. 灰度发布（D3）

## 5. 预计工期（单人参考）

1. Phase A：1-2 天
2. Phase B：1-2 天
3. Phase C：2-3 天
4. Phase D：1 天

总计：约 5-8 天。

## 6. 验收清单（Go/No-Go）

1. 能在前端修改 `sub_type_routes` 并即时生效。
2. 能在前端修改 `sub_type_profiles` 并影响 `prompt_plan`。
3. 能在前端配置 workflow key 且不泄露明文。
4. 能上传图片并完成 Dify workflow 测试调用。
5. 所有写操作有审计记录，支持回滚。
6. 管理功能关闭时不影响现有 `/v1/*` 正常服务。

