# Phase 5 — Real Kubernetes Automation Engine Documentation

## 1. Architecture Overview

The **Phase 5 Real Kubernetes Automation Engine** is a fully automated, production-grade Kubernetes orchestration module built inside the Autonomous DevOps & CloudOps Platform. It converts analyzed and dockerized applications (from Phases 2 & 3) into live running Kubernetes Deployments and Services on a local **Kind (Kubernetes IN Docker)** cluster without requiring manual `kubectl` commands, third-party cloud costs, or fake/simulated data.

```
┌────────────────────────┐
│  Phase 2 App Analyzer  │──► Port: 3000, Runtime: Node.js, Health: /health
└───────────┬────────────┘
            │
┌───────────▼────────────┐
│  Phase 3 Docker Engine │──► Image: cloudops/cloudops-demo-app:build-363a59b9
└───────────┬────────────┘
            │
┌───────────▼───────────────────────────────────────────────────────────────┐
│                 Phase 5 Kubernetes Automation Engine                      │
├───────────────────────────────────────────────────────────────────────────┤
│ 1. Host Prerequisite Scan: Docker, Kubectl, Kind, Homebrew                │
│ 2. Kind Cluster Provisioning & Node Verification (`cloudops-local`)       │
│ 3. Docker Image Loading (`kind load docker-image ...`)                    │
│ 4. Manifest Generation: DNS-1123 Names, Deployment & Service YAML         │
│ 5. Safe Manifest Application (`kubectl apply`) & Rollout Tracking         │
│ 6. Pod Readiness Inspection & Service Endpoint Resolution                 │
│ 7. Dynamic Port-Forward HTTP Live Health Probe Verification               │
│ 8. Real-time Pod Log Streaming & Namespace Event Aggregation              │
│ 9. Teardown Lifecycle Management (`DELETE /api/projects/:id/kubernetes`)  │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Engine Components

All Phase 5 source code resides in [`platform-service/src/services/kubernetes/`](file:///Users/michael/Desktop/Devops%20project/platform-service/src/services/kubernetes/):

| Component | Path | Responsibility |
|---|---|---|
| **K8s Safe Client** | [`k8s.client.js`](file:///Users/michael/Desktop/Devops%20project/platform-service/src/services/kubernetes/k8s.client.js) | Safe `spawn`/`execFile` child process execution wrapper for `kubectl` and `kind` CLI operations with argument arrays, timeouts, and structured JSON parsing. |
| **Prerequisite Service** | [`prereq.service.js`](file:///Users/michael/Desktop/Devops%20project/platform-service/src/services/kubernetes/prereq.service.js) | Comprehensive system scan for OS, Docker daemon, `kubectl`, `kind`, Homebrew, active cluster context, and automated Kind cluster creation. |
| **Manifest Generator** | [`manifest.generator.js`](file:///Users/michael/Desktop/Devops%20project/platform-service/src/services/kubernetes/manifest.generator.js) | Dynamic DNS-1123 compliant generator producing production-grade Kubernetes Deployment and NodePort Service YAML manifests with readiness/liveness probes and security contexts. |
| **Kubernetes Engine** | [`index.js`](file:///Users/michael/Desktop/Devops%20project/platform-service/src/services/kubernetes/index.js) | Main orchestrator managing the full deployment lifecycle, rollout waiting, live Pod discovery, HTTP health check verification, logs, events, and teardown. |

---

## 3. REST API Reference

### Global Cluster Endpoints
- **`GET /api/kubernetes/status`**
  - Evaluates system prerequisites, Docker daemon status, `kubectl`, `kind`, and local Kind cluster health.
  - **Response 200**:
    ```json
    {
      "os": { "platform": "darwin", "arch": "arm64" },
      "docker": { "installed": true, "daemonRunning": true, "version": "Docker version 29.7.2..." },
      "kubectl": { "installed": true, "version": "v1.36.1" },
      "kind": { "installed": true, "version": "kind v0.32.0..." },
      "homebrew": { "installed": true },
      "kubernetes": { "clusterExists": true, "clusterName": "cloudops-local", "nodesReady": true, "nodeCount": 1 },
      "allReady": true
    }
    ```
- **`POST /api/kubernetes/cluster`**
  - Ensures the local Kind cluster `cloudops-local` is running. If missing, automatically creates it and verifies node readiness.

### Project Deployment Endpoints
- **`POST /api/projects/:projectId/kubernetes/deploy`**
  - Deploys the project's Docker image into an isolated namespace (`cloudops-<projectId>`), tracks rollout, and probes the running Pod's `/health` endpoint.
- **`GET /api/projects/:projectId/kubernetes/status`**
  - Returns live deployment status, Pod condition, Service NodePort/ClusterIP, and health probe results.
- **`GET /api/projects/:projectId/kubernetes/pods`**
  - Returns real-time Pod list with Pod name, phase (`Running`), ready condition, restart count, node name, and pod IP.
- **`GET /api/projects/:projectId/kubernetes/service`**
  - Returns Kubernetes Service details, port mappings (NodePort, targetPort), and registered Endpoint IPs.
- **`GET /api/projects/:projectId/kubernetes/logs`**
  - Retrieves live container stdout/stderr logs directly from the active Pod via `kubectl logs`.
- **`GET /api/projects/:projectId/kubernetes/events`**
  - Returns chronological Kubernetes events (`ScalingReplicaSet`, `Pulled`, `Created`, `Started`) from the project namespace.
- **`DELETE /api/projects/:projectId/kubernetes`**
  - Safely tears down the Deployment, Service, and Namespace in the local Kind cluster.

---

## 4. Verification and Test Results

### 1. Automated Test Suite (`npm test`)
Ran across all 4 platform engines:
- **`analyzer.test.js`**: 11/11 tests passed (Validation, extraction, stack detection, secret scan).
- **`docker.test.js`**: 8/8 tests passed (Docker availability, Dockerfile generation, live image build, container health check, broken Dockerfile recovery).
- **`cicd.test.js`**: 14/14 tests passed (GitHub auth, secret blocker, declarative Jenkinsfile generator, safe Git engine, real Jenkins REST API integration).
- **`kubernetes.test.js`**: 9/9 tests passed (Prerequisite detection, DNS-1123 sanitization, manifest generation, error gates, live Kind cluster queries).
- **Result**: `4/4 Suites Passed (0 Failures)`.

### 2. Real Kubernetes E2E Production Test (`npm run test:k8s`)
Executed real end-to-end workflow on local Kind cluster `cloudops-local`:
- **Docker Image Built**: `cloudops/cloudops-demo-app:build-363a59b9`
- **Loaded into Kind Nodes**: Verified in `kind-cloudops-local` runtime.
- **Namespace Created**: `cloudops-363a59b9-d1b`
- **Pod Status**: `cloudops-app-363a59b9-d1b-d6567bb75-6ctct` — Phase: `Running`, Ready: `true`, IP: `10.244.0.6`
- **Service**: NodePort `31194`, ClusterIP `10.96.94.221`
- **Application Health Check**: HTTP `200 OK` — `{"status":"healthy","service":"cloudops-demo-app","timestamp":"2026-08-22T19:28:21.521Z"}`
- **Pod Logs & Events**: Retrieved 6 real Kubernetes lifecycle events and active container logs.
- **Teardown**: Namespace and deployment cleanly deleted.
- **Result**: `✔ PHASE 5 REAL KUBERNETES E2E WORKFLOW PASSED 100%`.
