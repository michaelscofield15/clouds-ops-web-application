/**
 * Confidence levels for deployment decisions
 */
const CONFIDENCE_LEVELS = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
};

class DeploymentPlanner {
  /**
   * Generates a structured, explainable deployment plan based on real project analysis and requirements.
   * @param {object} analysis Project analysis from Phase 2
   * @param {object} requirements Evaluated requirements matrix
   * @param {object} options Custom deployment options (e.g. region, compute preference)
   * @returns {object} Structured deployment plan with explainable decisions and ordered stages
   */
  generatePlan(analysis = {}, requirements = {}, options = {}) {
    let effectiveAnalysis = analysis;
    let effectiveRequirements = requirements;
    let effectiveOptions = options;

    if (analysis && analysis.analysis && typeof analysis.analysis === 'object') {
      effectiveAnalysis = analysis.analysis;
      effectiveRequirements = analysis.requirements || requirements || {};
      effectiveOptions = analysis.options || options || {};
    }

    const projectId = effectiveAnalysis.projectId || effectiveOptions.projectId || 'unassigned';
    const projectName = effectiveAnalysis.project?.name || 'cloudops-app';
    const runtime = effectiveAnalysis.project?.runtime || 'Node.js';
    const framework = effectiveAnalysis.framework?.name || 'Standard';
    const port = effectiveAnalysis.port?.value || 3000;
    const region = effectiveOptions.region || 'ap-south-1';

    const hasK8s = Boolean(effectiveAnalysis.devops?.kubernetes?.hasManifests);
    const hasDocker = Boolean(effectiveAnalysis.devops?.docker?.hasDockerfile);
    const userComputePreference = effectiveOptions.computeTarget; // 'EC2' or 'EKS'

    // 1. Determine Compute Target Decision
    let computeTarget = 'AWS_EC2';
    let computeReason = '';
    let computeEvidence = '';
    let computeConfidence = CONFIDENCE_LEVELS.HIGH;

    if (userComputePreference === 'EKS' || (hasK8s && userComputePreference !== 'EC2')) {
      computeTarget = 'AWS_EKS';
      computeReason = 'Kubernetes manifests detected in uploaded project repository.';
      computeEvidence = `Found Kubernetes deployment manifests in project files (hasManifests: ${hasK8s})`;
      computeConfidence = hasK8s ? CONFIDENCE_LEVELS.HIGH : CONFIDENCE_LEVELS.MEDIUM;
    } else {
      computeTarget = 'AWS_EC2';
      computeReason = 'Single-service container application without multi-pod Kubernetes requirements.';
      computeEvidence = `Standard web runtime (${runtime} / ${framework}) targeting port ${port}`;
      computeConfidence = CONFIDENCE_LEVELS.HIGH;
    }

    // 2. Compile Explainable Decisions Matrix
    const decisions = [
      {
        category: 'COMPUTE_TARGET',
        decision: computeTarget === 'AWS_EC2' ? 'AWS EC2 + Docker' : 'AWS EKS + Kubernetes',
        reason: computeReason,
        evidence: computeEvidence,
        confidence: computeConfidence
      },
      {
        category: 'CONTAINER_ENGINE',
        decision: hasDocker ? 'Custom User Dockerfile' : 'Automated Multi-Stage Dockerfile Generation',
        reason: hasDocker ? 'Existing Dockerfile found in project root.' : `Generated optimized multi-stage build for ${runtime}.`,
        evidence: hasDocker ? 'Dockerfile found in extracted archive' : `Package manager: ${analysis.packageManager || 'npm'}, runtime: ${runtime}`,
        confidence: CONFIDENCE_LEVELS.HIGH
      },
      {
        category: 'CONTAINER_REGISTRY',
        decision: 'AWS Elastic Container Registry (ECR)',
        reason: 'Native secure registry with direct IAM authentication and high-speed VPC pulling.',
        evidence: `Target AWS Region: ${region}`,
        confidence: CONFIDENCE_LEVELS.HIGH
      },
      {
        category: 'INFRASTRUCTURE_AS_CODE',
        decision: 'Terraform IaC Engine (Phase 8)',
        reason: 'Automated state-locked HCL generation for VPC, Subnets, Security Groups, IAM Roles, ECR, and EC2.',
        evidence: 'Phase 8 Terraform Engine verified in region',
        confidence: CONFIDENCE_LEVELS.HIGH
      },
      {
        category: 'REMOTE_MANAGEMENT',
        decision: 'AWS Systems Manager (SSM) Run Command',
        reason: 'Zero SSH key exposure, encrypted agent-based deployment and metric probing.',
        evidence: 'Amazon Linux 2023 SSM agent integration',
        confidence: CONFIDENCE_LEVELS.HIGH
      },
      {
        category: 'OBSERVABILITY_AND_SELF_HEALING',
        decision: 'Active CloudWatch, OS Probes, and Policy-Driven Self-Healing (Phases 7 & 9)',
        reason: 'Continuous health monitoring with automated SSM restart and rollback circuit breakers.',
        evidence: 'Integrated monitoring worker and safety policy matrix',
        confidence: CONFIDENCE_LEVELS.HIGH
      }
    ];

    // 3. Define Ordered Execution Stages
    const stages = [
      {
        order: 1,
        id: 'STAGE_DOCKERIZE',
        name: 'Automated Dockerization',
        engine: 'Phase 3 Docker Engine',
        description: 'Generate multi-stage Dockerfile and build isolated local container image',
        status: 'PENDING',
        estimatedSeconds: 25
      },
      {
        order: 2,
        id: 'STAGE_SOURCE_CONTROL',
        name: 'GitHub Source Automation',
        engine: 'Phase 4 GitHub Engine',
        description: 'Sanitize secrets and push versioned project source to GitHub repository',
        status: 'PENDING',
        estimatedSeconds: 10
      },
      {
        order: 3,
        id: 'STAGE_CI_CD',
        name: 'Jenkins CI/CD Pipeline',
        engine: 'Phase 4 Jenkins Engine',
        description: 'Create and trigger declarative Jenkins pipeline job with live log telemetry',
        status: 'PENDING',
        estimatedSeconds: 20
      },
      {
        order: 4,
        id: 'STAGE_TERRAFORM_IAC',
        name: 'Terraform Infrastructure Provisioning',
        engine: 'Phase 8 Terraform Engine',
        description: 'Generate HCL, initialize state, evaluate plan safety, and apply AWS cloud infrastructure',
        status: 'PENDING',
        estimatedSeconds: 30
      },
      {
        order: 5,
        id: 'STAGE_AWS_DEPLOYMENT',
        name: 'AWS Cloud Deployment',
        engine: 'Phase 6 AWS Deployment Engine',
        description: 'Push image to AWS ECR and deploy active container via SSM Run Command',
        status: 'PENDING',
        estimatedSeconds: 25
      },
      {
        order: 6,
        id: 'STAGE_HEALTH_VERIFICATION',
        name: 'Real-Time Health Verification',
        engine: 'Health Probe Service',
        description: 'Execute live HTTP probes and verify container runtime health (HTTP 200 required)',
        status: 'PENDING',
        estimatedSeconds: 15
      },
      {
        order: 7,
        id: 'STAGE_MONITORING_HANDOFF',
        name: 'Observability & Monitoring Registration',
        engine: 'Phase 7 Monitoring Engine',
        description: 'Register deployed workload with active metrics collection and alerting worker',
        status: 'PENDING',
        estimatedSeconds: 5
      },
      {
        order: 8,
        id: 'STAGE_SELF_HEALING_HANDOFF',
        name: 'Self-Healing Engine Registration',
        engine: 'Phase 9 Self-Healing Engine',
        description: 'Register automated recovery policies, cooldowns, and rollback hooks',
        status: 'PENDING',
        estimatedSeconds: 5
      }
    ];

    const planId = `plan-${Date.now().toString().slice(-6)}-${projectId.slice(0, 6)}`;

    return {
      planId,
      projectId,
      projectName,
      runtime,
      framework,
      port,
      region,
      computeTarget,
      generatedAt: new Date().toISOString(),
      decisions,
      stages,
      totalStages: stages.length,
      estimatedTotalSeconds: stages.reduce((acc, s) => acc + s.estimatedSeconds, 0)
    };
  }
}

module.exports = new DeploymentPlanner();
module.exports.DeploymentPlanner = DeploymentPlanner;
module.exports.CONFIDENCE_LEVELS = CONFIDENCE_LEVELS;
