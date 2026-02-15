# Development Conventions

## Branch Strategy

- `main`: production-ready branch
- `develop`: integration branch
- feature branches: `feature/<scope>-<short-desc>`
- fix branches: `fix/<scope>-<short-desc>`

## Commit Convention

Use conventional commit style:

- `feat:` new feature
- `fix:` bug fix
- `refactor:` code restructuring without behavior change
- `docs:` documentation only
- `test:` test related changes
- `chore:` tooling and maintenance

## API and Contract Rules

- Public API contracts must be documented before implementation.
- Backward-incompatible changes require explicit versioning plan.
- All request handlers should include `trace_id` propagation.

## Logging Rules

- Structured logs only (JSON style in production).
- Never log secrets or raw credentials.
- Include: `timestamp`, `level`, `trace_id`, `scenario_id`, `latency_ms` where applicable.

## Environment Rules

- Never hardcode secrets.
- Use `.env` for local development.
- Keep `configs/environments/.env.example` updated when adding new env keys.

## Quality Gates (Baseline)

- Lint passes
- Unit tests pass
- No secret leakage in code
- Documentation updated for contract or behavior changes
