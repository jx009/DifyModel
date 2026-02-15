# Smoke Test Guide

This document describes the one-click API smoke test for DifyModel.

## Script

- Path: `scripts/smoke-test.sh`
- Purpose: verify core contract endpoints after local start or Docker deployment.

## Covered Endpoints

- `GET /health`
- `POST /v1/infer` (sync)
- `POST /v1/infer` (stream bootstrap)
- `GET /v1/infer/stream/:trace_id` (SSE connected + activity events)
- `POST /v1/feedback`
- `GET /v1/traces/:trace_id`
- `GET /metrics`
- invalid payload check for infer validation (`INVALID_INPUT`)

## Usage

### 1) Local default

```bash
npm run test:smoke
```

### 2) Custom base URL

```bash
BASE_URL=http://127.0.0.1:8091 bash scripts/smoke-test.sh
```

### 3) Auth enabled

```bash
BASE_URL=http://127.0.0.1:8080 \
AUTH_TOKEN=your_token \
TENANT_ID=tenant_a \
bash scripts/smoke-test.sh
```

### 4) Docker deployed service

```bash
BASE_URL=http://127.0.0.1:8080 npm run test:smoke
```

### 5) Force provider expectation

```bash
EXPECT_PROVIDER=mock npm run test:smoke
EXPECT_PROVIDER=dify npm run test:smoke:dify
```

### 6) Metrics policy expectation

```bash
EXPECT_METRICS_ENABLED=true npm run test:smoke
EXPECT_METRICS_ENABLED=false npm run test:smoke
```

## Optional Environment Variables

- `BASE_URL` default: `http://127.0.0.1:8080`
- `TIMEOUT_SECONDS` default: `10`
- `AUTH_TOKEN` default: empty
- `TENANT_ID` default: empty
- `EXPECT_PROVIDER` default: `any` (`any|mock|dify`)
- `EXPECT_METRICS_ENABLED` default: `true` (`true|false`)

## Exit Behavior

- Any failed assertion exits with non-zero status.
- Success exits with code `0`.

## CI/CD Recommendation

Run this script right after service startup in staging/prod canary pipeline.
