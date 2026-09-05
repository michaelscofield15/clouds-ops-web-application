const path = require('path');

const config = {
  port: parseInt(process.env.PORT, 10) || 4000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || process.env.CLOUDOPS_PUBLIC_URL || 'http://localhost:4000').replace(/\/+$/, ''),
  nodeEnv: process.env.NODE_ENV || 'development',
  maxUploadSizeBytes: (parseInt(process.env.MAX_UPLOAD_SIZE_MB, 10) || 50) * 1024 * 1024,
  tempBaseDir: path.resolve(
    process.cwd(),
    process.env.TEMPORARY_DIR || 'temporary/projects'
  ),
  // Docker engine configurations
  docker: {
    buildTimeoutMs: parseInt(process.env.DOCKER_BUILD_TIMEOUT_MS, 10) || 300000,
    containerMemoryLimit: process.env.CONTAINER_MEMORY_LIMIT || '512m',
    containerCpuLimit: process.env.CONTAINER_CPU_LIMIT || '1.0',
    healthCheckTimeoutMs: parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS, 10) || 5000,
    healthCheckRetries: parseInt(process.env.HEALTH_CHECK_RETRIES, 10) || 10,
    healthCheckIntervalMs: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS, 10) || 1000
  },
  github: {
    token: process.env.GITHUB_TOKEN || '',
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    callbackUrl: process.env.GITHUB_CALLBACK_URL || 'http://localhost:4000/api/github/auth/callback'
  },
  jenkins: {
    url: (process.env.JENKINS_URL || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
    username: process.env.JENKINS_USERNAME || 'jenkins-admin',
    apiToken: process.env.JENKINS_API_TOKEN || 'password'
  },
  kubernetes: {
    enabled: process.env.KUBERNETES_ENABLED !== 'false',
    clusterName: process.env.KIND_CLUSTER_NAME || 'cloudops-local',
    contextName: process.env.KUBERNETES_CONTEXT || 'kind-cloudops-local',
    namespacePrefix: process.env.KUBERNETES_NAMESPACE_PREFIX || 'cloudops-',
    rolloutTimeoutSec: parseInt(process.env.KUBERNETES_ROLLOUT_TIMEOUT, 10) || 120,
    healthCheckTimeoutMs: parseInt(process.env.KUBERNETES_HEALTHCHECK_TIMEOUT, 10) || 5000,
    healthCheckRetries: parseInt(process.env.KUBERNETES_HEALTHCHECK_RETRIES, 10) || 15,
    healthCheckIntervalMs: parseInt(process.env.KUBERNETES_HEALTHCHECK_INTERVAL_MS, 10) || 1500,
    defaultCpuRequest: process.env.K8S_CPU_REQUEST || '100m',
    defaultCpuLimit: process.env.K8S_CPU_LIMIT || '500m',
    defaultMemoryRequest: process.env.K8S_MEM_REQUEST || '128Mi',
    defaultMemoryLimit: process.env.K8S_MEM_LIMIT || '512Mi'
  },
  aws: require('./aws'),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    callbackUrl: process.env.GOOGLE_CALLBACK_URL || `${(process.env.PUBLIC_BASE_URL || process.env.CLOUDOPS_PUBLIC_URL || 'http://localhost:4000').replace(/\/+$/, '')}/api/auth/google/callback`
  },
  mongodb: {
    uri: process.env.MONGODB_URI || '',
    dbName: process.env.MONGODB_DB_NAME || 'cloudops'
  }
};

module.exports = config;
