const fs = require('fs');
const path = require('path');
const config = require('../../config');
const storageService = require('../storage.service');

/**
 * Manages Terraform state metadata, active operations, plan summaries, and logs per project.
 */
class TerraformStateService {
  constructor() {
    this.memoryStates = new Map();
  }

  /**
   * Resolves the project's terraform directory
   */
  getWorkspaceDir(projectId) {
    if (typeof storageService.getProjectDir === 'function') {
      return path.join(storageService.getProjectDir(projectId), 'terraform');
    }
    return path.join(config.tempBaseDir, projectId, 'terraform');
  }

  /**
   * Retrieves the current Terraform state for a project
   */
  getState(projectId) {
    if (this.memoryStates.has(projectId)) {
      return this.memoryStates.get(projectId);
    }

    const workspaceDir = this.getWorkspaceDir(projectId);
    const metaPath = path.join(workspaceDir, 'terraform_metadata.json');

    if (fs.existsSync(metaPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        this.memoryStates.set(projectId, data);
        return data;
      } catch {
        // Fallback to initial state
      }
    }

    const initialState = {
      projectId,
      status: 'NOT_INITIALIZED', // NOT_INITIALIZED, INITIALIZED, VALIDATED, PLANNED, APPLIED, FAILED, DESTROYED
      workspaceDir,
      activeOperation: null,
      lastOperation: null,
      plan: null,
      outputs: null,
      resources: [],
      logs: [],
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.memoryStates.set(projectId, initialState);
    return initialState;
  }

  /**
   * Persists state updates for a project
   */
  saveState(projectId, updates = {}) {
    const current = this.getState(projectId);
    const updated = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    this.memoryStates.set(projectId, updated);

    const workspaceDir = this.getWorkspaceDir(projectId);
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }

    const metaPath = path.join(workspaceDir, 'terraform_metadata.json');
    try {
      fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2), 'utf8');
    } catch {
      // Ignored if write fails
    }

    return updated;
  }

  /**
   * Appends a log line to the project's Terraform log buffer
   */
  addLog(projectId, message = '') {
    const state = this.getState(projectId);
    const time = new Date().toISOString().split('T')[1].slice(0, 8);
    const entry = `[${time}] ${message}`;
    state.logs = state.logs || [];
    state.logs.push(entry);
    if (state.logs.length > 500) {
      state.logs = state.logs.slice(-500); // Retain latest 500 lines
    }
    this.saveState(projectId, { logs: state.logs });
    return entry;
  }

  /**
   * Acquires a concurrency lock for a project operation
   */
  acquireLock(projectId, operationType = 'apply') {
    const state = this.getState(projectId);
    if (state.activeOperation && state.activeOperation.status === 'RUNNING') {
      return false; // Lock acquisition denied (already running)
    }
    this.startOperation(projectId, operationType.toUpperCase());
    return true;
  }

  /**
   * Releases a concurrency lock for a project
   */
  releaseLock(projectId) {
    return this.completeOperation(projectId);
  }

  /**
   * Starts a tracked operation for a project
   */
  startOperation(projectId, operationType) {
    const opId = `tf-op-${projectId.slice(0, 8)}-${Date.now()}`;
    const operation = {
      id: opId,
      projectId,
      type: operationType, // INIT, VALIDATE, PLAN, APPLY, DESTROY, IMPORT
      status: 'RUNNING',
      startedAt: new Date().toISOString()
    };

    this.addLog(projectId, `Starting Terraform ${operationType} (Operation: ${opId})...`);
    return this.saveState(projectId, {
      activeOperation: operation,
      error: null
    });
  }

  /**
   * Marks a tracked operation as completed
   */
  completeOperation(projectId, result = {}) {
    const state = this.getState(projectId);
    const activeOp = state.activeOperation;

    const completedOp = activeOp
      ? {
          ...activeOp,
          status: 'SUCCESS',
          completedAt: new Date().toISOString(),
          durationMs: result.durationMs || 0
        }
      : null;

    this.addLog(
      projectId,
      `Terraform ${activeOp ? activeOp.type : 'Operation'} completed successfully in ${result.durationMs || 0}ms.`
    );

    return this.saveState(projectId, {
      activeOperation: null,
      lastOperation: completedOp,
      error: null
    });
  }

  /**
   * Marks a tracked operation as failed
   */
  failOperation(projectId, err) {
    const state = this.getState(projectId);
    const activeOp = state.activeOperation;

    const failedOp = activeOp
      ? {
          ...activeOp,
          status: 'FAILED',
          error: err.message,
          completedAt: new Date().toISOString()
        }
      : null;

    this.addLog(projectId, `Terraform error during ${activeOp ? activeOp.type : 'Operation'}: ${err.message}`);

    return this.saveState(projectId, {
      status: 'FAILED',
      activeOperation: null,
      lastOperation: failedOp,
      error: err.message
    });
  }
}

module.exports = new TerraformStateService();
module.exports.TerraformStateService = TerraformStateService;
