const fs = require('fs');
const path = require('path');
const storageService = require('../storage.service');

class OrchestratorStorage {
  constructor() {
    this.deploymentsCache = new Map(); // projectId -> deployment record
  }

  _getStorageDir(projectId) {
    const projectDir = storageService.getProjectDir(projectId);
    const orchestratorDir = path.join(projectDir, 'orchestrator');
    if (!fs.existsSync(orchestratorDir)) {
      fs.mkdirSync(orchestratorDir, { recursive: true });
    }
    return orchestratorDir;
  }

  _getDeploymentFilePath(projectId) {
    return path.join(this._getStorageDir(projectId), 'deployment.json');
  }

  _formatLog(stage, message) {
    const time = new Date().toISOString().split('T')[1].slice(0, 8);
    return `[${time}] [${stage}] ${message}`;
  }

  /**
   * Retrieves deployment record for a project
   */
  getDeployment(projectId) {
    if (this.deploymentsCache.has(projectId)) {
      return this.deploymentsCache.get(projectId);
    }

    const filePath = this._getDeploymentFilePath(projectId);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        this.deploymentsCache.set(projectId, data);
        return data;
      } catch (err) {
        console.error(`[OrchestratorStorage] Failed to read deployment for ${projectId}:`, err.message);
      }
    }

    return null;
  }

  /**
   * Initializes or saves a deployment record
   */
  saveDeployment(projectId, data = {}) {
    const existing = this.getDeployment(projectId) || {
      deploymentId: `dep-${projectId.slice(0, 8)}-${Date.now()}`,
      projectId,
      userId: data.userId || 'default-user',
      state: 'UPLOADED',
      currentStage: null,
      stages: [],
      requirements: null,
      plan: null,
      preflight: null,
      failure: null,
      endpoint: null,
      healthEndpoint: null,
      logs: [],
      createdAt: new Date().toISOString()
    };

    const updated = {
      ...existing,
      ...data,
      projectId,
      updatedAt: new Date().toISOString()
    };

    this.deploymentsCache.set(projectId, updated);
    const filePath = this._getDeploymentFilePath(projectId);
    try {
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8');
    } catch (err) {
      console.error(`[OrchestratorStorage] Failed to persist deployment for ${projectId}:`, err.message);
    }

    return updated;
  }

  /**
   * Appends a log line to the deployment record
   */
  appendLog(projectId, stage, message) {
    const deployment = this.getDeployment(projectId) || this.saveDeployment(projectId);
    const line = this._formatLog(stage, message);
    deployment.logs = deployment.logs || [];
    deployment.logs.push(line);
    this.saveDeployment(projectId, { logs: deployment.logs });
    return line;
  }

  /**
   * Updates a specific execution stage status and details
   */
  updateStage(projectId, stageId, status, details = {}) {
    const deployment = this.getDeployment(projectId) || this.saveDeployment(projectId);
    deployment.stages = deployment.stages || [];
    const index = deployment.stages.findIndex(s => s.id === stageId);

    const stageUpdate = {
      id: stageId,
      status,
      updatedAt: new Date().toISOString(),
      ...details
    };

    if (index >= 0) {
      deployment.stages[index] = { ...deployment.stages[index], ...stageUpdate };
    } else {
      deployment.stages.push(stageUpdate);
    }

    return this.saveDeployment(projectId, {
      currentStage: status === 'RUNNING' ? stageId : deployment.currentStage,
      stages: deployment.stages
    });
  }
}

module.exports = new OrchestratorStorage();
module.exports.OrchestratorStorage = OrchestratorStorage;
