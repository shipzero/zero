# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com), and this project adheres to [Calendar Versioning](https://calver.org) (`vYYYY.M.D`).

## [Unreleased]

## v2025.3.24 — Initial Release

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
