const terraformClient = require('./terraform.client');
const terraformGenerator = require('./terraform.generator');
const terraformPlanParser = require('./terraform.plan.parser');
const terraformStateService = require('./terraform.state.service');
const terraformAdoptionService = require('./terraform.adoption.service');
const storageService = require('../storage.service');
const ec2Service = require('../aws/ec2.service');
const ecrService = require('../aws/ecr.service');
const ssmService = require('../aws/ssm.service');
const awsClient = require('../aws/aws.client');
const config = require('../../config');

/**
 * Real Terraform Infrastructure-as-Code Engine.
 * Orchestrates Terraform configuration generation, lifecycle commands, destroy safety gating,
 * state persistence, and independent AWS verification.
 */
class TerraformEngine {
  constructor() {
    this.client = terraformClient;
    this.generator = terraformGenerator;
    this.parser = terraformPlanParser;
    this.stateService = terraformStateService;
    this.adoptionService = terraformAdoptionService;
  }

  /**
   * Checks Terraform CLI and AWS STS prerequisites
   */
  async checkPrerequisites() {
    return this.client.checkPrerequisites();
  }

  /**
   * Generates Terraform configuration files from project requirements
   */
  async generateConfiguration(projectId, customOptions = {}) {
    const project = storageService.getProject(projectId);
    if (!project) {
      const err = new Error(`Project '${projectId}' not found`);
      err.statusCode = 404;
      throw err;
    }

    const analysis = project.analysis || project;
    const workspaceDir = this.stateService.getWorkspaceDir(projectId);

    this.stateService.addLog(projectId, 'Generating dynamic Terraform configuration...');
    const result = this.generator.generate(workspaceDir, analysis, {
      projectId,
      ...customOptions
    });

    this.stateService.saveState(projectId, {
      status: 'GENERATED',
      workspaceDir,
      files: result.filesGenerated,
      options: customOptions
    });

    this.stateService.addLog(
      projectId,
      `Generated ${result.filesGenerated.length} Terraform files in ${workspaceDir}`
    );

    return result;
  }

  /**
   * Alias for generateConfiguration
   */
  async generate(projectId, customOptions = {}) {
    return this.generateConfiguration(projectId, customOptions);
  }

  /**
   * Runs `terraform init`
   */
  async init(projectId, options = {}) {
    const state = this.stateService.getState(projectId);
    const workspaceDir = state.workspaceDir || this.stateService.getWorkspaceDir(projectId);

    // Auto-generate configuration if not yet created
    if (state.status === 'NOT_INITIALIZED') {
      await this.generateConfiguration(projectId, options);
    }

    this.client.acquireLock(projectId);
    try {
      this.stateService.startOperation(projectId, 'INIT');
      const result = await this.client.init(workspaceDir, {
        ...options,
        onData: (chunk) => this.stateService.addLog(projectId, chunk)
      });

      this.stateService.completeOperation(projectId, result);
      this.stateService.saveState(projectId, { status: 'INITIALIZED' });
      return {
        success: true,
        status: 'INITIALIZED',
        stdout: result.stdout,
        durationMs: result.durationMs
      };
    } catch (err) {
      this.stateService.failOperation(projectId, err);
      throw err;
    } finally {
      this.client.releaseLock(projectId);
    }
  }

  /**
   * Runs `terraform validate`
   */
  async validate(projectId, options = {}) {
    const state = this.stateService.getState(projectId);
    const workspaceDir = state.workspaceDir || this.stateService.getWorkspaceDir(projectId);

    this.client.acquireLock(projectId);
    try {
      this.stateService.startOperation(projectId, 'VALIDATE');
      const result = await this.client.validate(workspaceDir, {
        ...options,
        onData: (chunk) => this.stateService.addLog(projectId, chunk)
      });

      if (!result.isValid) {
        const validationErr = new Error(`Terraform validation failed with ${result.errorCount} error(s).`);
        validationErr.diagnostics = result.diagnostics;
        this.stateService.failOperation(projectId, validationErr);
        throw validationErr;
      }

      this.stateService.completeOperation(projectId, result);
      this.stateService.saveState(projectId, { status: 'VALIDATED' });
      return {
        success: true,
        isValid: true,
        status: 'VALIDATED',
        durationMs: result.durationMs
      };
    } catch (err) {
      this.stateService.failOperation(projectId, err);
      throw err;
    } finally {
      this.client.releaseLock(projectId);
    }
  }

  /**
   * Runs `terraform plan` and parses structured change summary
   */
  async plan(projectId, options = {}) {
    const state = this.stateService.getState(projectId);
    const workspaceDir = state.workspaceDir || this.stateService.getWorkspaceDir(projectId);

    this.client.acquireLock(projectId);
    try {
      this.stateService.startOperation(projectId, 'PLAN');
      const result = await this.client.plan(workspaceDir, {
        ...options,
        onData: (chunk) => this.stateService.addLog(projectId, chunk)
      });

      // Parse JSON plan
      let planSummary;
      try {
        const planJson = await this.client.showJson(workspaceDir, 'tfplan');
        planSummary = this.parser.parseJsonPlan(planJson);
      } catch {
        planSummary = this.parser.parseTextPlan(result.stdout);
      }

      this.stateService.completeOperation(projectId, result);
      this.stateService.saveState(projectId, {
        status: 'PLANNED',
        plan: planSummary
      });

      return {
        success: true,
        status: 'PLANNED',
        plan: planSummary,
        stdout: result.stdout,
        durationMs: result.durationMs
      };
    } catch (err) {
      this.stateService.failOperation(projectId, err);
      throw err;
    } finally {
      this.client.releaseLock(projectId);
    }
  }

  /**
   * Runs `terraform apply` with destroy safety gating and independent AWS verification
   */
  async apply(projectId, options = {}) {
    const state = this.stateService.getState(projectId);
    const workspaceDir = state.workspaceDir || this.stateService.getWorkspaceDir(projectId);

    // Destructive Safety Gate
    if (state.plan && state.plan.isDestructive && options.confirmDestroy !== true) {
      const err = new Error(
        `Safety Alert: Terraform plan contains ${state.plan.toDestroy} destructive action(s). Explicit confirmation (confirmDestroy: true) is required.`
      );
      err.statusCode = 400;
      err.isDestructive = true;
      err.plan = state.plan;
      throw err;
    }

    this.client.acquireLock(projectId);
    try {
      this.stateService.startOperation(projectId, 'APPLY');
      this.stateService.addLog(projectId, 'Executing real terraform apply...');

      const result = await this.client.apply(workspaceDir, {
        ...options,
        onData: (chunk) => this.stateService.addLog(projectId, chunk)
      });

      // Retrieve outputs
      const outputs = await this.client.output(workspaceDir);
      this.stateService.addLog(projectId, 'Retrieved Terraform outputs. Running independent AWS verification...');

      // Independent AWS Resource Verification
      const verification = await this.verifyInfrastructure(projectId, outputs, options.region);

      this.stateService.completeOperation(projectId, result);
      this.stateService.saveState(projectId, {
        status: verification.verified ? 'APPLIED' : 'FAILED_VERIFICATION',
        outputs,
        verification
      });

      return {
        success: verification.verified,
        status: verification.verified ? 'APPLIED' : 'FAILED_VERIFICATION',
        outputs,
        verification,
        stdout: result.stdout,
        durationMs: result.durationMs
      };
    } catch (err) {
      this.stateService.failOperation(projectId, err);
      throw err;
    } finally {
      this.client.releaseLock(projectId);
    }
  }

  /**
   * Independently verifies provisioned AWS resources against AWS APIs
   */
  async verifyInfrastructure(projectId, outputs = {}, region = 'ap-south-1') {
    const verification = {
      verified: true,
      timestamp: new Date().toISOString(),
      checks: {}
    };

    // 1. Verify ECR repository
    if (outputs.ecr_repository_name) {
      try {
        const repo = await ecrService.describeRepository(outputs.ecr_repository_name, region);
        verification.checks.ecr = {
          status: 'VERIFIED',
          repositoryUri: repo.repositoryUri,
          createdAt: repo.createdAt
        };
      } catch (err) {
        verification.checks.ecr = { status: 'FAILED', error: err.message };
        verification.verified = false;
      }
    }

    // 2. Verify EC2 instance
    if (outputs.ec2_instance_id) {
      try {
        const inst = await ec2Service.getInstanceDetails(outputs.ec2_instance_id, region);
        verification.checks.ec2 = {
          status: 'VERIFIED',
          instanceId: inst.instanceId,
          state: inst.state,
          publicIp: inst.publicIp,
          instanceType: inst.instanceType
        };
      } catch (err) {
        verification.checks.ec2 = { status: 'FAILED', error: err.message };
        verification.verified = false;
      }
    }

    // 3. Verify SSM agent
    if (outputs.ec2_instance_id) {
      try {
        const ssmInfo = await ssmService.getInstanceInformation(outputs.ec2_instance_id, region);
        verification.checks.ssm = {
          status: ssmInfo.isOnline ? 'VERIFIED' : 'OFFLINE',
          pingStatus: ssmInfo.pingStatus,
          agentVersion: ssmInfo.agentVersion
        };
      } catch (err) {
        verification.checks.ssm = { status: 'FAILED', error: err.message };
      }
    }

    return verification;
  }

  /**
   * Runs `terraform destroy` with explicit confirmation
   */
  async destroy(projectId, options = {}) {
    if (options.confirmDestroy !== true) {
      const err = new Error(
        'Destruction blocked: terraform destroy requires explicit confirmation (confirmDestroy: true).'
      );
      err.statusCode = 400;
      throw err;
    }

    const state = this.stateService.getState(projectId);
    const workspaceDir = state.workspaceDir || this.stateService.getWorkspaceDir(projectId);

    this.client.acquireLock(projectId);
    try {
      this.stateService.startOperation(projectId, 'DESTROY');
      this.stateService.addLog(projectId, 'Executing terraform destroy...');

      const result = await this.client.destroy(workspaceDir, {
        ...options,
        onData: (chunk) => this.stateService.addLog(projectId, chunk)
      });

      this.stateService.completeOperation(projectId, result);
      this.stateService.saveState(projectId, {
        status: 'DESTROYED',
        outputs: null,
        plan: null
      });

      return {
        success: true,
        status: 'DESTROYED',
        stdout: result.stdout,
        durationMs: result.durationMs
      };
    } catch (err) {
      this.stateService.failOperation(projectId, err);
      throw err;
    } finally {
      this.client.releaseLock(projectId);
    }
  }

  /**
   * Retrieves current status for a project
   */
  getStatus(projectId) {
    return this.stateService.getState(projectId);
  }

  /**
   * Retrieves plan summary for a project
   */
  getPlan(projectId) {
    const state = this.stateService.getState(projectId);
    return state.plan || { summary: 'No plan generated yet' };
  }

  /**
   * Retrieves real-time logs for a project
   */
  getLogs(projectId) {
    const state = this.stateService.getState(projectId);
    return {
      projectId,
      linesCount: (state.logs || []).length,
      logs: state.logs || []
    };
  }
}

module.exports = new TerraformEngine();
module.exports.TerraformEngine = TerraformEngine;
