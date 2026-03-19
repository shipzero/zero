# Zero

Self-hosted deployment platform. Push Docker images or Compose stacks to your own server with automatic TLS, reverse proxying, and zero-downtime deploys.

## Server

### Requirements

- Ubuntu 22.04+ (or any Linux with systemd)
- Root access
- A domain pointing to your server (optional, can use IP)

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/shipzero/zero/main/install.sh | sudo bash
```

The installer will:

1. Install Docker if not present
2. Prompt for your domain and ACME email (for Let's Encrypt)
3. Start zero
4. Print your `TOKEN` and API URL

### Upgrade

```bash
curl -fsSL https://raw.githubusercontent.com/shipzero/zero/main/install.sh | sudo bash
```

Re-running the install script detects the existing installation and upgrades in place. Config is preserved.

### Configuration

Config lives in `/opt/zero/.env`:

```
TOKEN=<random-hex>
DOMAIN=your-server.com
EMAIL=you@example.com
```

Logs:

```bash
docker compose -f /opt/zero/docker-compose.yml logs -f
```

## CLI

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/shipzero/zero/main/cli/install.sh | bash
```

### Build from source

```bash
cd cli
bun install
bun run build
```

The binary is written to `dist/zero`.

### Alias (development)

If you're developing the CLI locally:

```bash
# Add to ~/.zshrc or ~/.bashrc
alias zero="bun run /path/to/zero/cli/src/main.ts"
```

### Connect to your server

```bash
zero login https://your-server.com <TOKEN>
```

## Usage

### Add an app (Docker image)

```bash
zero add --name myapp --image ghcr.io/user/myapp:latest --domain myapp.example.com
zero add --name keycloak --image quay.io/keycloak/keycloak:latest --port 8080 --command "start-dev"
zero add --name postgres --image postgres:16 --port 5432 --volume pgdata:/var/lib/postgresql/data
zero add --name keycloak --image quay.io/keycloak/keycloak:latest --port 8080 --command "start-dev" --health-path /health/ready
```

### Add an app (Docker Compose)

```bash
zero add --name myapp --compose docker-compose.yml --service web --domain myapp.example.com --port 3000
```

### Deploy

```bash
zero deploy myapp
zero deploy myapp --tag v1.2.3
```

### Deployment history

```bash
zero deployments myapp
```

### Environment variables

```bash
zero env ls myapp
zero env set myapp KEY=value ANOTHER=value
zero env rm myapp KEY ANOTHER
```

### List apps

```bash
zero ls
```

### Logs

```bash
zero logs myapp
zero logs --server
```

### Registry credentials

```bash
zero registry login ghcr.io --user <username> --password <token>
zero registry ls
zero registry logout ghcr.io
```

### Remove an app

```bash
zero rm myapp
```

### Rollback

```bash
zero rollback myapp
```

### Start / Stop

```bash
zero start myapp
zero stop myapp
```

### Status

```bash
zero status
```

### Upgrade

```bash
# Upgrade CLI
zero upgrade

# Upgrade server
zero upgrade --server

# Upgrade both
zero upgrade --all
```

### Version

```bash
zero version
```

### Webhook

```bash
zero webhook reset myapp
```
