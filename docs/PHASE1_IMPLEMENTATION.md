# Phase 1 Implementation Notes (Config + Routing Wiring)

## Goal

Complete Phase 1 from execution plan:

- scenario config finalized for subtype routing
- KB registry and subtype mapping aligned
- routing context passthrough visible in runtime logs

## Implemented

## 1) Scenario knowledge mapping expanded

Updated `configs/scenarios/exam_qa.scenario.json`:

- `knowledge_policy.sub_type_kb_map` now covers:
  - `figure_reasoning` -> `kb_exam_figure`
  - `xingce` -> `kb_exam_xingce`
  - `logic` -> `kb_exam_logic`
  - `language` -> `kb_exam_language`
  - `data_analysis` -> `kb_exam_data_rules`
  - `common_knowledge` -> `kb_exam_common`

## 2) KB registry aligned to Phase 0 naming baseline

Updated `configs/kb/KB_REGISTRY.json`:

- ensured the new subtype KB entries are present and active:
  - `kb_exam_figure`
  - `kb_exam_xingce`
  - `kb_exam_logic`
  - `kb_exam_language`

## 3) Effective KB mapping (base + staging) expanded

Updated `configs/kb-mappings/exam_qa.kbmap.json`:

- added subtype mappings for:
  - `figure_reasoning`
  - `xingce`
  - `logic`
  - `language`
- kept existing mappings for:
  - `data_analysis`
  - `common_knowledge`

## 4) Routing context passthrough observability

Updated `src/core/inferenceEngine.js` retrieval-plan logging payload:

- includes `sub_type_profile`
- includes `prompt_plan`

This makes subtype-specific workflow guidance visible in
`data/retrieval/retrieval.jsonl` for runtime verification.

## Validation

- JSON parse check passed for updated config files.
- Node require smoke check passed for core modules (no syntax/runtime load errors).

## Next

Proceed to Phase 2:

- implement and publish all subtype workflows in Dify
- wire each workflow to its dedicated Dify datasets
- consume `prompt_plan` in workflow prompts/nodes
