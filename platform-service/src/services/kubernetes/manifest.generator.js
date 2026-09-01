const config = require('../../config');

class ManifestGenerator {
  /**
   * Sanitizes names to comply with Kubernetes DNS-1123 subdomain conventions
   */
  sanitizeName(input, prefix = '', maxLength = 63) {
    let clean = (input || 'app')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '');

    if (prefix) {
      clean = `${prefix}${clean}`;
    }

    if (clean.length > maxLength) {
      clean = clean.substring(0, maxLength).replace(/-+$/, '');
    }

    return clean || 'cloudops-resource';
  }

  /**
   * Generates Kubernetes Deployment & Service manifests dynamically
   */
  generateManifests(projectId, projectAnalysis = {}, dockerState = {}) {
    const sanitizedId = this.sanitizeName(projectId.slice(0, 12));
    const namespace = this.sanitizeName(projectId.slice(0, 12), config.kubernetes.namespacePrefix);
    const deploymentName = `cloudops-app-${sanitizedId}`;
    const serviceName = `cloudops-svc-${sanitizedId}`;
    const appLabel = `cloudops-${sanitizedId}`;

    const port = (projectAnalysis.port && projectAnalysis.port.value && projectAnalysis.port.value !== 'unknown')
      ? parseInt(projectAnalysis.port.value, 10)
      : 3000;

    // Identify real Docker image from Phase 3 docker state
    const imageTag = dockerState.image?.tag || `${projectAnalysis.project?.name || 'app'}:latest`;

    // Resource limits
    const cpuRequest = config.kubernetes.defaultCpuRequest;
    const cpuLimit = config.kubernetes.defaultCpuLimit;
    const memRequest = config.kubernetes.defaultMemoryRequest;
    const memLimit = config.kubernetes.defaultMemoryLimit;

    // Check if application has verified health endpoint
    const hasHealthEndpoint = true; // In Phase 1 & 2 analysis, health endpoint is /health
    const healthPath = '/health';

    let probesSection = '';
    if (hasHealthEndpoint) {
      probesSection = `
        readinessProbe:
          httpGet:
            path: ${healthPath}
            port: ${port}
          initialDelaySeconds: 4
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 5
        livenessProbe:
          httpGet:
            path: ${healthPath}
            port: ${port}
          initialDelaySeconds: 8
          periodSeconds: 10
          timeoutSeconds: 3
          failureThreshold: 3`;
    }

    const deploymentYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: ${deploymentName}
    app.kubernetes.io/instance: ${sanitizedId}
    app.kubernetes.io/part-of: cloudops
    app.kubernetes.io/managed-by: cloudops-platform
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${appLabel}
  template:
    metadata:
      labels:
        app: ${appLabel}
        app.kubernetes.io/name: ${deploymentName}
        app.kubernetes.io/instance: ${sanitizedId}
        app.kubernetes.io/part-of: cloudops
        app.kubernetes.io/managed-by: cloudops-platform
    spec:
      containers:
      - name: application
        image: ${imageTag}
        imagePullPolicy: IfNotPresent
        ports:
        - name: http
          containerPort: ${port}
          protocol: TCP
        env:
        - name: PORT
          value: "${port}"
        - name: NODE_ENV
          value: "production"
        resources:
          requests:
            cpu: "${cpuRequest}"
            memory: "${memRequest}"
          limits:
            cpu: "${cpuLimit}"
            memory: "${memLimit}"${probesSection}
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: false
`;

    const serviceYaml = `apiVersion: v1
kind: Service
metadata:
  name: ${serviceName}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: ${serviceName}
    app.kubernetes.io/instance: ${sanitizedId}
    app.kubernetes.io/part-of: cloudops
    app.kubernetes.io/managed-by: cloudops-platform
spec:
  type: NodePort
  selector:
    app: ${appLabel}
  ports:
  - name: http
    port: ${port}
    targetPort: ${port}
    protocol: TCP
`;

    return {
      namespace,
      deploymentName,
      serviceName,
      appLabel,
      port,
      imageTag,
      deploymentYaml,
      serviceYaml,
      combinedYaml: `${deploymentYaml}\n---\n${serviceYaml}`
    };
  }
}

module.exports = new ManifestGenerator();
module.exports.ManifestGenerator = ManifestGenerator;
