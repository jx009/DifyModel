class InMemoryRateLimiter {
  constructor(options) {
    this.windowMs = options.windowMs || 60_000
    this.defaultMaxRequests = options.maxRequests || 120
    this.tenantMaxRequests = options.tenantMaxRequests || this.defaultMaxRequests
    this.store = new Map()
  }

  getLimitByScope(scope) {
    if (scope === 'tenant') {
      return this.tenantMaxRequests
    }
    return this.defaultMaxRequests
  }

  isAllowed(key, scope = 'ip') {
    const limit = this.getLimitByScope(scope)
    const now = Date.now()
    const current = this.store.get(key)

    if (!current || now > current.expiresAt) {
      this.store.set(key, { count: 1, expiresAt: now + this.windowMs })
      return { allowed: true, remaining: limit - 1, limit }
    }

    if (current.count >= limit) {
      return { allowed: false, remaining: 0, retryAfterMs: current.expiresAt - now, limit }
    }

    current.count += 1
    return { allowed: true, remaining: limit - current.count, limit }
  }
}

module.exports = {
  InMemoryRateLimiter
}
