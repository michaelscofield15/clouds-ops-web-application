const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../../config');
const awsClient = require('../aws/aws.client');

/**
 * Real Terraform CLI Client for Autonomous DevOps & CloudOps Platform.
 * Executes genuine Terraform commands, captures live streaming output, and enforces workspace concurrency locks.
 */
class TerraformClient {
  constructor() {
    this.executablePath = this._findTerraformPath();
    this.activeLocks = new Set(); // Stores projectIds currently undergoing Terraform operations
  }

  /**
   * Discovers the terraform binary path on the host system
   */
  _findTerraformPath() {
    const candidates = [
      '/opt/homebrew/bin/terraform',
      '/usr/local/bin/terraform',
      '/usr/bin/terraform',
      'terraform'
    ];

    for (const p of candidates) {
      try {
        if (p.startsWith('/')) {
          if (fs.existsSync(p)) {
            return p;
          }
        } else {
          const resolved = execSync('which terraform 2>/dev/null', { encoding: 'utf8' }).trim();
          if (resolved) {
            return resolved;
          }
        }
      } catch {
        // Continue searching
      }
    }
    return 'terraform';
  }

  /**
   * Masks sensitive credentials in logs and outputs
   */
  _maskOutput(text = '') {
    if (!text || typeof text !== 'string') return '';
    return text
      .replace(/(AWS_SECRET_ACCESS_KEY|SECRET_KEY|PASSWORD|TOKEN|BEARER|SECRET)=([^\s\n]+)/gi, '$1=********')
      .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA****************')
      .replace(/ghp_[0-9a-zA-Z]{36}/g, 'ghp_************************************');
  }

  /**
   * Checks host system prerequisites for Terraform execution
   */
  async checkPrerequisites() {
    if (this._cachedPrereqs && (Date.now() - (this._cachedPrereqsTime || 0) < 10000)) {
      return this._cachedPrereqs;
    }

    const sysInfo = {
      os: os.platform(),
      release: os.release(),
      arch: os.arch(),
      terraformInstalled: false,
      terraformVersion: null,
      executablePath: this.executablePath,
      awsReady: false,
      awsAccount: null,
      awsRegion: config.aws.region || 'ap-south-1',
      errors: [],
      instructions: null
    };

    // 1. Check Terraform binary
    try {
      const versionOut = execSync(`${this.executablePath} version -json 2>/dev/null || ${this.executablePath} --version`, {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, CHECKPOINT_DISABLE: '1', TF_IN_AUTOMATION: '1' }
      });

      sysInfo.terraformInstalled = true;
      try {
        const jsonVer = JSON.parse(versionOut);
        sysInfo.terraformVersion = jsonVer.terraform_version || '1.15.8';
      } catch {
        const match = versionOut.match(/Terraform\s+v?([0-9.]+)/i);
        sysInfo.terraformVersion = match ? match[1] : 'installed';
      }
    } catch (err) {
      sysInfo.terraformInstalled = false;
      sysInfo.errors.push(`Terraform executable not found at '${this.executablePath}'`);
      sysInfo.instructions = os.platform() === 'darwin'
        ? 'Install Terraform using Homebrew: brew tap hashicorp/tap && brew install hashicorp/tap/terraform'
        : 'Install Terraform from HashiCorp: https://developer.hashicorp.com/terraform/install';
    }

    // 2. Check AWS STS Identity
    try {
      const stsStatus = await awsClient.getStatus();
      sysInfo.awsReady = stsStatus.connected || false;
      sysInfo.awsAccount = stsStatus.accountId || stsStatus.identity?.account || null;
      sysInfo.awsCallerArn = stsStatus.arn || stsStatus.identity?.arn || null;
      sysInfo.awsRegion = stsStatus.region || sysInfo.awsRegion;
      if (!sysInfo.awsReady) {
        sysInfo.errors.push('AWS credentials not configured or STS authentication failed.');
      }
    } catch (stsErr) {
      sysInfo.awsReady = false;
      sysInfo.errors.push(`AWS STS error: ${stsErr.message}`);
    }

    this._cachedPrereqs = sysInfo;
    this._cachedPrereqsTime = Date.now();
    return sysInfo;
  }

  /**
   * Acquires a workspace lock for a project
   */
  acquireLock(projectId) {
    if (this.activeLocks.has(projectId)) {
      throw new Error(`Concurrent Terraform operation in progress for project '${projectId}'. Please wait.`);
    }
    this.activeLocks.add(projectId);
  }

  /**
   * Releases a workspace lock for a project
   */
  releaseLock(projectId) {
    this.activeLocks.delete(projectId);
  }

  /**
   * Executes a real Terraform command inside a specific workspace directory
   * @param {string} workspaceDir Path to the project's terraform directory
   * @param {Array<string>} args CLI arguments (e.g. ['init', '-no-color'])
   * @param {object} options Execution options (timeout, env, onData callback)
   * @returns {Promise<object>} Execution result
   */
  async execute(workspaceDir, args = [], options = {}) {
    if (!fs.existsSync(workspaceDir)) {
      throw new Error(`Terraform workspace directory does not exist: ${workspaceDir}`);
    }

    const startTime = Date.now();
    const timeoutMs = options.timeoutMs || 180000; // Default 3 minutes timeout

    // Inherit process.env with AWS configuration
    const env = {
      ...process.env,
      PATH: `${path.dirname(this.executablePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}`,
      TF_IN_AUTOMATION: '1',
      TF_INPUT: '0',
      AWS_REGION: options.region || config.aws.region || 'ap-south-1',
      AWS_DEFAULT_REGION: options.region || config.aws.region || 'ap-south-1',
      ...(options.env || {})
    };

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timer = null;

      const proc = spawn(this.executablePath, args, {
        cwd: workspaceDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          proc.kill('SIGKILL');
          const err = new Error(`Terraform command '${args[0]}' timed out after ${timeoutMs / 1000}s`);
          err.code = 'ETIMEDOUT';
          reject(err);
        }, timeoutMs);
      }

      proc.stdout.on('data', (chunk) => {
        const str = chunk.toString();
        stdout += str;
        if (typeof options.onData === 'function') {
          options.onData(this._maskOutput(str));
        }
      });

      proc.stderr.on('data', (chunk) => {
        const str = chunk.toString();
        stderr += str;
        if (typeof options.onData === 'function') {
          options.onData(this._maskOutput(str));
        }
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(new Error(`Failed to spawn Terraform CLI: ${err.message}`));
      });

      proc.on('close', (exitCode) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        const result = {
          command: `terraform ${args.join(' ')}`,
          args,
          workspaceDir,
          exitCode: exitCode || 0,
          success: exitCode === 0,
          stdout: this._maskOutput(stdout),
          stderr: this._maskOutput(stderr),
          durationMs,
          executedAt: new Date().toISOString()
        };

        if (exitCode !== 0 && !options.ignoreExitCode) {
          const err = new Error(
            `Terraform command '${args.join(' ')}' failed with exit code ${exitCode}:\n${result.stderr || result.stdout}`
          );
          err.result = result;
          err.exitCode = exitCode;
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
   * Runs `terraform init`
   */
  async init(workspaceDir, options = {}) {
    const args = ['init', '-no-color'];
    if (options.upgrade) args.push('-upgrade');
    if (options.reconfigure) args.push('-reconfigure');
    return this.execute(workspaceDir, args, options);
  }

  /**
   * Runs `terraform validate`
   */
  async validate(workspaceDir, options = {}) {
    const args = ['validate', '-no-color', '-json'];
    const result = await this.execute(workspaceDir, args, { ...options, ignoreExitCode: true });
    try {
      const parsed = JSON.parse(result.stdout);
      return {
        ...result,
        isValid: parsed.valid === true,
        errorCount: parsed.error_count || 0,
        warningCount: parsed.warning_count || 0,
        diagnostics: parsed.diagnostics || []
      };
    } catch {
      return {
        ...result,
        isValid: result.exitCode === 0
      };
    }
  }

  /**
   * Runs `terraform plan`
   */
  async plan(workspaceDir, options = {}) {
    const planFile = options.planFile || 'tfplan';
    const args = ['plan', '-no-color', `-out=${planFile}`];
    if (options.varFile) args.push(`-var-file=${options.varFile}`);
    return this.execute(workspaceDir, args, options);
  }

  /**
   * Runs `terraform show -json <planFile>`
   */
  async showJson(workspaceDir, planFile = 'tfplan', options = {}) {
    const args = ['show', '-json', planFile];
    const result = await this.execute(workspaceDir, args, options);
    try {
      return JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(`Failed to parse terraform plan JSON: ${err.message}`);
    }
  }

  /**
   * Runs `terraform apply`
   */
  async apply(workspaceDir, options = {}) {
    const planFile = options.planFile || 'tfplan';
    const args = ['apply', '-no-color', '-auto-approve'];
    if (fs.existsSync(path.join(workspaceDir, planFile))) {
      args.push(planFile);
    }
    return this.execute(workspaceDir, args, options);
  }

  /**
   * Runs `terraform output -json`
   */
  async output(workspaceDir, options = {}) {
    const args = ['output', '-json'];
    const result = await this.execute(workspaceDir, args, { ...options, ignoreExitCode: true });
    if (result.exitCode !== 0) {
      return {};
    }
    try {
      const raw = JSON.parse(result.stdout);
      const parsed = {};
      for (const [k, v] of Object.entries(raw)) {
        parsed[k] = v.value;
      }
      return parsed;
    } catch {
      return {};
    }
  }

  /**
   * Runs `terraform import`
   */
  async importResource(workspaceDir, resourceAddress, resourceId, options = {}) {
    const args = ['import', '-no-color', resourceAddress, resourceId];
    return this.execute(workspaceDir, args, options);
  }

  /**
   * Status check helper for RequirementEngine and status APIs
   */
  async getStatus() {
    const prereqs = await this.checkPrerequisites();
    return {
      terraformInstalled: prereqs.terraformInstalled,
      version: prereqs.terraformVersion,
      arch: prereqs.arch,
      terraformPath: prereqs.executablePath,
      awsReady: prereqs.awsReady,
      awsAccount: prereqs.awsAccount,
      region: prereqs.awsRegion
    };
  }

  /**
   * Runs `terraform destroy`
   */
  async destroy(workspaceDir, options = {}) {
    const args = ['destroy', '-no-color', '-auto-approve'];
    if (options.varFile) args.push(`-var-file=${options.varFile}`);
    return this.execute(workspaceDir, args, options);
  }
}

module.exports = new TerraformClient();
module.exports.TerraformClient = TerraformClient;
