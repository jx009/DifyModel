# Phase 4 Implementation Notes

## Goal
Complete the first production-ready `exam_qa` scenario layer:
- sub-type routing
- knowledge plan decision
- quality policy enforcement (retry/threshold)
- model-assisted subtype classifier (optional)

---

## Implemented

### 1) Exam sub-type routing
- Module: `src/core/examRouter.js`
- Capabilities:
  - heuristic detection with confidence and source
  - image-first fallback when `input.text` is absent (common for `exam_qa`)
  - resolve workflow id from `workflow_binding.sub_type_routes`
  - resolve knowledge plan from `knowledge_policy`
  - produce planned `kb_hits` placeholders for observability

### 2) Pluggable subtype classifier
- Module: `src/core/subTypeClassifier.js`
- Modes:
  - `EXAM_SUBTYPE_CLASSIFIER_MODE=heuristic` (default)
  - `EXAM_SUBTYPE_CLASSIFIER_MODE=dify` (optional)
- Classification caching:
  - default behavior caches the first classification across retries
  - enable `EXAM_RECLASSIFY_ON_RETRY=true` only if you explicitly want re-classification per pass
- Dify classifier env:
  - `DIFY_SUBTYPE_CLASSIFIER_API_KEY` (fallback to `DIFY_API_KEY`)
  - `DIFY_SUBTYPE_TIMEOUT_MS`

### 3) Quality policy enforcement
- Module: `src/core/inferenceEngine.js`
- Added:
  - subtype-aware `sub_type_overrides` support in scenario config
  - classifier-confidence aware retry adjustments
  - best-result tracking across retries
  - latency budget guard: stops retries when remaining budget is low and returns best-effort

### 4) Knowledge plan observability
- Mock path: `src/core/inferenceRunner.js` adds `debug.kb_hits` from knowledge plan.
- Dify path: `src/core/difyConnector.js` falls back to planned `kb_hits` when upstream doesn't provide them.
  - fallback workflow support: if `workflow_binding.fallback_workflow_id` exists, try it before mock fallback

### 5) Scenario config enhancement
- File: `configs/scenarios/exam_qa.scenario.json`
- Added: `quality_policy.sub_type_overrides`

### 6) Smoke test upgrades (continuous)
- Script: `scripts/smoke-test.sh`
- Added assertion:
  - infer(sync) response contains route metadata (`"route"`)

---

## What Is Still Out-of-Scope
- true KB retrieval + reranking inside this service (currently only plan/metadata)
- Dify true streaming bridge (platform SSE remains event-driven)
- full evaluation harness (Phase 6)

---

## Operational Notes
- Phase 4 changes are backward-compatible with Phase 3 contract.
- If Dify classifier is not configured or fails, system falls back to heuristic classifier.
