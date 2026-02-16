# DifyModel

Production-oriented AI orchestration platform.

## Current Stage

This repository has completed:
- **Phase 0**: Project baseline and engineering standards
- **Phase 1**: Unified API contract and scenario schema definition
- **Phase 2**: Runtime skeleton (Gateway + Router + Policy + SSE)
- **Phase 3**: Dify connector integration with provider routing and fallback
- **Phase 4**: Scenario routing and quality policy execution
- **Phase 5**: Knowledge governance baseline (registry + plan logging)

## Core Documents

- Architecture plan: `ARCHITECTURE_PLAN.md`
- Development plan: `DEVELOPMENT_PLAN.md`
- API contract (v1): `docs/API_SPEC.md`
- Scenario schema: `docs/SCENARIO_SCHEMA.md`
- Phase 2 notes: `docs/PHASE2_IMPLEMENTATION.md`
- Phase 3 notes: `docs/PHASE3_IMPLEMENTATION.md`
- Phase 4 notes: `docs/PHASE4_IMPLEMENTATION.md`
- Phase 5 notes: `docs/PHASE5_IMPLEMENTATION.md`

## Config Baseline

- Environment template: `configs/environments/.env.example`
- Scenario template: `configs/scenarios/_template.scenario.json`
- First scenario baseline: `configs/scenarios/exam_qa.scenario.json`

## Repository Structure

- `docs/` architecture, API, and development standards
- `configs/` environment and scenario/policy templates
- `src/` runtime source code
- `tests/` automated tests
- `ops/` operations and runbook docs

## Quick Start

1. Copy env template:
   - `cp configs/environments/.env.example .env`
2. Run service:
   - `npm run dev`
3. Verify:
   - `GET http://localhost:8080/health`

Note: you can override bind address via `HOST` (default: `127.0.0.1` in dev, `0.0.0.0` in prod).

## Docker Deployment

- Build image locally:
  - `docker build -t dify-model:local .`
- Run with Docker:
  - `docker run --rm -p 8080:8080 --env-file .env dify-model:local`
- Compose deployment:
  - `docker compose up -d`
- Deployment guide:
  - `DOCKER_DEPLOY.md`

## GitHub Actions (Auto Build + Push)

- Workflow file: `.github/workflows/docker-build-push.yml`
- Trigger:
  - Push to `main`/`master`
  - Push `v*` tags
  - Manual workflow dispatch
- Required repository secrets:
  - `DOCKER_USERNAME`
  - `DOCKER_PASSWORD`

## Smoke Test

- Script: `scripts/smoke-test.sh`
- Doc: `docs/SMOKE_TEST.md`

Quick run:
- `npm run test:smoke`
- `BASE_URL=http://127.0.0.1:8080 npm run test:smoke`

## Notes

- Dify integration is available in Phase 3 and can fallback to mock when configured.
- Dify true-stream bridging is still pending; current flow is event-driven SSE.
