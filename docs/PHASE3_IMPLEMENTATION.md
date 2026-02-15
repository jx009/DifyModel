# Phase 3 Implementation Notes (Quality Policy + Output Validation)

## Goal

Implement Phase 3 from execution plan:

- enforce subtype-specific output consistency rules
- wire validation failure into retry policy
- support subtype retry mode (same workflow vs fallback workflow)

## Implemented

## 1) Output validator module

Added `src/core/outputValidator.js`:

- validates workflow result against scenario `output_constraints`
- supports answer modes:
  - `single_option`
  - `multi_option`
  - `number_or_option`
  - `text_or_option`
- checks:
  - answer format by mode
  - minimal evidence count
  - confidence range normalization (0~1)
  - optional output `sub_type` consistency with routed subtype
- writes `debug.output_validation` metadata on valid result

## 2) Inference pipeline validation + retry wiring

Updated `src/core/inferenceEngine.js`:

- imports and executes `validateResultForScenario` after each pass
- publishes progress event `output_validation_failed` on validation failure
- if strict validation enabled and retry policy allows:
  - performs retry instead of returning invalid output
- supports subtype retry policy fields:
  - `retry_mode`: `same_workflow` or `fallback_workflow`
  - `retry_on_validation_fail`: boolean
- supports confidence-based retry using fallback workflow when configured
- retrieval log payload now includes `retry_mode`

## 3) Scenario quality and output constraints

Updated `configs/scenarios/exam_qa.scenario.json`:

- `quality_policy.validation_retry_on_fail` added
- subtype overrides now include retry strategy controls (`retry_mode`, `retry_on_validation_fail`)
- added `output_constraints`:
  - defaults
  - subtype-specific rules for answer mode and evidence minimum

## 4) Template + schema documentation sync

- updated `configs/scenarios/_template.scenario.json`
  - includes `validation_retry_on_fail`
  - includes `output_constraints` skeleton
- updated `docs/SCENARIO_SCHEMA.md`
  - documents `output_constraints` semantics and modes

## Validation

- module load checks passed:
  - `outputValidator`
  - `inferenceEngine`
- scenario JSON parse checks passed
- workflow consistency check passed:
  - `npm run check:workflow`
