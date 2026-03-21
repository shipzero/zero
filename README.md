<p align="center">
  <img src="logo.png" alt="zero" width="320" />
</p>

<p align="center">
  Self-hosted deployment platform for Docker containers and Compose stacks.<br>
  Deploy to your own server with automatic TLS, reverse proxying, and zero-downtime deployments.
</p>

**One server. One command. Your apps live.**

```bash
# Install the server
curl -fsSL https://raw.githubusercontent.com/shipzero/zero/main/install.sh | sudo bash

# Install the CLI
curl -fsSL https://raw.githubusercontent.com/shipzero/zero/main/cli/install.sh | bash

# Connect and deploy
zero login root@your-server.com
zero add --name myapp --image ghcr.io/you/myapp:latest --domain myapp.example.com
zero deploy myapp
```

## Motivation

Platforms like Vercel and Railway are great — until the bill arrives or you hit the limits of their walled garden.
Self-hosting gives you full control, but setting up Docker, TLS certificates, reverse proxies, and zero-downtime
deployments by hand is tedious and error-prone.

zero bridges that gap. Rent a server (Hetzner, DigitalOcean, any VPS), run one install command, and you have a
deployment platform that handles everything. Deploy any Dockerized app with a single CLI command — no YAML pipelines, no
vendor lock-in, no surprise invoices.

## Why zero

- **Zero-downtime deployments** — new containers are health-checked before traffic is swapped
- **Automatic TLS** — Let's Encrypt certificates provisioned and renewed automatically
- **Reverse proxy built in** — route domains to containers, no Nginx or Traefik needed
- **Docker Compose support** — deploy multi-service stacks with a single command
- **Preview deployments** — deploy branches as temporary preview environments with automatic expiry
- **Webhooks** — auto-deploy on push from GitHub Container Registry or Docker Hub
- **Rollback** — instantly revert to the previous deployment
- **Live metrics** — CPU, memory, and network usage in the terminal
- **Single binary CLI** — available for Linux, macOS, and Windows
- **Minimal footprint** — two dependencies (dockerode, acme-client), runs in a single container

## Comparison

There are excellent self-hosting tools out there. Here's how zero fits in:

|                  | zero                       | Coolify                | CapRover          | Dokku                 | Kamal                |
|------------------|----------------------------|------------------------|-------------------|-----------------------|----------------------|
| Interface        | CLI only                   | Web UI                 | Web UI            | CLI                   | CLI                  |
| Deploy model     | Docker images              | Git/Docker             | Git/Docker        | Git push (Buildpacks) | Docker images        |
| Reverse proxy    | Built in                   | Traefik                | Nginx             | Nginx                 | Traefik              |
| Orchestration    | Docker                     | Docker                 | Docker Swarm      | Docker                | SSH to host          |
| Server footprint | 1 container                | Multiple services + DB | Multiple services | System packages       | No agent             |
| Dependencies     | 2 (dockerode, acme-client) | Many                   | Many              | Many                  | Ruby                 |
| Compose support  | Yes                        | Yes                    | No                | No                    | Yes (accessories)    |
| Setup            | One command                | One command            | One command       | `apt install`         | Gem install + config |

**zero is for you if** you want the simplest possible path from "I have a server" to "my app is live with HTTPS" —
without a web UI, without a database, without dozens of moving parts. One container, one CLI, done.

## Table of Contents

- [Server Setup](#server-setup)
  - [Requirements](#requirements)
  - [Install](#install)
  - [Upgrade](#upgrade)
  - [Configuration](#configuration)
  - [Uninstall](#uninstall)
- [CLI Setup](#cli-setup)
  - [Install](#install-the-cli)
  - [Build from Source](#build-from-source)
  - [Connect to Your Server](#connect-to-your-server)
  - [Uninstall](#uninstall-the-cli)
- [Deploying Apps](#deploying-apps)
  - [Docker Images](#docker-images)
  - [Docker Compose Stacks](#docker-compose-stacks)
  - [Health Checks](#health-checks)
  - [Environment Variables](#environment-variables)
  - [Volumes](#volumes)
  - [Registry Credentials](#registry-credentials)
- [Preview Deployments](#preview-deployments)
- [Managing Apps](#managing-apps)
  - [List Apps](#list-apps)
  - [View Logs](#view-logs)
  - [Live Metrics](#live-metrics)
  - [Deployment History](#deployment-history)
  - [Start and Stop](#start-and-stop)
  - [Rollback](#rollback)
  - [Remove an App](#remove-an-app)
- [Automatic Deployments via Webhooks](#automatic-deployments-via-webhooks)
- [TLS and HTTPS](#tls-and-https)
- [How It Works](#how-it-works)
  - [Zero-Downtime Deployment](#zero-downtime-deployment)
  - [Reverse Proxy](#reverse-proxy)
  - [Certificate Management](#certificate-management)
- [CLI Reference](#cli-reference)
- [License](#license)

## Server Setup

### Requirements

- Linux server (Ubuntu 22.04+ recommended)
- Root access
- A domain pointing to your server (optional — can use an IP address)

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/shipzero/zero/main/install.sh | sudo bash
```

The installer will:

1. Install Docker if not already present
2. Prompt for your domain and an email address for Let's Encrypt
3. Generate authentication secrets
4. Start zero

After installation, the output shows your API URL and login command:

```
┌──────────┐
│   zero   │
└──────────┘

[zero] zero is running!
[zero] API:    https://your-server.com
[zero] CLI:    zero login root@your-server.com
```

### Upgrade

Re-run the install script. It detects the existing installation and upgrades in place. Your configuration is preserved.

```bash
curl -fsSL https://raw.githubusercontent.com/shipzero/zero/main/install.sh | sudo bash
```

Or upgrade remotely via the CLI:

```bash
zero upgrade --server
```

### Configuration

Configuration is stored in `/opt/zero/.env`:

| Variable                 | Description                                     | Default       |
|--------------------------|-------------------------------------------------|---------------|
| `TOKEN`                  | Internal auth token (do not share)              | *(generated)* |
| `JWT_SECRET`             | Secret for signing JWT tokens                   | *(generated)* |
| `DOMAIN`                 | Server domain (used for webhook URLs and TLS)   | *(server IP)* |
| `EMAIL`                  | Let's Encrypt email (enables automatic TLS)     | —             |
| `API_PORT`               | API server port                                 | `2020`        |
| `CERT_RENEW_BEFORE_DAYS` | Renew certificates this many days before expiry | `30`          |
| `PREVIEW_TTL`            | Default time to live for preview deployments    | `7d`          |

View server logs:

```bash
docker compose -f /opt/zero/docker-compose.yml logs -f
```

### Uninstall

```bash
docker compose -f /opt/zero/docker-compose.yml down
rm -rf /opt/zero /data/state /data/certs /data/compose
docker rmi ghcr.io/shipzero/zero:latest docker:cli
```

## CLI Setup

### Install the CLI

```bash
curl -fsSL https://raw.githubusercontent.com/shipzero/zero/main/cli/install.sh | bash
```

Pre-built binaries are available for Linux, macOS, and Windows.

### Build from Source

Requires [Bun](https://bun.sh).

```bash
cd cli
bun install
bun run build
```

The binary is written to `dist/zero`.

### Connect to Your Server

```bash
zero login user@your-server.com
```

Authentication uses SSH — if you can SSH into the server, you can use zero. The CLI obtains a short-lived JWT via SSH
and stores it locally.

Credentials are saved to `~/.zero/config.json`. Verify the connection:

```bash
zero status
```

### Uninstall the CLI

```bash
rm -rf ~/.zero
```

Remove the PATH entry from your shell configuration (`~/.zshrc` or `~/.bashrc`):

```bash
# Delete the line containing .zero/bin
sed -i '/.zero\/bin/d' ~/.bashrc    # Linux
sed -i '' '/.zero\/bin/d' ~/.zshrc  # macOS
```

## Deploying Apps

### Docker Images

Register an app and deploy it:

```bash
zero add --name myapp --image ghcr.io/you/myapp:latest --domain myapp.example.com
zero deploy myapp
```

Deploy a specific tag:

```bash
zero deploy myapp --tag v1.2.3
```

Available options for `zero add`:

| Flag               | Description                                                       | Default |
|--------------------|-------------------------------------------------------------------|---------|
| `--name`           | App name (required)                                               | —       |
| `--image`          | Docker image reference (required)                                 | —       |
| `--domain`         | Domain for reverse proxy routing                                  | —       |
| `--port`           | Internal container port                                           | `3000`  |
| `--host-port`      | Expose directly on a host port (when no domain is set)            | —       |
| `--command`        | Container startup command                                         | —       |
| `--volume`         | Volumes, comma-separated (e.g. `pgdata:/var/lib/postgresql/data`) | —       |
| `--health-path`    | HTTP health check endpoint                                        | —       |
| `--health-timeout` | Health check timeout (e.g. `30s`, `3m`)                           | `60s`   |

Examples:

```bash
# Web app with custom domain
zero add --name api --image ghcr.io/you/api:latest --domain api.example.com --port 8080

# Database with a volume and direct port access
zero add --name postgres --image postgres:16 --port 5432 --host-port 5432 --volume pgdata:/var/lib/postgresql/data

# App with a custom command and health check
zero add --name keycloak --image quay.io/keycloak/keycloak:latest --port 8080 --command "start" --health-path /health/ready --health-timeout 3m
```

### Docker Compose Stacks

Deploy multi-service applications using a Compose file:

```bash
zero add --name mystack --compose docker-compose.yml --service web --domain mystack.example.com --port 3000
zero deploy mystack
```

| Flag          | Description                                                           |
|---------------|-----------------------------------------------------------------------|
| `--compose`   | Path to a `docker-compose.yml` file (required)                        |
| `--service`   | The entry service that receives traffic (required)                    |
| `--domain`    | Domain for reverse proxy routing                                      |
| `--port`      | Internal port the entry service listens on                            |
| `--host-port` | Expose entry service directly on a host port                          |
| `--repo`      | Image repo prefix for tag substitution (enables `--tag` and webhooks) |
| `--tag`       | Default image tag for deployments and rollbacks                       |

The Compose file is uploaded to the server. On deploy, zero runs `docker compose pull` and `docker compose up -d`, then
health-checks the entry service before routing traffic.

**Tag substitution with `--repo`:** When `--repo` is set, `zero deploy mystack --tag v2` replaces all image tags
matching the repo prefix. For example, with `--repo ghcr.io/org/project`:

```
ghcr.io/org/project/backend:test  → ghcr.io/org/project/backend:v2
ghcr.io/org/project/frontend:test → ghcr.io/org/project/frontend:v2
postgres:16-alpine                → postgres:16-alpine  (unchanged)
```

This also enables automatic preview deployments via webhooks — any non-tracked tag pushed to the registry triggers a
preview deployment with the tag substituted into all matching images.

### Health Checks

Every deployment is health-checked before traffic is routed to it.

**TCP check** (default): zero opens a TCP connection to the container port. The container is considered healthy when it
accepts connections.

**HTTP check** (when `--health-path` is set): zero sends `GET` requests to the specified path. The container is
considered healthy when it responds with a status code below 500.

Health checks run every 500ms with a 60-second timeout (configurable via `--health-timeout`, e.g.
`--health-timeout 3m`).
If the container crashes or exits during the health check, the deployment fails immediately and traffic stays on the
previous version.

### Environment Variables

```bash
# Set variables
zero env set myapp DATABASE_URL=postgres://localhost/mydb SECRET_KEY=abc123

# List variables (values are masked)
zero env ls myapp

# Remove variables
zero env rm myapp SECRET_KEY
```

Changes take effect on the next deployment. After updating variables, redeploy:

```bash
zero deploy myapp
```

For Compose apps, variables are written as a `.env` file alongside the Compose file. Docker Compose automatically
substitutes `${VAR}` references in the Compose file with values from this file.

### Volumes

Volumes are specified during `zero add` as a comma-separated list:

```bash
zero add --name postgres --image postgres:16 --port 5432 --volume pgdata:/var/lib/postgresql/data,/host/path:/container/path:ro
```

Format: `source:destination[:mode]`

### Registry Credentials

To pull images from private registries, add credentials:

```bash
# Add credentials
zero registry login ghcr.io --user <username> --password <token>

# List configured registries
zero registry ls

# Remove credentials
zero registry logout ghcr.io
```

Credentials are stored on the server and used automatically when pulling images. Supports Docker Hub, GitHub Container
Registry, and any OCI-compatible registry.

### Preview Deployments

Deploy temporary preview environments from any image tag. Previews run as sub-deployments of an existing app and get
their own subdomain automatically.

```bash
# Deploy a preview
zero preview deploy myapp --tag pr-42

# Deploy with a custom label and TTL
zero preview deploy myapp --tag feature-branch --label feat-1 --ttl 24h
```

| Flag      | Description                       | Default         |
|-----------|-----------------------------------|-----------------|
| `--tag`   | Image tag to deploy (required)    | —               |
| `--label` | Preview label (used in subdomain) | same as `--tag` |
| `--ttl`   | Time to live (e.g. `24h`, `7d`)   | `7d`            |

The preview is deployed at `<label>.<app-domain>`. For example, if the app domain is `myapp.example.com` and the label
is `pr-42`, the preview URL is `https://pr-42.myapp.example.com`.

> **DNS:** Preview subdomains require a wildcard DNS record (`*.myapp.example.com`) pointing to your server. The
`zero add` command shows the required DNS records.

**List previews:**

```bash
zero preview ls myapp
```

Previews are also shown under their parent app in `zero ls`.

**Logs and metrics:**

```bash
# Stream preview container logs
zero logs myapp --preview pr-42

# Show live resource usage
zero metrics myapp --preview pr-42
```

**Remove previews:**

```bash
# Remove a single preview
zero preview rm myapp pr-42

# Remove all previews for an app
zero preview rm myapp --all
```

Previews expire automatically after their TTL. The expiry is shown as relative time with the exact date and time, e.g.
`6d (Mar 27, 2:30 PM)`. Expired previews are cleaned up hourly. Removing an app also removes all its previews.

## Managing Apps

### List Apps

```bash
zero ls
```

Shows all registered apps with their status, URL, image, and last deployment time. Preview deployments are listed under
their parent app.

### View Logs

```bash
# Stream app logs
zero logs myapp

# Stream server logs
zero logs --server
```

Logs are streamed in real time. Press `ctrl+c` to stop.

### Live Metrics

```bash
zero metrics myapp
```

Shows live CPU, memory, and network usage directly in the terminal. The display updates automatically and progress bars
change color based on utilization (green → yellow → red).

```
myapp

  cpu     ██████░░░░░░░░░░░░░░  28.3%
  memory  ████████████░░░░░░░░  312 MB / 512 MB (60.9%)
  net ↓   1.2 MB/s
  net ↑   340 KB/s

  ctrl+c to stop
```

### Deployment History

```bash
zero deployments myapp
```

Shows the last deployments with image, container ID, and timestamp. The current deployment is marked.

### Start and Stop

```bash
# Stop an app (container stops, traffic returns 502)
zero stop myapp

# Start a stopped app (health-checked before routing)
zero start myapp
```

### Rollback

Revert to the previous deployment:

```bash
zero rollback myapp
```

zero starts a new container from the previous image and swaps traffic once it's healthy. For Compose apps with `--repo`,
rollback redeploys with the previous tag applied to all matching images.

### Remove an App

```bash
zero rm myapp
```

Stops and removes all containers associated with the app, including any preview deployments. For Compose apps, runs
`docker compose down --remove-orphans`.

## Automatic Deployments via Webhooks

Every app gets a unique webhook URL. When a registry sends a push notification, zero automatically deploys the new
image.

**Setup:**

1. Get the webhook URL:

   ```bash
   zero webhook reset myapp
   ```

2. Add the URL as a webhook in your registry (GitHub Container Registry or Docker Hub).

3. Push an image — zero deploys it automatically.

**Tag filtering:** If the app was added with a specific tag (e.g. `myapp:latest`), only pushes matching that tag trigger
a production deployment. Non-matching tags automatically create preview deployments (if the app has a domain).

For Compose apps with `--repo`, non-matching tags also trigger preview deployments with tag substitution applied to all
matching images.

**Webhook security:** Payloads are verified using HMAC-SHA256 signatures (`x-hub-signature-256` header) with timing-safe
comparison.

To rotate the webhook secret:

```bash
zero webhook reset myapp
```

## TLS and HTTPS

zero automatically provisions and renews TLS certificates via Let's Encrypt when:

1. An `EMAIL` is set in the server configuration
2. The server has a real domain (not an IP address)

Certificates are provisioned on demand when an app with a domain is first deployed. Renewal happens automatically when a
certificate is within 30 days of expiry (configurable via `CERT_RENEW_BEFORE_DAYS`).

When TLS is enabled, HTTP requests are automatically redirected to HTTPS (301).

Apps using `--host-port` without a domain are served over plain HTTP.

## How It Works

### Zero-Downtime Deployment

Deployments follow a four-phase process:

1. **Pull** — the image is pulled from the registry (with credentials if configured)
2. **Start** — a new container is started on a random ephemeral port bound to localhost
3. **Health check** — zero waits up to 60 seconds for the container to become healthy
4. **Swap** — the reverse proxy route is atomically updated to point to the new container; old containers are removed

If the health check fails, the new container is discarded and traffic continues flowing to the existing container.
Nothing changes until the new version is verified.

### Reverse Proxy

zero includes a built-in reverse proxy that routes incoming requests to the correct container based on the `Host`
header.

- Domains are mapped to containers via their ephemeral localhost port
- TLS termination with automatic certificate selection via SNI
- Apps without a domain can be exposed directly via `--host-port`
- Security headers added automatically: `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`
- Forwarding headers set: `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto`
- Request timeout: 60s, max body size: 100 MB

### Certificate Management

- Certificates are generated using the ACME HTTP-01 challenge
- Stored on disk at `/data/certs/` (persisted across restarts)
- RSA 2048 server keys, P-256 EC account key
- Automatic renewal within the configured renewal window

## CLI Reference

Run `zero` without arguments to see this overview in your terminal.

```
zero <command> [options]

add --name --image [--domain] [--port] [--host-port] [--command] [--volume] [--health-path] [--health-timeout]
                                        Add a new app (Docker image)
add --name --compose --service [--domain] [--port] [--host-port] [--health-path] [--health-timeout] [--repo] [--tag]
                                        Add a new app (Docker Compose)
deploy <app> [--tag <tag>]              Deploy or redeploy an app
deployments <app>                       Show deployment history
env ls <app>                            List environment variables
env set <app> KEY=val [KEY=val ...]     Set environment variables
env rm <app> KEY [KEY ...]              Remove environment variables
login <user@server>                     Authenticate via SSH
logs <app> [--preview <label>] | --server
                                        Stream app or preview logs
ls                                      List all apps (including previews)
metrics <app> [--preview <label>] | --server
                                        Show live resource usage
preview deploy <app> --tag <tag> [--label] [--ttl]
                                        Deploy a preview environment
preview ls <app>                        List previews for an app
preview rm <app> <label> [--force]      Remove a preview
preview rm <app> --all [--force]        Remove all previews
registry login <server> --user --password
                                        Add registry credentials
registry logout <server>                Remove registry credentials
registry ls                             List configured registries
rm <app> [--force]                      Remove an app and its containers
rollback <app> [--force]                Roll back to previous deployment
start <app>                             Start a stopped container
status                                  Show server connection info
stop <app> [--force]                    Stop a running container
upgrade [--server] [--all] [--force]    Upgrade CLI and/or server
version                                 Show CLI and server version
webhook reset <app>                     Reset webhook secret
```

## Sponsors

<a href="https://codebeam.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="sponsors/codebeam_white.svg" />
    <source media="(prefers-color-scheme: light)" srcset="sponsors/codebeam_black.svg" />
    <img src="sponsors/codebeam_black.svg" alt="codebeam" height="30" />
  </picture>
</a>

## License

[MIT](LICENSE)
