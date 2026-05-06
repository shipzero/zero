# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com), and this project adheres to [Calendar Versioning](https://calver.org) (`vYYYY.M.D`).

## [Unreleased]

## [v2026.5.6]

### Changed

- **Reverse proxy timeouts** — defaults raised to `5m` request, `30s` headers, `30m` WebSocket idle (previously `60s`, `10s`, `5m`); now configurable via `PROXY_REQUEST_TIMEOUT`, `PROXY_HEADERS_TIMEOUT`, `PROXY_WS_IDLE_TIMEOUT` (duration strings, e.g. `10m`, `1h`)

## [v2026.4.8]

### Added

- **Automatic image cleanup** — old container images are removed automatically when they fall out of the rollback retention window (last 10 deployments per app)
- **Compose dangling image cleanup** — compose deploys prune dangling images after each successful update, freeing disk space when rolling tags are repulled

### Fixed

- **Self-upgrade resilience** — `zero upgrade --server` now pulls the `docker:cli` helper image automatically if missing, instead of failing with a 404
- **Install script** — skip Let's Encrypt email prompt when the server domain is an IP address or `localhost`

## [v2026.4.1] — Initial Release

### Added

- **One-command deploys** — deploy any Docker image with `zero deploy <image>`
- **Automatic HTTPS** — TLS certificates via Let's Encrypt, provisioned and renewed automatically
- **Zero-downtime deployments** — health-checked container swaps with automatic rollback on failure
- **Preview deployments** — `--preview <label>` creates a temporary environment with its own URL
- **Webhooks** — HMAC-SHA256 verified; push to your registry, zero deploys automatically
- **Docker Compose support** — multi-container apps via `--compose`
- **Built-in reverse proxy** — Host-based routing, TLS termination, security headers
- **Live metrics** — CPU, memory, and network usage streamed to the terminal
- **One-command rollback** — `zero rollback <app>`
- **Environment variables** — inline via `--env` or managed with `zero env`
- **Volume support** — persistent storage via `--volume`
- **Multiple domains per app** — `zero domain add/remove/list`
- **Private registry support** — `zero registry login/logout/list`
- **SSH-based authentication** — if you can SSH in, you can deploy
- **Self-upgrade** — `zero upgrade --server` updates zero remotely
- **CLI binaries** — prebuilt for Linux, macOS, and Windows

[Unreleased]: https://github.com/shipzero/zero/compare/v2026.5.6...HEAD
[v2026.5.6]: https://github.com/shipzero/zero/compare/v2026.4.8...v2026.5.6
[v2026.4.8]: https://github.com/shipzero/zero/compare/v2026.4.1...v2026.4.8
[v2026.4.1]: https://github.com/shipzero/zero/releases/tag/v2026.4.1
