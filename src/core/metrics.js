class MetricsStore {
  constructor() {
    this.counters = {
      requests_total: 0,
      infer_total: 0,
      infer_success_total: 0,
      infer_failed_total: 0,
      feedback_total: 0,
      stream_connections_total: 0,
      stream_active_connections: 0,
      auth_fail_total: 0,
      rate_limited_total: 0
    }
    this.latency = {
      infer_ms: []
    }
  }

  inc(name, value = 1) {
    if (!Object.prototype.hasOwnProperty.call(this.counters, name)) {
      this.counters[name] = 0
    }
    this.counters[name] += value
  }

  observeLatency(name, ms) {
    if (!this.latency[name]) {
      this.latency[name] = []
    }
    this.latency[name].push(ms)
    if (this.latency[name].length > 5000) {
      this.latency[name].splice(0, this.latency[name].length - 5000)
    }
  }

  percentile(arr, p) {
    if (!arr.length) return 0
    const sorted = [...arr].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    return sorted[index]
  }

  snapshot() {
    const inferLatency = this.latency.infer_ms || []
    return {
      counters: { ...this.counters },
      latency: {
        infer_p50_ms: this.percentile(inferLatency, 50),
        infer_p95_ms: this.percentile(inferLatency, 95),
        infer_p99_ms: this.percentile(inferLatency, 99)
      }
    }
  }
}

module.exports = {
  MetricsStore
}
