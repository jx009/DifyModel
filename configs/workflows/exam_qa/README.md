# exam_qa Workflow Pack

This folder is the build pack for Phase 2 workflow implementation in Dify.

## Files

- `workflow-manifest.json`: subtype/workflow/dataset/output contract manifest
- `*.prompt.md`: per-subtype prompt templates for Dify LLM nodes

## How to use in Dify

1. Create one workflow per `workflow-manifest.json -> workflows[*]`.
2. Bind retrieval node datasets from `dataset_ids`.
3. Paste corresponding `prompt_template_file` into main reasoning node.
4. Ensure output is valid JSON with fields:
   - `answer`
   - `evidence`
   - `confidence`
   - `sub_type`
5. Publish workflow and verify `workflow_id` matches scenario config.

## Runtime input fields from DifyModel

- `sub_type`
- `sub_type_profile`
- `prompt_plan`
- `kb_plan`
- `input`
- `context`

Workflows should consume `prompt_plan.solving_steps/prompt_focus/answer_constraints`.
