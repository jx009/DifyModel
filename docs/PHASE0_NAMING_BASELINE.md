# Phase 0 Naming Baseline

## Scope

This document freezes naming for exam sub-types, Dify workflows, and KB ids.

## Sub-type -> Workflow

- `figure_reasoning` -> `wf_exam_figure`
- `xingce` -> `wf_exam_xingce`
- `logic` -> `wf_exam_logic`
- `language` -> `wf_exam_language`
- `data_analysis` -> `wf_exam_data`
- `common_knowledge` -> `wf_exam_common`

## KB Naming

- `kb_exam_global`
- `kb_exam_figure`
- `kb_exam_xingce`
- `kb_exam_logic`
- `kb_exam_language`
- `kb_exam_data_rules`
- `kb_exam_common`

## Unified Workflow Output Contract

All exam workflows must return:

- `answer` (string)
- `evidence` (array<string>)
- `confidence` (number, 0~1)
- `sub_type` (string)

## Notes

- New exam sub-types must append here first, then update scenario and kb mappings.
- Workflow ids and kb ids should never be changed in-place in production; use versioned replacement.
