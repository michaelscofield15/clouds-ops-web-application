/**
 * Comprehensive 24+ Failure Categories
 */
const FAILURE_CATEGORIES = {
  INVALID_ZIP: 'INVALID_ZIP',
  UNSUPPORTED_APPLICATION: 'UNSUPPORTED_APPLICATION',
  DOCKER_BUILD_FAILURE: 'DOCKER_BUILD_FAILURE',
  GITHUB_AUTH_FAILURE: 'GITHUB_AUTH_FAILURE',
  GITHUB_PERMISSION_FAILURE: 'GITHUB_PERMISSION_FAILURE',
  JENKINS_CONNECTION_FAILURE: 'JENKINS_CONNECTION_FAILURE',
  JENKINS_BUILD_FAILURE: 'JENKINS_BUILD_FAILURE',
  TERRAFORM_VALIDATION_FAILURE: 'TERRAFORM_VALIDATION_FAILURE',
  TERRAFORM_PLAN_FAILURE: 'TERRAFORM_PLAN_FAILURE',
  TERRAFORM_PERMISSION_FAILURE: 'TERRAFORM_PERMISSION_FAILURE',
  TERRAFORM_APPLY_FAILURE: 'TERRAFORM_APPLY_FAILURE',
  AWS_PERMISSION_FAILURE: 'AWS_PERMISSION_FAILURE',
  AWS_RESOURCE_FAILURE: 'AWS_RESOURCE_FAILURE',
  ECR_FAILURE: 'ECR_FAILURE',
  EC2_FAILURE: 'EC2_FAILURE',
  SSM_FAILURE: 'SSM_FAILURE',
  EKS_FAILURE: 'EKS_FAILURE',
  KUBERNETES_FAILURE: 'KUBERNETES_FAILURE',
  APPLICATION_START_FAILURE: 'APPLICATION_START_FAILURE',
  HEALTH_CHECK_FAILURE: 'HEALTH_CHECK_FAILURE',
  ENVIRONMENT_CONFIGURATION_FAILURE: 'ENVIRONMENT_CONFIGURATION_FAILURE',
  SECRET_MISSING: 'SECRET_MISSING',
  NETWORK_FAILURE: 'NETWORK_FAILURE',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN'
};

/**
 * Remediation Decision Types
 */
const REMEDIATION_DECISIONS = {
  CAN_AUTO_FIX: 'CAN_AUTO_FIX',
  REQUIRES_USER: 'REQUIRES_USER',
  UNSAFE_TO_FIX: 'UNSAFE_TO_FIX',
  RETRYABLE: 'RETRYABLE',
  NON_RETRYABLE: 'NON_RETRYABLE'
};

class FailureAnalyzer {
  _maskSecrets(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/(AWS_SECRET_ACCESS_KEY|SECRET_KEY|PASSWORD|TOKEN|BEARER|SECRET)=([^\s\n]+)/gi, '$1=********')
      .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA****************')
      .replace(/ghp_[0-9a-zA-Z]{36}/g, 'ghp_************************************');
  }

  /**
   * Performs Root Cause Analysis (RCA) on real error, logs, and stage metadata.
   * @param {object} failureContext { stage, error, logs, exitCode, httpStatus, response }
   * @returns {object} Structured RCA Report
   */
  analyzeFailure(failureContext = {}) {
    const stage = failureContext.stage || 'UNKNOWN_STAGE';
    const err = failureContext.error || {};
    const rawMsg = err.message || (typeof err === 'string' ? err : 'Unspecified execution failure');
    const logs = this._maskSecrets(failureContext.logs || err.stdout || err.stderr || '');
    const cleanMsg = this._maskSecrets(rawMsg);

    let failureType = FAILURE_CATEGORIES.UNKNOWN;
    let rootCause = 'Unspecified error occurred during deployment execution.';
    let evidence = cleanMsg;
    let confidence = 'MEDIUM';
    let recoverable = false;
    let remediationDecision = REMEDIATION_DECISIONS.REQUIRES_USER;
    let userActionRequired = 'Inspect full logs in technical details.';

    // 1. AWS IAM & Permissions Failures
    if (/AccessDenied|UnauthorizedOperation|is not authorized to perform|User:.*is not authorized/i.test(cleanMsg) || /AccessDenied/i.test(logs)) {
      failureType = FAILURE_CATEGORIES.AWS_PERMISSION_FAILURE;
      rootCause = 'AWS IAM policy denied the requested cloud operation.';
      evidence = cleanMsg.match(/AccessDenied[^\n]*/i)?.[0] || cleanMsg.slice(0, 200);
      confidence = 'HIGH';
      recoverable = false;
      remediationDecision = REMEDIATION_DECISIONS.REQUIRES_USER;
      userActionRequired = 'Attach required EC2, ECR, or SSM policies to your AWS IAM credentials and reconnect.';
    }

    // 2. Terraform Specific Failures
    else if (stage === 'STAGE_TERRAFORM_IAC' || /terraform/i.test(stage)) {
      if (/destructive action|destroy.*safety gate/i.test(cleanMsg)) {
        failureType = FAILURE_CATEGORIES.TERRAFORM_PLAN_FAILURE;
        rootCause = 'Terraform plan contained destructive actions blocked by CloudOps safety gate.';
        evidence = cleanMsg;
        confidence = 'HIGH';
        recoverable = false;
        remediationDecision = REMEDIATION_DECISIONS.UNSAFE_TO_FIX;
        userActionRequired = 'Review the planned infrastructure changes and approve destructive replacement manually.';
      } else if (/AccessDenied|permission/i.test(cleanMsg) || /AccessDenied/i.test(logs)) {
        failureType = FAILURE_CATEGORIES.TERRAFORM_PERMISSION_FAILURE;
        rootCause = 'Terraform AWS provider received AccessDenied while creating infrastructure.';
        evidence = cleanMsg;
        confidence = 'HIGH';
        recoverable = false;
        remediationDecision = REMEDIATION_DECISIONS.REQUIRES_USER;
        userActionRequired = 'Grant required VPC, Security Group, and EC2 permissions to AWS IAM user.';
      } else if (/syntax error|parse error|invalid configuration/i.test(cleanMsg)) {
        failureType = FAILURE_CATEGORIES.TERRAFORM_VALIDATION_FAILURE;
        rootCause = 'Generated Terraform HCL configuration syntax validation error.';
        evidence = cleanMsg;
        confidence = 'HIGH';
        recoverable = false;
        remediationDecision = REMEDIATION_DECISIONS.NON_RETRYABLE;
        userActionRequired = 'Review Terraform HCL syntax and configuration variables.';
      } else {
        failureType = FAILURE_CATEGORIES.TERRAFORM_APPLY_FAILURE;
        rootCause = 'Terraform execution error during resource creation.';
        evidence = cleanMsg;
        confidence = 'MEDIUM';
        recoverable = false;
        remediationDecision = REMEDIATION_DECISIONS.REQUIRES_USER;
        userActionRequired = 'Check AWS resource limits and Terraform apply logs.';
      }
    }

    // 3. Docker Build Failures
    else if (stage === 'STAGE_DOCKERIZE' || /docker.*build/i.test(cleanMsg)) {
      failureType = FAILURE_CATEGORIES.DOCKER_BUILD_FAILURE;
      if (/npm ERR!|yarn error|pnpm: command not found|ELIFECYCLE/i.test(logs) || /npm ERR!/i.test(cleanMsg)) {
        rootCause = 'Application dependency installation or build script failed inside Docker container.';
        evidence = logs.match(/npm ERR![^\n]+/g)?.slice(0, 3).join('\n') || cleanMsg;
      } else if (/COPY failed|file not found/i.test(logs) || /COPY failed/i.test(cleanMsg)) {
        rootCause = 'Dockerfile referenced a source file not present in uploaded archive.';
        evidence = cleanMsg;
      } else {
        rootCause = 'Docker engine failed to compile container image.';
        evidence = cleanMsg;
      }
      confidence = 'HIGH';
      recoverable = false;
      remediationDecision = REMEDIATION_DECISIONS.REQUIRES_USER;
      userActionRequired = 'Ensure package.json dependencies and build scripts succeed locally without errors.';
    }

    // 4. GitHub & Git Failures
    else if (stage === 'STAGE_SOURCE_CONTROL' || /github/i.test(cleanMsg)) {
      if (/Bad credentials|401 Unauthorized|token.*invalid/i.test(cleanMsg)) {
        failureType = FAILURE_CATEGORIES.GITHUB_AUTH_FAILURE;
        rootCause = 'GitHub Personal Access Token is invalid or expired.';
        evidence = cleanMsg;
        confidence = 'HIGH';
        recoverable = false;
        remediationDecision = REMEDIATION_DECISIONS.REQUIRES_USER;
        userActionRequired = 'Reconnect GitHub account with a valid token possessing "repo" scope.';
      } else if (/403|Resource not accessible|permission denied/i.test(cleanMsg)) {
        failureType = FAILURE_CATEGORIES.GITHUB_PERMISSION_FAILURE;
        rootCause = 'GitHub token lacks permissions to create or push to the target repository.';
        evidence = cleanMsg;
        confidence = 'HIGH';
        recoverable = false;
        remediationDecision = REMEDIATION_DECISIONS.REQUIRES_USER;
        userActionRequired = 'Ensure GitHub token has full repository administration and push rights.';
      } else {
        failureType = FAILURE_CATEGORIES.GITHUB_PERMISSION_FAILURE;
        rootCause = 'GitHub API error during repository operation.';
        evidence = cleanMsg;
        confidence = 'MEDIUM';
        recoverable = false;
        remediationDecision = REMEDIATION_DECISIONS.REQUIRES_USER;
        userActionRequired = 'Check GitHub repository access settings.';
      }
    }

    // 5. Jenkins CI/CD Failures
    else if (stage === 'STAGE_CI_CD' || /jenkins/i.test(cleanMsg)) {
      if (/ECONNREFUSED|getaddrinfo ENOTFOUND|timed out/i.test(cleanMsg)) {
        failureType = FAILURE_CATEGORIES.JENKINS_CONNECTION_FAILURE;
        rootCause = 'Unable to connect to Jenkins CI server.';
        evidence = cleanMsg;
        confidence = 'HIGH';
        recoverable = true;
        remediationDecision = REMEDIATION_DECISIONS.RETRYABLE;
        userActionRequired = 'Verify that Jenkins service is running and accessible.';
      } else {
        failureType = FAILURE_CATEGORIES.JENKINS_BUILD_FAILURE;
        rootCause = 'Jenkins declarative pipeline build failed during execution.';
        evidence = cleanMsg;
        confidence = 'HIGH';
        recoverable = false;
        remediationDecision = REMEDIATION_DECISIONS.REQUIRES_USER;
        userActionRequired = 'Inspect Jenkins console output for the failed build stage.';
      }
    }

    // 6. Application Startup & Health Check Failures
    else if (stage === 'STAGE_HEALTH_VERIFICATION' || /health/i.test(stage) || /HTTP [45]\d\d|ECONNREFUSED/i.test(cleanMsg)) {
      failureType = FAILURE_CATEGORIES.HEALTH_CHECK_FAILURE;
      if (/HTTP 5\d\d/i.test(cleanMsg)) {
        rootCause = 'Application server started but crashed or returned HTTP 5xx on health check endpoint.';
        evidence = cleanMsg;
        confidence = 'HIGH';
        recoverable = true;
        remediationDecision = REMEDIATION_DECISIONS.CAN_AUTO_FIX; // Safe Phase 9 restart & re-probe
        userActionRequired = 'Check application logs for unhandled exceptions or missing runtime environment variables.';
      } else if (/ECONNREFUSED|No Response|offline/i.test(cleanMsg)) {
        rootCause = 'Application container exited immediately or did not bind to configured port.';
        evidence = cleanMsg;
        confidence = 'HIGH';
        recoverable = true;
        remediationDecision = REMEDIATION_DECISIONS.CAN_AUTO_FIX;
        userActionRequired = 'Verify application listens on process.env.PORT and starts without crashing.';
      } else {
        rootCause = 'Application health verification timed out.';
        evidence = cleanMsg;
        confidence = 'MEDIUM';
        recoverable = true;
        remediationDecision = REMEDIATION_DECISIONS.RETRYABLE;
        userActionRequired = 'Check that the /health or root HTTP route returns HTTP 200.';
      }
    }

    // 7. SSM & AWS Run Command Failures
    else if (stage === 'STAGE_AWS_DEPLOYMENT' || /ssm/i.test(cleanMsg)) {
      if (/Timed out.*Online/i.test(cleanMsg)) {
        failureType = FAILURE_CATEGORIES.SSM_FAILURE;
        rootCause = 'EC2 instance did not register with AWS Systems Manager within timeout window.';
        evidence = cleanMsg;
        confidence = 'HIGH';
        recoverable = false;
        remediationDecision = REMEDIATION_DECISIONS.REQUIRES_USER;
        userActionRequired = 'Verify EC2 IAM instance profile has AmazonSSMManagedInstanceCore policy attached.';
      } else if (/no space left on device|disk full/i.test(cleanMsg) || /no space left/i.test(logs)) {
        failureType = FAILURE_CATEGORIES.EC2_FAILURE;
        rootCause = 'Target EC2 host root filesystem is out of disk space.';
        evidence = cleanMsg;
        confidence = 'HIGH';
        recoverable = false;
        remediationDecision = REMEDIATION_DECISIONS.REQUIRES_USER;
        userActionRequired = 'Clean unused Docker images or increase EC2 EBS volume size.';
      } else {
        failureType = FAILURE_CATEGORIES.AWS_RESOURCE_FAILURE;
        rootCause = 'AWS cloud deployment command failed on target instance.';
        evidence = cleanMsg;
        confidence = 'MEDIUM';
        recoverable = false;
        remediationDecision = REMEDIATION_DECISIONS.REQUIRES_USER;
        userActionRequired = 'Inspect SSM Command logs and container status on EC2.';
      }
    }

    // 8. Timeouts & Generic Network
    else if (/ETIMEDOUT|timed out|timeout/i.test(cleanMsg)) {
      failureType = FAILURE_CATEGORIES.TIMEOUT;
      rootCause = 'Operation timed out waiting for provider response.';
      evidence = cleanMsg;
      confidence = 'HIGH';
      recoverable = true;
      remediationDecision = REMEDIATION_DECISIONS.RETRYABLE;
      userActionRequired = 'Check internet connectivity and retry the deployment stage.';
    }

    return {
      stage,
      failureType,
      rootCause,
      evidence: evidence ? evidence.slice(0, 500) : 'No evidence captured',
      confidence,
      recoverable,
      remediationDecision,
      userActionRequired,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = new FailureAnalyzer();
module.exports.FailureAnalyzer = FailureAnalyzer;
module.exports.FAILURE_CATEGORIES = FAILURE_CATEGORIES;
module.exports.REMEDIATION_DECISIONS = REMEDIATION_DECISIONS;
