# Phase 5 Implementation Notes (Knowledge Governance)

## Goal
Introduce production-friendly knowledge governance primitives:
- KB registry metadata (id/version/status)
- scenario -> KB mapping traceability
- retrieval planning logs for audit and debugging

## Implemented

### 1) KB registry (file-based baseline)
- `configs/kb/KB_REGISTRY.json`
  - holds KB metadata: `kb_id`, `kb_version`, `status`, `source`, `domain`, etc.
- `configs/kb/CHANGELOG.md`

### 1.1) KB mapping overrides (file-based baseline)
- `configs/kb-mappings/*.kbmap.json`
  - scenario -> KB mapping overrides with `env_overrides` and `tenant_overrides`
- `src/core/kbMappingStore.js`
  - loads mappings and resolves effective mapping by `(scenario_id, APP_ENV, tenant_id)`

### 2) Knowledge manager
- `src/core/knowledgeManager.js`
  - loads `configs/kb/KB_REGISTRY.json`
  - exposes `enrichPlan()` to attach versions/source to `knowledge_policy` decisions
  - supports safe parse + hot reload (mtime polling)
  - filters non-`active` KB items by default (configurable)

### 3) Retrieval plan logging (JSONL)
- `src/core/retrievalLogger.js`
  - writes retrieval-plan events to `data/.../retrieval/retrieval.jsonl`
  - includes `trace_id`, `scenario_id`, `sub_type`, `kb_items`, and policy info
  - async stream append + size-based rotation

### 4) Runtime integration
- `src/core/inferenceEngine.js`
  - enriches knowledge plan with KB versions
  - applies KB mapping overrides (env/tenant) before planning
  - logs retrieval plan on each execution pass
- `src/core/examRouter.js`
  - planned `kb_hits` now includes real `kb_version` when available

## Current Limitations
- Registry is file-based (Phase 5 baseline). Postgres-backed governance can be added later.
- This phase logs retrieval plans; it does not implement actual vector retrieval inside this service.
