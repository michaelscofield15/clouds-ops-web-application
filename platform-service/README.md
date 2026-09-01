# Autonomous DevOps Platform — Ingestion, Dockerization, GitHub Automation & Jenkins CI/CD (Phase 4)

A production-grade backend service, static analysis engine, automated Dockerization platform, and real GitHub + Jenkins CI/CD orchestration engine for the **Autonomous DevOps & CloudOps Platform**.

---

## 1. Overview & Purpose

Phase 4 introduces the **Real Git + GitHub Automation & Jenkins CI/CD Engine**. The platform connects with user GitHub accounts, performs pre-push security scanning, safely manages Git branches and pushes, generates dynamic Declarative `Jenkinsfile` configurations tailored to detected project technology, provisions real Jenkins pipeline jobs, triggers builds, and streams live build console logs and telemetry.

---

## 2. Core Capabilities Across Phases

### Phase 2: Ingestion & Static Analysis
- **Secure Archive Ingestion**: Magic byte signature verification, file size enforcement, and Zip Slip defense.
- **Static Code & Manifest Analyzer**: Inspects `package.json`, lockfiles, entrypoints, ports, DevOps assets (Docker, K8s, Helm, CI/CD, Terraform), and audits for secret leaks without code execution.

### Phase 3: Automatic Dockerization Engine
- **Docker Daemon Precheck**: Validates Docker daemon availability before executing builds.
- **Intelligent Dockerfile Lifecycle**:
  - **Case A (No Dockerfile)**: Generates a hardened, multi-stage production Dockerfile (`node:20-alpine`, non-root user, optimized layer caching, detected port & entry point).
  - **Case B (Existing Valid Dockerfile)**: Reuses existing custom Dockerfile without overwriting.
  - **Case C (Existing Broken Dockerfile)**: Captures real Docker build errors, creates backup `Dockerfile.cloudops-backup`, and safely repairs the Dockerfile without false success.
- **Real Docker Build & Inspection**: Executes `docker build`, inspects image IDs, tags, layers, and sizes.
- **Hardened Container Execution**:
  - Resource constraints (`--memory=512m`, `--cpus=1.0`).
  - No `--privileged`, no host mounts, no Docker socket exposure.
  - Dynamic host port mapping (`-p 127.0.0.1::${port}`) on loopback to prevent host port collisions.
- **Automated HTTP Health Verification**:
  - Polls `http://127.0.0.1:<mappedHostPort>/health` with configurable backoff retries.
  - Verifies HTTP 200 and dynamic timestamp response.

### Phase 4: Git, GitHub & Jenkins CI/CD Automation
- **GitHub Integration**:
  - Secure token connection & status endpoint (`GET /api/github/account`, `POST /api/github/connect`).
  - Repository listing & dynamic repository creation (`GET /api/github/repos`, `POST /api/github/repos`).
  - Branch listing (`GET /api/github/repos/:owner/:repo/branches`).
  - Zero token exposure to client (tokens managed server-side and masked in all logs).
- **Pre-Push Secret Scanning**:
  - Deep file-by-file regex scanner for AWS keys, private keys, GitHub tokens, Slack tokens, Stripe keys, and unencrypted `.env` files.
  - Halts push immediately (`HTTP 400 status: "blocked"`) if sensitive credentials are detected.
- **Isolated & Safe Git Engine**:
  - Safe argument arrays using `child_process.spawn` (no command injection).
  - Strict repository isolation using `--git-dir` and `--work-tree` to prevent touching host or parent repositories.
  - Safe branch creation (`cloudops/provision/<projectId>`) and authenticated push.
- **Declarative Jenkinsfile Generator**:
  - Multi-stage pipeline tailored to project technology:
    1. *Checkout SCM*
    2. *Install Dependencies* (`npm ci`, `yarn install`, `pnpm install`)
    3. *Run Automated Tests* (`npm test`, `yarn test`)
    4. *Security & Quality Gate* (manifest integrity & secret validation)
    5. *Docker Image Build* (`docker build -t <app>:<tag> .`)
    6. *Docker Image Verification* (`docker image inspect`)
    7. *Post actions* (success/failure notifications)
- **Real Jenkins Orchestration Engine**:
  - Jenkins status probe (`GET /api/jenkins/status`).
  - Automatic CSRF Crumb handling & basic authentication.
  - Jenkins Pipeline job provisioning (`POST /api/projects/:projectId/jenkins/job`).
  - Build triggering (`POST /api/projects/:projectId/jenkins/build`).
  - Live build status polling & duration tracking (`GET /api/projects/:projectId/jenkins/build/:buildNumber`).
  - Live console logs streaming with credential redaction (`GET /api/projects/:projectId/jenkins/build/:buildNumber/logs`).
- **Structured Audit Logging**:
  - Complete project event timeline (`GET /api/projects/:projectId/audit`).

---

## 3. Requirements

- **Node.js**: Version `>= 18.0.0`
- **npm**: Version `>= 9.0.0`
- **Git**: Installed and available in PATH
- **Docker**: Docker Engine / Docker Desktop installed and running
- **Jenkins**: Jenkins Server (v2.x+) with Pipeline and Git plugins installed

---

## 4. Installation & Configuration

```bash
cd platform-service
npm install
cp .env.example .env
```

### Environment Configuration (`.env`)

```env
PORT=4000
NODE_ENV=development
MAX_UPLOAD_SIZE_MB=50
TEMPORARY_DIR=temporary/projects

# GitHub Configuration
GITHUB_TOKEN=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://localhost:4000/api/github/callback

### Phase 5: Real Kubernetes Automation Engine (Kind Cluster)
- **Host Prerequisite Detection**: Discovers OS, Docker daemon status, `kubectl`, `kind`, and Homebrew.
- **Automated Kind Cluster Management**: Detects and provisions local Kind cluster `cloudops-local` with node readiness verification.
- **Dynamic Kubernetes Manifests**: Generates DNS-1123 compliant Deployment and NodePort Service YAML manifests based on Phase 2 analysis (port, entrypoint) and Phase 3 image tag.
- **Real Image Loading**: Direct image load into Kind nodes via `kind load docker-image`.
- **Live Rollout & Telemetry**: Safe manifest application, rollout tracking, Pod phase/IP inspection, live Pod logs (`kubectl logs`), and namespace event streaming.
- **Live Health Probe**: Real application HTTP `/health` probe verification via ephemeral port forwarding.
- **Lifecycle & Teardown**: Project namespace isolation and real resource deletion (`DELETE /api/projects/:id/kubernetes`).

---

## 3. Environment Configuration

Copy `.env.example` to `.env`:

```env
PORT=4000
NODE_ENV=development
MAX_FILE_SIZE_MB=50

# Jenkins Configuration
JENKINS_URL=http://127.0.0.1:8080
JENKINS_USERNAME=jaswanth15
JENKINS_API_TOKEN=password

# Kubernetes Configuration
KUBERNETES_CLUSTER_NAME=cloudops-local
KUBERNETES_DEFAULT_NAMESPACE=cloudops-default
KUBERNETES_DEPLOY_TIMEOUT_MS=60000
KUBERNETES_HEALTH_TIMEOUT_MS=30000
```

---

## 4. Running the Platform

```bash
npm start
```

Web UI is available at `http://localhost:4000`.

---

## 5. Automated Testing

Run the full platform test suite (42 passing tests covering Analyzer, Dockerization, GitHub/Git, Jenkins CI/CD, and Kubernetes Automation):

```bash
npm test
```

Run the real Kubernetes end-to-end production workflow:

```bash
npm run test:k8s
```

---

## 6. API Endpoints

### Kubernetes Endpoints
- `GET /api/kubernetes/status` — Cluster prerequisites and node readiness status
- `POST /api/kubernetes/cluster` — Ensure or bootstrap Kind cluster
- `POST /api/projects/:projectId/kubernetes/deploy` — Deploy dockerized project to Kind cluster
- `GET /api/projects/:projectId/kubernetes/status` — Live deployment status and health probe results
- `GET /api/projects/:projectId/kubernetes/pods` — Live running Pods list
- `GET /api/projects/:projectId/kubernetes/service` — Live Service details and endpoints
- `GET /api/projects/:projectId/kubernetes/logs` — Stream active container stdout/stderr logs
- `GET /api/projects/:projectId/kubernetes/events` — Chronological namespace lifecycle events
- `DELETE /api/projects/:projectId/kubernetes` — Teardown Deployment, Service, and Namespace

### GitHub & Git Endpoints
- `GET /api/github/account` — Status of connected GitHub account
- `POST /api/github/connect` — Connect GitHub Personal Access Token
- `POST /api/github/disconnect` — Disconnect active GitHub account
- `GET /api/github/repos` — List user repositories
- `POST /api/github/repos` — Create a new repository
- `GET /api/github/repos/:owner/:repo/branches` — List repository branches
- `POST /api/projects/:projectId/github/push` — Pre-push scan, commit, and push project to GitHub

### Jenkins CI/CD Endpoints
- `GET /api/jenkins/status` — Live Jenkins daemon health & version check
- `POST /api/projects/:projectId/jenkins/job` — Provision or update Jenkins Pipeline job
- `POST /api/projects/:projectId/jenkins/build` — Trigger a pipeline build
- `GET /api/projects/:projectId/jenkins/build/:buildNumber` — Retrieve live build status & duration
- `GET /api/projects/:projectId/jenkins/build/:buildNumber/logs` — Stream real Jenkins console output
- `GET /api/projects/:projectId/audit` — Retrieve structured project audit history
