# KB Mappings

This directory stores scenario-to-knowledge-base mapping references.

## Source of Truth

For subtype-to-KB routing, `configs/kb-mappings/*.kbmap.json` is the single source
of truth. Scenario files should only keep knowledge policy switches/limits
(`enabled`, `mode`, `top_k`, `rerank`, `max_context_chars`) and not duplicate the
mapping table.

## Runtime

Mappings are hot-reloaded by `KbMappingStore` using file mtime checks.
