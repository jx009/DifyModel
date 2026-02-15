# Environment Layout

The project uses three standard environments:

- `dev`: local development and fast iteration
- `staging`: pre-release validation and integration testing
- `prod`: production traffic

## Baseline Environment Variables

Defined in `configs/environments/.env.example`.

## Promotion Rules

- Dev -> Staging: basic functionality validated
- Staging -> Prod: regression and rollout checks passed
