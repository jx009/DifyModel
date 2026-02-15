class StreamManager {
  constructor(options = {}) {
    this.clients = new Map()
    this.latestByTrace = new Map()
    this.heartbeatMs = Number(options.heartbeatMs || 15_000)
    this.clientTtlMs = Number(options.clientTtlMs || 120_000)
    this.maxConnections = Number(options.maxConnections || 2000)
    this.totalConnections = 0

    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleClients()
    }, Math.min(this.heartbeatMs, 10_000))
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref()
    }
  }

  canAcceptConnection() {
    return this.totalConnections < this.maxConnections
  }

  addClient(traceId, req, res) {
    if (this.totalConnections >= this.maxConnections) {
      return { ok: false, code: 'STREAM_CAPACITY_REACHED' }
    }

    const client = {
      req,
      res,
      connectedAt: Date.now(),
      lastActivityAt: Date.now(),
      heartbeat: null
    }

    if (!this.clients.has(traceId)) {
      this.clients.set(traceId, new Set())
    }
    this.clients.get(traceId).add(client)
    this.totalConnections += 1

    client.heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        this.removeClient(traceId, client)
        return
      }
      this.sendEvent(res, 'heartbeat', { trace_id: traceId, ts: Date.now() })
    }, this.heartbeatMs)

    if (typeof client.heartbeat.unref === 'function') {
      client.heartbeat.unref()
    }

    const latest = this.latestByTrace.get(traceId)
    if (latest) {
      this.sendEvent(res, latest.event, latest.data)
    }

    return { ok: true }
  }

  removeClient(traceId, client) {
    const group = this.clients.get(traceId)
    if (!group) return

    if (client.heartbeat) {
      clearInterval(client.heartbeat)
    }

    group.delete(client)
    this.totalConnections = Math.max(0, this.totalConnections - 1)

    if (group.size === 0) {
      this.clients.delete(traceId)
    }
  }

  publish(traceId, event, data) {
    this.latestByTrace.set(traceId, { event, data })
    const group = this.clients.get(traceId)
    if (!group) return

    for (const client of group) {
      client.lastActivityAt = Date.now()
      this.sendEvent(client.res, event, data)
      if (event === 'completed' || event === 'error') {
        try {
          client.res.end()
        } catch (_error) {
          // ignore
        }
        this.removeClient(traceId, client)
      }
    }
  }

  sendEvent(res, event, data) {
    if (res.writableEnded || res.destroyed) return
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  cleanupStaleClients() {
    const now = Date.now()
    for (const [traceId, group] of this.clients.entries()) {
      for (const client of group) {
        const idleFor = now - client.lastActivityAt
        const aliveFor = now - client.connectedAt
        if (idleFor > this.clientTtlMs || aliveFor > this.clientTtlMs * 2) {
          try {
            this.sendEvent(client.res, 'error', {
              trace_id: traceId,
              code: 'STREAM_TIMEOUT',
              message: 'stream connection timeout'
            })
            client.res.end()
          } catch (_error) {
            // ignore
          }
          this.removeClient(traceId, client)
        }
      }
    }
  }

  getStats() {
    return {
      active_connections: this.totalConnections,
      trace_groups: this.clients.size,
      max_connections: this.maxConnections,
      heartbeat_ms: this.heartbeatMs,
      client_ttl_ms: this.clientTtlMs
    }
  }
}

module.exports = {
  StreamManager
}
