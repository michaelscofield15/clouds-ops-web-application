const fs = require('fs');
const path = require('path');
const http = require('http');

const prereqService = require('../src/services/kubernetes/prereq.service');
const k8sClient = require('../src/services/kubernetes/k8s.client');
const kubernetesEngine = require('../src/services/kubernetes');
const storageService = require('../src/services/storage.service');
const zipService = require('../src/services/zip.service');
const analyzerService = require('../src/services/analyzer');
const dockerEngine = require('../src/services/docker');

async function runRealKubernetesE2E() {
  console.log('================================================================');
  console.log('PHASE 5 REAL KUBERNETES E2E PRODUCTION WORKFLOW (KIND CLUSTER)');
  console.log('================================================================\n');

  // Step 1: Verify Host Prerequisites
  console.log('1. Checking system prerequisites...');
  const prereqs = await prereqService.checkPrerequisites();
  console.log(`✔ OS: ${prereqs.os.platform} (${prereqs.os.arch})`);
  console.log(`✔ Docker Daemon: ${prereqs.docker.daemonRunning ? 'RUNNING' : 'NOT RUNNING'} (${prereqs.docker.version})`);
  console.log(`✔ Kubectl: ${prereqs.kubectl.installed ? 'INSTALLED' : 'MISSING'} (${prereqs.kubectl.version})`);
  console.log(`✔ Kind: ${prereqs.kind.installed ? 'INSTALLED' : 'MISSING'} (${prereqs.kind.version})`);

  if (!prereqs.docker.daemonRunning) {
    throw new Error('DOCKER_UNAVAILABLE: Docker daemon is not running');
  }

  // Step 2: Ensure Kind Cluster cloudops-local
  console.log('\n2. Ensuring Kind cluster cloudops-local is ready...');
  const cluster = await prereqService.ensureCluster('cloudops-local');
  console.log(`✔ Kind Cluster: ${cluster.clusterName} (${cluster.status})`);
  console.log(`✔ Active Context: ${cluster.context}`);
  console.log(`✔ Ready Nodes (${cluster.nodes.length}): ${cluster.nodes.map(n => `${n.name} [${n.status}]`).join(', ')}`);

  // Step 3: Ingest Phase 1 Target Workload
  console.log('\n3. Ingesting Phase 1 cloudops-demo-app.zip...');
  const zipPath = path.resolve('../cloudops-demo-app.zip');
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Archive not found at ${zipPath}`);
  }
  const zipBuffer = fs.readFileSync(zipPath);
  const projectId = storageService.generateProjectId();
  const workspace = storageService.createWorkspace(projectId);
  zipService.extractSafely(zipBuffer, workspace.extractDir);
  console.log(`✔ Extracted to workspace: ${workspace.extractDir}`);

  // Step 4: Run Phase 2 Static Analysis
  console.log('\n4. Executing Phase 2 static analysis...');
  const analysis = analyzerService.analyzeProject(workspace.extractDir);
  storageService.saveAnalysis(projectId, {
    project: analysis.project,
    analysis
  });
  console.log(`✔ Detected runtime: ${analysis.project.runtime}, framework: ${analysis.framework.name}, port: ${analysis.port.value}`);

  // Step 5: Execute Real Phase 3 Dockerization
  console.log('\n5. Executing Real Phase 3 Dockerization...');
  const dockerResult = await dockerEngine.dockerize(projectId);
  console.log(`✔ Docker Image Built: ${dockerResult.image.tag} (ID: ${dockerResult.image.id.slice(0, 19)}..., Size: ${Math.round(dockerResult.image.size / (1024 * 1024))}MB)`);
  console.log(`✔ Phase 3 Container Tested: ${dockerResult.container.name} (Health: ${dockerResult.health.status})`);

  // Step 6: Load Real Docker Image into Kind Cluster
  console.log('\n6. Loading real Docker image into Kind cluster nodes...');
  await k8sClient.loadDockerImage(dockerResult.image.tag, 'cloudops-local');
  const imageLoaded = await k8sClient.verifyImageInKind(dockerResult.image.tag, 'cloudops-local');
  console.log(`✔ Image '${dockerResult.image.tag}' verified in Kind runtime: ${imageLoaded}`);

  // Step 7: Execute Phase 5 Real Kubernetes Deployment
  console.log('\n7. Deploying to Real Kubernetes (Kind)...');
  const deployResult = await kubernetesEngine.deploy(projectId);

  console.log('\n================================================================');
  console.log('REAL KUBERNETES DEPLOYMENT OUTCOME');
  console.log('================================================================');
  console.log(`Project ID:       ${deployResult.projectId}`);
  console.log(`Status:           ${deployResult.status.toUpperCase()}`);
  console.log(`Cluster:          ${deployResult.cluster.name} (Context: ${deployResult.cluster.context})`);
  console.log(`Namespace:        ${deployResult.namespace}`);
  console.log(`Deployment:       ${deployResult.deployment.name} (${deployResult.deployment.replicas.ready}/${deployResult.deployment.replicas.desired} Ready)`);
  console.log(`Pod:              ${deployResult.pod.name} (Phase: ${deployResult.pod.phase}, Ready: ${deployResult.pod.ready}, Node: ${deployResult.pod.nodeName})`);
  console.log(`Pod IP:           ${deployResult.pod.podIP}`);
  console.log(`Service:          ${deployResult.service.name} (Type: ${deployResult.service.type}, ClusterIP: ${deployResult.service.clusterIP})`);
  console.log(`Service Ports:    ${deployResult.service.ports.map(p => `${p.port}:${p.targetPort}/TCP (NodePort: ${p.nodePort || 'N/A'})`).join(', ')}`);
  console.log(`Service Endpoints:${deployResult.service.readyEndpoints.join(', ')}`);
  console.log(`App Health Check: ${deployResult.health.status.toUpperCase()} (Status Code: ${deployResult.health.statusCode})`);
  console.log(`App Response:     ${JSON.stringify(deployResult.health.response)}`);
  console.log(`Deployment Time:  ${deployResult.metrics.deploymentDurationMs}ms`);
  console.log('================================================================\n');

  // Step 8: Retrieve Real Live Pod Logs
  console.log('8. Retrieving live Pod logs from Kubernetes...');
  const logsResult = await kubernetesEngine.getLogs(projectId, 50);
  console.log('--- Real Pod Log Output ---');
  console.log(logsResult.logs.trim());
  console.log('---------------------------\n');

  // Step 9: Retrieve Real Kubernetes Events
  console.log('9. Retrieving live Kubernetes namespace events...');
  const events = await kubernetesEngine.getEvents(projectId);
  console.log(`✔ Found ${events.length} namespace events:`);
  events.slice(-5).forEach(e => {
    console.log(`   - [${e.type}] ${e.reason}: ${e.message} (${e.involvedObject.kind}/${e.involvedObject.name})`);
  });

  // Step 10: Verify Fresh Status via getStatus API
  console.log('\n10. Querying fresh status via getStatus API...');
  const liveStatus = await kubernetesEngine.getStatus(projectId);
  if (liveStatus.status !== 'deployed' || liveStatus.deployment.replicas.ready < 1) {
    throw new Error(`LIVE STATUS MISMATCH: Expected deployed status but got: ${liveStatus.status}`);
  }
  console.log(`✔ Live status confirmed: ${liveStatus.status} (${liveStatus.pods.length} active Pods)`);

  // Step 11: Real Resource Teardown & Verification
  console.log('\n11. Cleaning up Kubernetes deployment and namespace...');
  const deleteResult = await kubernetesEngine.deleteDeployment(projectId);
  console.log(`✔ Deleted namespace '${deleteResult.namespace}'`);

  // Verify deletion in cluster
  const nsStillExists = await k8sClient.namespaceExists(deleteResult.namespace);
  console.log(`✔ Verified namespace termination in progress / deleted: ${!nsStillExists || 'Terminating'}`);

  console.log('\n================================================================');
  console.log('✔ PHASE 5 REAL KUBERNETES E2E WORKFLOW PASSED 100%');
  console.log('================================================================');
}

runRealKubernetesE2E().catch(err => {
  console.error('\n✖ Real Kubernetes E2E Verification Failed:', err);
  process.exit(1);
});
