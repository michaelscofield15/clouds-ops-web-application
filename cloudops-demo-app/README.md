# CloudOps Demo Application

A clean, production-oriented Node.js and Express REST API designed as the baseline workload for the **Autonomous DevOps & CloudOps Platform**.

---

## 1. Purpose

This application serves as a realistic, lightweight target workload. In later phases of the platform lifecycle, it will be uploaded (e.g., as a ZIP package) and processed by autonomous CloudOps agents to generate container configurations, automated CI/CD pipelines, security compliance controls, Kubernetes manifests, telemetry metrics, and auto-remediation policies.

---

## 2. Features & API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Root status message showing application is running |
| `GET` | `/health` | Dynamic health check endpoint for container liveness/readiness probes |
| `GET` | `/api/info` | Application metadata and current runtime environment |
| `GET` | `/api/users` | Retrieve in-memory list of sample users |
| `GET` | `/api/users/:id` | Retrieve single user by ID with 404 handling |
| `GET` | `/api/products` | Retrieve in-memory catalog of sample cloud products |

---

## 3. Requirements

- **Node.js**: Modern LTS version (`>= 18.0.0`)
- **npm**: Version `>= 9.0.0`

---

## 4. Installation

Clone or extract the project repository, then install runtime and testing dependencies:

```bash
cd cloudops-demo-app
npm install
```

---

## 5. Configuration

Configuration parameters are managed through environment variables. 

Create a `.env` file in the root directory (based on `.env.example`):

```bash
cp .env.example .env
```

### Supported Environment Variables

| Variable | Description | Default Value |
| :--- | :--- | :--- |
| `PORT` | The port the HTTP server binds to | `3000` |
| `NODE_ENV` | Environment name (`development`, `production`, `test`) | `development` |

---

## 6. Running the Application

### Production / Standard Mode
```bash
npm start
```

### Development Mode (with hot-reload via Node watch)
```bash
npm run dev
```

---

## 7. Testing

Run the automated integration test suite powered by the Node.js built-in test runner:

```bash
npm test
```

To run tests in watch mode during development:

```bash
npm run test:watch
```

---

## 8. API Verification Examples (cURL)

### Root Status
```bash
curl -s http://localhost:3000/
```
**Response:**
```json
{
  "name": "cloudops-demo-app",
  "message": "CloudOps Demo Application is running",
  "version": "1.0.0"
}
```

### Health Check (Liveness / Readiness)
```bash
curl -s http://localhost:3000/health
```
**Response:**
```json
{
  "status": "healthy",
  "service": "cloudops-demo-app",
  "timestamp": "2026-08-22T12:00:00.000Z"
}
```

### Application Info
```bash
curl -s http://localhost:3000/api/info
```
**Response:**
```json
{
  "application": "cloudops-demo-app",
  "version": "1.0.0",
  "environment": "development"
}
```

### Get All Users
```bash
curl -s http://localhost:3000/api/users
```
**Response:**
```json
[
  { "id": 1, "name": "Alice", "role": "user" },
  { "id": 2, "name": "Bob", "role": "admin" },
  { "id": 3, "name": "Charlie", "role": "user" }
]
```

### Get User by ID
```bash
curl -s http://localhost:3000/api/users/1
```
**Response:**
```json
{
  "id": 1,
  "name": "Alice",
  "role": "user"
}
```

### Get Product Catalog
```bash
curl -s http://localhost:3000/api/products
```
**Response:**
```json
[
  { "id": 1, "name": "Cloud Storage Standard", "category": "storage", "price": 9.99 },
  { "id": 2, "name": "Compute Instance Basic", "category": "compute", "price": 24.5 },
  { "id": 3, "name": "Managed Database Micro", "category": "database", "price": 15 },
  { "id": 4, "name": "Global CDN Accelerator", "category": "networking", "price": 12 }
]
```

### Error Handling Example (404)
```bash
curl -s http://localhost:3000/does-not-exist
```
**Response:**
```json
{
  "error": "Resource not found",
  "path": "/does-not-exist"
}
```

---

## 9. Future Platform Integration (Phases 2+)

This application is designed specifically to interface with subsequent phases of the Autonomous DevOps & CloudOps Platform, including:

- **Automatic Dockerization**: Generation of optimized multi-stage Containerfiles.
- **CI/CD Automation**: Automated test and build pipelines (e.g. GitHub Actions / Jenkins).
- **Security Scanning**: Static analysis, secret detection, and vulnerability audit.
- **Container Registry**: Packaging and version tagging.
- **Kubernetes Deployment**: Declarative Deployments, Services, Ingress, and Probe configs.
- **Infrastructure as Code**: Terraform modules for cloud infrastructure (AWS).
- **Observability**: Metrics, log aggregation, and alerting (Prometheus & Grafana).
- **Self-Healing & Auto-Scaling**: HPA scaling policies and restart mechanisms based on probe health.
- **Cost Optimization & Chaos Engineering**: Dynamic resource rightsizing and resilience testing.
