# OpenAI API integration decision ledger

Application: exam / exam-maker. User authorized adding GPT alongside Claude and will enter an existing API key in Settings. Existing saved models and Claude keys stay in use until the user selects GPT.

## Scope and workload decisions

| Workflow | Route and behavior | Verification |
|---|---|---|
| Page text and equations | Native Responses API for selected GPT, existing Claude SDK otherwise; medium effort, 32K output; existing schema and repair loop | check_openai.ts and check_ai_requests.ts |
| Geometry and graphics | Same provider routing; high effort and existing geometry validation; no change to PNG/HWPX generation | check_graphics.ts, check-ai.mjs, existing HWPX checks |
| Page orientation | Selected page model, low effort, existing 2K output and rotation validation | Typecheck and existing orientation checks |
| Settings and usage | Separate encrypted keys using provider-specific device hash; per-task model selection; separate usage totals | check_openai.ts settings/auth/key isolation tests |

The selectable GPT models are gpt-6.1-terra, gpt-6.1-sol, and gpt-6-astra. No automatic paid model replacement or fallback. Sol is a reasonable first comparison candidate, but extraction accuracy has not been benchmarked against Claude on the user's exam pages. More expensive does not guarantee better reconstruction.

## Capability review

| Capability | Decision / evidence |
|---|---|
| Responses and transport | HTTP SSE internally; return complete validated JSON to the existing UI. WebSocket persistence is not applicable to isolated image requests with at most one repair turn. |
| Instructions and instruction files | Existing AGENTS.md and CLAUDE.md preserved. Existing prompts resent on every request. |
| Streaming errors and recovery | Parse typed completed/incomplete/failed events; cancellation/deadline covers stream; retry rejected 429/5xx once, excluding quota; do not blindly replay interrupted generation. |
| State and reasoning | store:false; encrypted reasoning included and all original output items/phases replayed unchanged for repairs; reasoning.context=all_turns. No stored-response chaining. |
| Privacy / residency | Existing browser-linked encrypted key storage retained. No new regional or contractual ZDR requirement was supplied. store:false is not a claim of account-level ZDR. No change to the existing account region. |
| Processing tier | Explicit standard/default for interactive reads. Priority, Flex, Batch and reserved processing are not applicable to the approved synchronous workflow. |
| Caching | Stable developer instruction has explicit breakpoint, 30m TTL, no cache key. Repair uses prior response ID for comparison diagnostics. Longer retention not selected. |
| Output controls | Existing per-workload reasoning effort and token ceilings retained. No new verbosity preference; structured JSON remains governed by schema and original prompts. |
| Compaction | Not applicable: no long-running conversation or tool loop. |
| Structured outputs | Existing Zod schema and validators retained; schema-specific 400 gets one same-model JSON-mode retry, then local validation. Refusal, incomplete and empty output are failures with usage. |
| Tools | Tool choice/search, parallel calls, programmatic tools and redesigned tool interfaces not applicable: no tools are exposed to the model. |
| Usage and cost | Standard model prices, 30m cache writes, model-specific cached input, long-context multiplier and output usage recorded. Estimates include reasoning output; not billing guarantees. |
| Product output | Existing editable text/equations, canvas figure rendering and HWPX layout preserved. |

## References checked 2026-11-11

- https://developers.openai.com/api/docs/models/gpt-6.1-sol
- https://developers.openai.com/api/docs/models/gpt-6.1-terra
- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/api/docs/guides/reasoning
- https://developers.openai.com/api/docs/guides/images-vision

## Validation status

Implementation complete; automated CI/build verification pending. Network-isolated regression tests use synthetic keys and mocked SSE. No actual user API key or paid GPT inference was used. Same-page quality evaluation remains for the user after registering the key.

