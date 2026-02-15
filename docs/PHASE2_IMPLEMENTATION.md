# Phase 2 Implementation Notes (Workflow Build Pack)

## Goal

Start Phase 2 from execution plan:

- prepare subtype workflows as an implementation pack
- standardize prompt templates per subtype
- ensure subtype/workflow/kb consistency is machine-checkable

## Implemented

## 1) Workflow manifest

Added `configs/workflows/exam_qa/workflow-manifest.json`:

- one workflow item per subtype:
  - `figure_reasoning`
  - `xingce`
  - `logic`
  - `language`
  - `data_analysis`
  - `common_knowledge`
- defines:
  - `workflow_id`
  - `fallback_workflow_id`
  - `dataset_ids`
  - `prompt_template_file`
- defines output contract fields:
  - `answer`, `evidence`, `confidence`, `sub_type`

## 2) Prompt template pack

Added prompt templates under `configs/workflows/exam_qa/`:

- `figure_reasoning.prompt.md`
- `xingce.prompt.md`
- `logic.prompt.md`
- `language.prompt.md`
- `data_analysis.prompt.md`
- `common_knowledge.prompt.md`

All templates require consuming runtime `prompt_plan` from DifyModel.

## 3) Workflow build README

Added `configs/workflows/exam_qa/README.md` with:

- how to create workflows in Dify
- how to bind datasets
- required runtime input fields and output JSON contract

## 4) Consistency validator

Added `scripts/validate-workflow-manifest.js` and npm script:

- `npm run check:workflow`

Validation checks:

- manifest workflow ids vs scenario routes
- subtype profile presence
- kb mapping and registry consistency
- prompt template file existence
- output contract field completeness

## Notes

Actual workflow creation/publishing still happens in Dify UI, but this phase now
has a complete repo-side build pack and consistency checks to drive that work.
