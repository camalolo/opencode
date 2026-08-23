# Profiling toolset

Zero-dependency Node scripts for profiling an opencode server (any machine, any platform).
All accept a `BASE` env override (`export BASE=http://127.0.0.1:4096`).

## Request latency / load

- **bench.mjs** — latency benchmark over read-only endpoints (p50/p95/max per endpoint).
  `node bench.mjs [sessionID] [iterations=5] [--json]` · env `BASE`, `DIR` (project dir, default cwd)
- **loadgen.mjs** — sustained mixed load. `node loadgen.mjs [sessionID] [durationMs=15000] [concurrency=4]`
- **slow-report.mjs** — aggregate the server's slow-request log by normalized route
  (needs patch 03; threshold `OPENCODE_SLOW_REQUEST_MS`, default 250ms).
  `node slow-report.mjs [file]` · default `~/.local/share/opencode/log/slow-requests.jsonl`

## Traces (needs patch 04 + collector)

- **otlp-collector.mjs** — minimal OTLP/HTTP collector: `/v1/traces` → JSONL spans, 64MB rotation.
  env `PORT` (default 4318), `TRACES_OUT` (default `~/.local/share/opencode/log/traces.jsonl`).
  Run standalone (`node otlp-collector.mjs`) or as a systemd user unit
  (see `opencode-otlp.service` beside this README; point opencode at it with
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`).
  Sampling knob on the server: `OPENCODE_TRACE_RATIO` (default 1 = all spans).
- **trace-report.mjs** — inclusive/exclusive time by span name from a traces.jsonl.
  `node trace-report.mjs [file] [topN=40]`

## CPU profiles (Bun)

- **analyze.mjs** — self-time by function/module from a `.cpuprofile`.
  `node analyze.mjs <file.cpuprofile> [topN=40]`
- **stacks.mjs** — aggregated stack paths for chosen functions.
  `node stacks.mjs <file.cpuprofile> [functionName ...]`
- **cdp-exit.mjs** — cleanly exit a `BUN_INSPECT=ws://...` process so `--cpu-prof` flushes.
  `node cdp-exit.mjs ws://127.0.0.1:9229/prof`

## CPU-profiling gotchas (Bun)

- Flag is `--cpu-prof` (not `--cpu-profile`); profile flushes ONLY on clean exit.
- Start server with `BUN_INSPECT=ws://127.0.0.1:9229/prof bun --cpu-prof ...`, then
  `node cdp-exit.mjs ws://127.0.0.1:9229/prof`.
- Inspector has no Profiler domain and no `/json` discovery; the WS path comes from the startup banner.
