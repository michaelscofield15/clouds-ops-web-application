const fs = require('fs');
const path = require('path');
const storageService = require('../storage.service');
const { Incident, INCIDENT_STATUSES } = require('./incident.model');
const { RemediationAction } = require('./remediationAction.model');
const { RECOVERY_MODES } = require('./remediationPolicy.service');

class SelfHealingStorage {
  constructor() {
    this.incidentsCache = new Map(); // projectId -> Map<incidentId, Incident>
    this.remediationsCache = new Map(); // projectId -> Array<RemediationAction>
    this.settingsCache = new Map(); // projectId -> settings
    this.globalAutoRecovery = true; // Global safety master switch
  }

  _getStorageDir(projectId) {
    const projectDir = storageService.getProjectDir(projectId);
    const selfHealingDir = path.join(projectDir, 'self-healing');
    if (!fs.existsSync(selfHealingDir)) {
      fs.mkdirSync(selfHealingDir, { recursive: true });
    }
    return selfHealingDir;
  }

  _getIncidentsFilePath(projectId) {
    return path.join(this._getStorageDir(projectId), 'incidents.json');
  }

  _getRemediationsFilePath(projectId) {
    return path.join(this._getStorageDir(projectId), 'remediations.json');
  }

  _getSettingsFilePath(projectId) {
    return path.join(this._getStorageDir(projectId), 'settings.json');
  }

  getGlobalAutoRecovery() {
    return this.globalAutoRecovery;
  }

  setGlobalAutoRecovery(enabled) {
    this.globalAutoRecovery = Boolean(enabled);
    return this.globalAutoRecovery;
  }

  /**
   * Retrieves all incidents for a project
   */
  getIncidents(projectId) {
    if (this.incidentsCache.has(projectId)) {
      return Array.from(this.incidentsCache.get(projectId).values());
    }

    const filePath = this._getIncidentsFilePath(projectId);
    const incidentsMap = new Map();

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            const inc = new Incident(item);
            incidentsMap.set(inc.incidentId, inc);
          }
        }
      } catch (err) {
        console.error(`[SelfHealingStorage] Failed to read incidents for ${projectId}:`, err.message);
      }
    }

    this.incidentsCache.set(projectId, incidentsMap);
    return Array.from(incidentsMap.values());
  }

  /**
   * Retrieves a single incident by ID
   */
  getIncident(projectId, incidentId) {
    const incidents = this.getIncidents(projectId);
    return incidents.find(i => i.incidentId === incidentId) || null;
  }

  /**
   * Saves or updates an incident
   */
  saveIncident(projectId, incident) {
    if (!this.incidentsCache.has(projectId)) {
      this.getIncidents(projectId);
    }

    const map = this.incidentsCache.get(projectId);
    map.set(incident.incidentId, incident);

    const filePath = this._getIncidentsFilePath(projectId);
    try {
      const list = Array.from(map.values()).map(i => (typeof i.toJSON === 'function' ? i.toJSON() : i));
      fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf8');
    } catch (err) {
      console.error(`[SelfHealingStorage] Failed to persist incident ${incident.incidentId}:`, err.message);
    }

    return incident;
  }

  /**
   * Retrieves remediation actions for a project
   */
  getRemediations(projectId) {
    if (this.remediationsCache.has(projectId)) {
      return this.remediationsCache.get(projectId);
    }

    const filePath = this._getRemediationsFilePath(projectId);
    let list = [];

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          list = parsed.map(item => new RemediationAction(item));
        }
      } catch (err) {
        console.error(`[SelfHealingStorage] Failed to read remediations for ${projectId}:`, err.message);
      }
    }

    this.remediationsCache.set(projectId, list);
    return list;
  }

  /**
   * Records a new remediation action
   */
  saveRemediation(projectId, action) {
    const list = this.getRemediations(projectId);
    const existingIndex = list.findIndex(a => a.actionId === action.actionId);

    if (existingIndex >= 0) {
      list[existingIndex] = action;
    } else {
      list.unshift(action); // newest first
    }

    const filePath = this._getRemediationsFilePath(projectId);
    try {
      const jsonList = list.map(a => (typeof a.toJSON === 'function' ? a.toJSON() : a));
      fs.writeFileSync(filePath, JSON.stringify(jsonList, null, 2), 'utf8');
    } catch (err) {
      console.error(`[SelfHealingStorage] Failed to persist remediation ${action.actionId}:`, err.message);
    }

    return action;
  }

  /**
   * Retrieves project recovery configuration
   */
  getProjectSettings(projectId) {
    if (this.settingsCache.has(projectId)) {
      return this.settingsCache.get(projectId);
    }

    const filePath = this._getSettingsFilePath(projectId);
    let settings = {
      projectId,
      autoRecovery: true,
      recoveryMode: RECOVERY_MODES.SAFE,
      maxAttempts: 2,
      cooldownSeconds: 300,
      healthCheckRetries: 3,
      healthCheckTimeoutMs: 5000,
      updatedAt: new Date().toISOString()
    };

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        settings = { ...settings, ...JSON.parse(raw) };
      } catch (err) {
        // use default
      }
    }

    this.settingsCache.set(projectId, settings);
    return settings;
  }

  /**
   * Saves project recovery configuration
   */
  saveProjectSettings(projectId, updates = {}) {
    const current = this.getProjectSettings(projectId);
    const updated = {
      ...current,
      ...updates,
      projectId,
      updatedAt: new Date().toISOString()
    };

    this.settingsCache.set(projectId, updated);
    const filePath = this._getSettingsFilePath(projectId);
    try {
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8');
    } catch (err) {
      console.error(`[SelfHealingStorage] Failed to save settings for ${projectId}:`, err.message);
    }

    return updated;
  }

  /**
   * Calculates real-time recovery metrics for a specific project
   */
  getProjectStats(projectId) {
    const incidents = this.getIncidents(projectId);
    const remediations = this.getRemediations(projectId);
    const settings = this.getProjectSettings(projectId);

    const activeIncidents = incidents.filter(i => i.status !== INCIDENT_STATUSES.RESOLVED && i.status !== INCIDENT_STATUSES.FAILED);
    const resolvedIncidents = incidents.filter(i => i.status === INCIDENT_STATUSES.RESOLVED);
    const escalatedIncidents = incidents.filter(i => i.status === INCIDENT_STATUSES.ESCALATED || i.escalationRequired);
    const activeRemediations = remediations.filter(r => r.status === 'RUNNING');

    return {
      projectId,
      globalAutoRecovery: this.globalAutoRecovery,
      autoRecoveryEnabled: this.globalAutoRecovery && settings.autoRecovery && settings.recoveryMode !== RECOVERY_MODES.DISABLED,
      recoveryMode: settings.recoveryMode,
      totalIncidents: incidents.length,
      activeIncidentsCount: activeIncidents.length,
      resolvedIncidentsCount: resolvedIncidents.length,
      escalatedIncidentsCount: escalatedIncidents.length,
      activeRemediationsCount: activeRemediations.length,
      totalRemediationsCount: remediations.length,
      lastEvaluatedAt: new Date().toISOString()
    };
  }

  /**
   * Global platform-wide self-healing stats
   */
  getGlobalStats() {
    const projects = storageService.listProjects();
    let totalIncidents = 0;
    let activeIncidents = 0;
    let resolvedIncidents = 0;
    let escalatedIncidents = 0;
    let activeRemediations = 0;

    for (const p of projects) {
      const pId = p.projectId || p.id || (typeof p === 'string' ? p : null);
      if (pId) {
        const stats = this.getProjectStats(pId);
        totalIncidents += stats.totalIncidents;
        activeIncidents += stats.activeIncidentsCount;
        resolvedIncidents += stats.resolvedIncidentsCount;
        escalatedIncidents += stats.escalatedIncidentsCount;
        activeRemediations += stats.activeRemediationsCount;
      }
    }

    return {
      engineStatus: this.globalAutoRecovery ? 'ACTIVE' : 'PAUSED',
      globalAutoRecovery: this.globalAutoRecovery,
      totalProjects: projects.length,
      totalIncidents,
      activeIncidents,
      resolvedIncidents,
      escalatedIncidents,
      activeRemediations,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = new SelfHealingStorage();
module.exports.SelfHealingStorage = SelfHealingStorage;
