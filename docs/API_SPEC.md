# API Specification (Phase 1)

## 1. Versioning
- Base path: `/v1`
- Current contract version: `v1`
- Backward-incompatible changes must be introduced through new version path (for example `/v2`).

## 2. Common Protocol

### 2.1 Headers
- `Content-Type: application/json`
- `X-Trace-Id` (optional): client-provided trace id; server generates if absent.
- `Authorization` (optional in dev, required in prod): `Bearer <token>`

### 2.2 Common Response Envelope
All responses use a uniform envelope:

```json
{
  "success": true,
  "trace_id": "trc_01J...",
  "timestamp": "2026-02-15T16:00:00.000Z",
  "data": {}
}
```

Error envelope:

```json
{
  "success": false,
  "trace_id": "trc_01J...",
  "timestamp": "2026-02-15T16:00:00.000Z",
  "error": {
    "code": "INVALID_INPUT",
    "message": "input.text is required",
    "details": {}
  }
}
```

### 2.3 Standard Error Codes
- `INVALID_INPUT`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `RATE_LIMITED`
- `SCENARIO_NOT_FOUND`
- `WORKFLOW_NOT_FOUND`
- `UPSTREAM_TIMEOUT`
- `UPSTREAM_ERROR`
- `INTERNAL_ERROR`

---

## 3. Endpoint: POST `/v1/infer`

### 3.1 Purpose
Unified entry for all inference scenarios.

### 3.2 Request Body
```json
{
  "scenario_id": "exam_qa",
  "input": {
    "text": "",
    "images": ["base64-or-url"],
    "attachments": []
  },
  "context": {
    "user_id": "u_123",
    "tenant_id": "t_001",
    "locale": "zh-CN",
    "client": {
      "name": "interview-overlay",
      "version": "2026.02.15"
    }
  },
  "options": {
    "stream": true,
    "latency_budget_ms": 8000,
    "quality_tier": "balanced",
    "response_format": "json"
  }
}
```

### 3.3 Field Rules
- `scenario_id` required, string.
- `input` required; each scenario validates against its own `input_schema`.
- `options.stream` default `false`.
- `options.quality_tier` enum: `fast` | `balanced` | `strict`.

### 3.4 Success Response (non-stream)
```json
{
  "success": true,
  "trace_id": "trc_01J...",
  "timestamp": "2026-02-15T16:00:00.000Z",
  "data": {
    "trace_id": "trc_01J...",
    "scenario_id": "exam_qa",
    "sub_type": "logic",
    "status": "completed",
    "result": {
      "answer": "B",
      "evidence": ["..."],
      "confidence": 0.82
    },
    "metrics": {
      "latency_ms": 3210,
      "token_in": 1200,
      "token_out": 240,
      "cost": 0.012
    },
    "debug": {
      "model_path": ["router:model-x", "solver:model-y"],
      "kb_hits": [
        { "kb_id": "kb_exam", "kb_version": "2026-02-14", "chunk_id": "c_001", "score": 0.81 }
      ]
    }
  }
}
```

### 3.5 Async/Stream Bootstrap Response
If `options.stream=true`, server may return quickly with stream locator:

```json
{
  "success": true,
  "trace_id": "trc_01J...",
  "timestamp": "2026-02-15T16:00:00.000Z",
  "data": {
    "trace_id": "trc_01J...",
    "status": "processing",
    "stream_url": "/v1/infer/stream/trc_01J..."
  }
}
```

---

## 4. Endpoint: GET `/v1/infer/stream/:trace_id`

### 4.1 Purpose
Server-Sent Events stream for progressive updates.

### 4.2 Content Type
`text/event-stream`

### 4.3 Event Types
- `connected`
- `progress`
- `partial_result`
- `completed`
- `error`

### 4.4 SSE Message Examples
```text
event: connected
data: {"trace_id":"trc_01J...","status":"connected"}
```

```text
event: progress
data: {"trace_id":"trc_01J...","stage":"kb_retrieval","progress":45,"message":"retrieving references"}
```

```text
event: completed
data: {"trace_id":"trc_01J...","result":{"answer":"B","confidence":0.82}}
```

---

## 5. Endpoint: POST `/v1/feedback`

### 5.1 Purpose
Collect user feedback for quality loop and evaluation.

### 5.2 Request Body
```json
{
  "trace_id": "trc_01J...",
  "scenario_id": "exam_qa",
  "feedback": {
    "label": "correct",
    "score": 5,
    "comment": "answer is accurate"
  },
  "operator": {
    "user_id": "u_123",
    "tenant_id": "t_001"
  }
}
```

### 5.3 Feedback Labels
- `correct`
- `partially_correct`
- `incorrect`
- `irrelevant`

### 5.4 Success Response
```json
{
  "success": true,
  "trace_id": "trc_01J...",
  "timestamp": "2026-02-15T16:00:00.000Z",
  "data": {
    "accepted": true
  }
}
```

---

## 6. Compatibility Rules
- Unknown fields in request should be ignored unless blocked by strict mode.
- New optional response fields are backward-compatible.
- Required-field changes require new API version.

## 7. Security Notes
- Do not include raw secrets in payloads.
- Mask sensitive content in logs.
- Enforce authorization in staging/prod.

---

## 8. Endpoint: GET `/v1/traces/:trace_id`

### 8.1 Purpose
Query persisted trace/audit record for replay and troubleshooting.

### 8.2 Success Response
```json
{
  "success": true,
  "trace_id": "trc_01J...",
  "timestamp": "2026-02-15T16:00:00.000Z",
  "data": {
    "trace": {
      "trace_id": "trc_01J...",
      "scenario_id": "exam_qa",
      "status": "completed"
    }
  }
}
```

---

## 9. Endpoint: GET `/metrics`

### 9.1 Purpose
Expose runtime counters and latency snapshot for ops visibility.

### 9.2 Success Response
```json
{
  "success": true,
  "trace_id": "trc_01J...",
  "timestamp": "2026-02-15T16:00:00.000Z",
  "data": {
    "counters": {
      "requests_total": 100,
      "infer_total": 70
    },
    "latency": {
      "infer_p50_ms": 420,
      "infer_p95_ms": 1200,
      "infer_p99_ms": 1800
    }
  }
}
```
