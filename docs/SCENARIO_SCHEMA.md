# Scenario Schema (Phase 1)

## 1. Purpose
This schema defines how every AI scenario is configured in DifyModel.
The runtime should load scenario definitions from config files and apply them consistently.

---

## 2. Scenario Definition

Each scenario config must include:

- `scenario_id`
- `name`
- `enabled`
- `input_schema`
- `workflow_binding`
- `sub_type_profiles`
- `knowledge_policy`
- `quality_policy`
- `latency_budget`
- `output_schema`
- `output_constraints`
- `version`

---

## 3. Canonical JSON Schema (Draft)

```json
{
  "scenario_id": "exam_qa",
  "name": "Exam Question Answering",
  "enabled": true,
  "version": "1.0.0",
  "input_schema": {
    "required_fields": ["images"],
    "allow_text": true,
    "allow_images": true,
    "allow_attachments": false,
    "max_images": 5,
    "max_text_length": 8000
  },
  "workflow_binding": {
    "provider": "dify",
    "workflow_id": "wf_exam_qa_main",
    "fallback_workflow_id": "wf_exam_qa_fallback",
    "sub_type_routes": {
      "figure_reasoning": "wf_exam_figure",
      "logic": "wf_exam_logic",
      "language": "wf_exam_language",
      "data_analysis": "wf_exam_data",
      "common_knowledge": "wf_exam_common"
    }
  },
  "sub_type_profiles": {
    "figure_reasoning": {
      "display_name": "图推题",
      "workflow_id": "wf_exam_figure",
      "classifier_hints": {
        "keywords": ["图推", "图形推理", "旋转", "对称"],
        "require_images": true,
        "prefer_images": true,
        "image_only_default": true
      },
      "workflow_guidance": {
        "solving_steps": [
          "识别图形元素",
          "建立规律假设",
          "逐项验证并排除"
        ],
        "prompt_focus": ["强调规律验证过程"],
        "answer_constraints": ["答案必须可解释"]
      }
    }
  },
  "knowledge_policy": {
    "enabled": true,
    "mode": "conditional",
    "default_kb_ids": ["kb_exam_global"],
    "sub_type_kb_map": {
      "common_knowledge": ["kb_exam_common"],
      "data_analysis": ["kb_exam_data_rules"]
    },
    "top_k": 5,
    "rerank": true,
    "max_context_chars": 12000
  },
  "quality_policy": {
    "confidence_threshold": 0.72,
    "enable_second_pass": true,
    "validation_retry_on_fail": true,
    "max_retries": 1,
    "strict_output_validation": true,
    "quality_tiers": {
      "fast": {
        "confidence_threshold": 0.68,
        "max_retries": 0
      },
      "balanced": {
        "confidence_threshold": 0.72,
        "max_retries": 1
      },
      "strict": {
        "confidence_threshold": 0.8,
        "max_retries": 2
      }
    }
  },
  "latency_budget": {
    "total_ms": 8000,
    "stage_budget_ms": {
      "routing": 300,
      "retrieval": 1800,
      "reasoning": 4500,
      "postprocess": 800,
      "buffer": 600
    },
    "on_timeout": "return_best_effort"
  },
  "output_schema": {
    "required_fields": [
      "scenario_id",
      "sub_type",
      "answer",
      "evidence",
      "confidence",
      "trace_id"
    ],
    "field_types": {
      "scenario_id": "string",
      "sub_type": "string",
      "answer": "string",
      "evidence": "array<string>",
      "confidence": "number",
      "trace_id": "string",
      "latency_ms": "number",
      "model_path": "array<string>"
    }
  },
  "output_constraints": {
    "defaults": {
      "mode": "text_or_option",
      "min_evidence": 1,
      "require_evidence": true,
      "enforce_sub_type_match": true
    },
    "sub_type_rules": {
      "figure_reasoning": {
        "mode": "single_option",
        "min_evidence": 2
      }
    }
  }
}
```

---

## 4. Field Semantics

### 4.1 `workflow_binding`
- Controls which provider/workflow is used.
- Supports sub-type routing so one scenario can map to multiple workflows.

### 4.2 `knowledge_policy`
- `mode=off`: never use KB
- `mode=always`: always use KB
- `mode=conditional`: enable by scenario sub-type and strategy

### 4.3 `quality_policy`
- Governs re-try and second-pass behavior.
- Supports sub-type specific overrides via `sub_type_overrides` for threshold/retry tuning.
- Must be bounded by latency budget.

### 4.4 `latency_budget`
- Hard upper budget for end-to-end inference.
- `on_timeout` options:
  - `return_best_effort`
  - `fallback_workflow`
  - `error`

### 4.5 `sub_type_profiles`
- 为每个子题型定义独立的分类提示、workflow覆盖和解题过程约束。
- `classifier_hints.keywords` 用于本地启发式分类提准。
- `workflow_guidance` 会透传到工作流输入，便于不同题型使用不同提示词和步骤。

### 4.6 `output_constraints`
- Enforces output consistency by sub-type after workflow returns.
- `mode` supports:
  - `single_option`
  - `multi_option`
  - `number_or_option`
  - `text_or_option`
- `min_evidence` controls minimal evidence items.
- `enforce_sub_type_match` ensures output sub_type aligns with routed sub_type.

---

## 5. Runtime Validation Rules

At load time:
- `scenario_id` must be unique.
- `workflow_binding.provider` must be supported.
- `latency_budget.stage_budget_ms` sum should not exceed `total_ms` by large margin.
- `output_schema.required_fields` must include `trace_id`.

At request time:
- Validate payload against `input_schema`.
- Reject if scenario disabled.
- Enforce quality and latency policy boundaries.

---

## 6. Built-in Scenario IDs (Initial)
- `exam_qa` (first launch scenario)
- `doc_qa` (planned)
- `ops_assistant` (planned)

---

## 7. Change Management
- Every scenario change must bump `version`.
- Keep change log in `configs/scenarios/CHANGELOG.md`.
- Scenario config updates should go through staging and evaluation before prod.
