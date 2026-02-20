# resume_ai workflows

Workflow mapping for scenario `resume_ai`.

Sub-types:
- `import_parse`: parse raw resume text into target `resume.content` schema.
- `section_optimize`: optimize one target field and keep facts unchanged.
- `full_optimize`: output per-field optimization suggestions for the whole resume.

Each prompt template enforces strict JSON-only output.
