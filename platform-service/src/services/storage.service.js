const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const db = require('./db/db.service');

class StorageService {
  constructor() {
    this.projects = new Map();
    this.ensureBaseDir();
  }

  ensureBaseDir() {
    if (!fs.existsSync(config.tempBaseDir)) {
      fs.mkdirSync(config.tempBaseDir, { recursive: true });
    }
  }

  generateProjectId() {
    return crypto.randomUUID();
  }

  createWorkspace(projectId = this.generateProjectId(), organizationId = null) {
    this.ensureBaseDir();
    const effectiveOrgId = organizationId || 'org-default-dev';

    // Tenant-isolated project workspace path
    const orgDir = path.join(config.tempBaseDir, 'organizations', effectiveOrgId, 'projects');
    const projectDir = path.join(orgDir, projectId);
    const extractDir = path.join(projectDir, 'extracted');

    fs.mkdirSync(extractDir, { recursive: true });

    // Also ensure backward-compatible flat path pointer if needed
    const legacyProjectDir = path.join(config.tempBaseDir, projectId);
    const legacyExtractDir = path.join(legacyProjectDir, 'extracted');
    try {
      fs.mkdirSync(legacyExtractDir, { recursive: true });
    } catch {
      // Ignore
    }

    return {
      projectId,
      organizationId: effectiveOrgId,
      projectDir,
      extractDir
    };
  }

  getWorkspacePath(projectId, organizationId = null) {
    // 1. Try tenant-isolated path if organizationId provided
    if (organizationId) {
      const orgProjectDir = path.join(config.tempBaseDir, 'organizations', organizationId, 'projects', projectId);
      const extractDir = path.join(orgProjectDir, 'extracted');
      if (fs.existsSync(orgProjectDir)) {
        return {
          projectId,
          organizationId,
          projectDir: orgProjectDir,
          extractDir
        };
      }
    }

    // 2. Check DB record for project's organizationId
    const dbProject = db.findById('projects', projectId);
    if (dbProject && dbProject.organizationId) {
      const orgProjectDir = path.join(config.tempBaseDir, 'organizations', dbProject.organizationId, 'projects', projectId);
      const extractDir = path.join(orgProjectDir, 'extracted');
      if (fs.existsSync(orgProjectDir)) {
        return {
          projectId,
          organizationId: dbProject.organizationId,
          projectDir: orgProjectDir,
          extractDir
        };
      }
    }

    // 3. Fallback to flat directory for legacy backward compatibility
    const legacyDir = path.join(config.tempBaseDir, projectId);
    const legacyExtractDir = path.join(legacyDir, 'extracted');
    if (fs.existsSync(legacyDir)) {
      return {
        projectId,
        organizationId: dbProject?.organizationId || 'org-default-dev',
        projectDir: legacyDir,
        extractDir: legacyExtractDir
      };
    }

    return null;
  }

  getWorkspaceDir(projectId, organizationId = null) {
    const ws = this.getWorkspacePath(projectId, organizationId);
    return ws ? ws.extractDir : null;
  }

  getProjectDir(projectId, organizationId = null) {
    const ws = this.getWorkspacePath(projectId, organizationId);
    return ws ? ws.projectDir : path.join(config.tempBaseDir, projectId);
  }

  saveAnalysis(projectId, analysis, organizationId = null, userId = null) {
    const effectiveOrgId = organizationId || analysis.organizationId || 'org-default-dev';
    const effectiveUserId = userId || analysis.createdByUserId || 'usr-default-dev';

    const record = {
      projectId,
      organizationId: effectiveOrgId,
      createdByUserId: effectiveUserId,
      uploadedAt: new Date().toISOString(),
      ...analysis
    };

    this.projects.set(projectId, record);

    // Persist to DatabaseService
    const existingDb = db.findById('projects', projectId);
    if (existingDb) {
      db.update('projects', projectId, {
        organizationId: effectiveOrgId,
        createdByUserId: effectiveUserId,
        name: analysis.project?.name || existingDb.name,
        runtime: analysis.project?.runtime || existingDb.runtime,
        analysisJson: JSON.stringify(record)
      });
    } else {
      db.insert('projects', {
        id: projectId,
        organizationId: effectiveOrgId,
        createdByUserId: effectiveUserId,
        name: analysis.project?.name || 'Uploaded Application',
        status: 'ANALYZED',
        runtime: analysis.project?.runtime || 'unknown',
        analysisJson: JSON.stringify(record)
      });
    }

    // Also persist analysis report JSON to workspace if directory exists
    const workspace = this.getWorkspacePath(projectId, effectiveOrgId);
    if (workspace && fs.existsSync(workspace.projectDir)) {
      try {
        fs.writeFileSync(
          path.join(workspace.projectDir, 'analysis.json'),
          JSON.stringify(record, null, 2),
          'utf8'
        );
      } catch (err) {
        console.error(`[StorageService] Failed to persist analysis.json for ${projectId}:`, err);
      }
    }

    return record;
  }

  getAnalysis(projectId, organizationId = null) {
    if (this.projects.has(projectId)) {
      const p = this.projects.get(projectId);
      if (!organizationId || p.organizationId === organizationId) {
        return p;
      }
    }

    // Check DB
    const dbProject = db.findById('projects', projectId);
    if (dbProject) {
      if (organizationId && dbProject.organizationId !== organizationId) {
        return null;
      }
      if (dbProject.analysisJson) {
        try {
          const parsed = JSON.parse(dbProject.analysisJson);
          this.projects.set(projectId, parsed);
          return parsed;
        } catch {
          // Ignore
        }
      }
    }

    // Try loading from workspace disk if available
    const workspace = this.getWorkspacePath(projectId, organizationId);
    if (workspace) {
      const reportFile = path.join(workspace.projectDir, 'analysis.json');
      if (fs.existsSync(reportFile)) {
        try {
          const raw = fs.readFileSync(reportFile, 'utf8');
          const data = JSON.parse(raw);
          this.projects.set(projectId, data);
          return data;
        } catch (e) {
          // ignore corrupted cached files
        }
      }
    }

    return null;
  }

  getProject(projectId, organizationId = null) {
    const proj = this.getAnalysis(projectId, organizationId);
    if (!proj) return null;
    const dbProj = db.findById('projects', projectId);
    if (dbProj) {
      return {
        ...proj,
        liveDeploymentId: dbProj.liveDeploymentId || proj.liveDeploymentId,
        liveUrl: dbProj.liveUrl || proj.liveUrl,
        liveEndpoint: dbProj.liveEndpoint || proj.liveEndpoint,
        liveInstanceId: dbProj.liveInstanceId || proj.liveInstanceId,
        liveStatus: dbProj.liveStatus || proj.liveStatus,
        liveImageTag: dbProj.liveImageTag || proj.liveImageTag,
        liveImageDigest: dbProj.liveImageDigest || proj.liveImageDigest,
        latestDeploymentId: dbProj.latestDeploymentId || proj.latestDeploymentId,
        latestStatus: dbProj.latestStatus || proj.latestStatus,
        targetInstanceId: dbProj.targetInstanceId || proj.targetInstanceId
      };
    }
    return proj;
  }

  updateProject(projectId, updates = {}, organizationId = null) {
    const existing = this.getAnalysis(projectId, organizationId) || { projectId };
    const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    this.projects.set(projectId, merged);

    const dbProject = db.findById('projects', projectId);
    if (dbProject) {
      const topLevelUpdates = {
        status: updates.status || dbProject.status,
        analysisJson: JSON.stringify(merged)
      };
      if (updates.liveDeploymentId !== undefined) topLevelUpdates.liveDeploymentId = updates.liveDeploymentId;
      if (updates.liveUrl !== undefined) topLevelUpdates.liveUrl = updates.liveUrl;
      if (updates.liveEndpoint !== undefined) topLevelUpdates.liveEndpoint = updates.liveEndpoint;
      if (updates.liveInstanceId !== undefined) topLevelUpdates.liveInstanceId = updates.liveInstanceId;
      if (updates.liveStatus !== undefined) topLevelUpdates.liveStatus = updates.liveStatus;
      if (updates.liveImageTag !== undefined) topLevelUpdates.liveImageTag = updates.liveImageTag;
      if (updates.liveImageDigest !== undefined) topLevelUpdates.liveImageDigest = updates.liveImageDigest;
      if (updates.latestDeploymentId !== undefined) topLevelUpdates.latestDeploymentId = updates.latestDeploymentId;
      if (updates.latestStatus !== undefined) topLevelUpdates.latestStatus = updates.latestStatus;
      if (updates.targetInstanceId !== undefined) topLevelUpdates.targetInstanceId = updates.targetInstanceId;

      db.update('projects', projectId, topLevelUpdates);
    }

    const workspace = this.getWorkspacePath(projectId, organizationId || merged.organizationId);
    if (workspace && fs.existsSync(workspace.projectDir)) {
      try {
        fs.writeFileSync(
          path.join(workspace.projectDir, 'analysis.json'),
          JSON.stringify(merged, null, 2),
          'utf8'
        );
      } catch (err) {
        console.error(`[StorageService] Failed to persist updated analysis.json for ${projectId}:`, err);
      }
    }

    return merged;
  }

  deleteWorkspace(projectId, organizationId = null) {
    const workspace = this.getWorkspacePath(projectId, organizationId);
    if (workspace && fs.existsSync(workspace.projectDir)) {
      fs.rmSync(workspace.projectDir, { recursive: true, force: true });
    }
    const legacyDir = path.join(config.tempBaseDir, projectId);
    if (fs.existsSync(legacyDir)) {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
    this.projects.delete(projectId);
    db.delete('projects', projectId);
  }

  listProjects(organizationId = null) {
    if (organizationId) {
      const dbProjects = db.find('projects', { organizationId });
      return dbProjects.map(p => {
        let record = {
          id: p.id,
          projectId: p.id,
          name: p.name,
          runtime: p.runtime || 'Node.js',
          status: p.status,
          organizationId: p.organizationId,
          liveDeploymentId: p.liveDeploymentId || null,
          liveUrl: p.liveUrl || null,
          liveEndpoint: p.liveEndpoint || null,
          liveInstanceId: p.liveInstanceId || null,
          liveStatus: p.liveStatus || null,
          latestDeploymentId: p.latestDeploymentId || null,
          latestStatus: p.latestStatus || null,
          targetInstanceId: p.targetInstanceId || null
        };
        if (p.analysisJson) {
          try {
            const parsed = JSON.parse(p.analysisJson);
            record = {
              ...record,
              ...parsed,
              id: p.id,
              projectId: p.id,
              name: p.name || parsed.project?.name || p.id,
              runtime: p.runtime || parsed.project?.runtime || 'Node.js',
              liveDeploymentId: p.liveDeploymentId || parsed.liveDeploymentId || null,
              liveUrl: p.liveUrl || parsed.liveUrl || null,
              liveEndpoint: p.liveEndpoint || parsed.liveEndpoint || null,
              liveInstanceId: p.liveInstanceId || parsed.liveInstanceId || null,
              liveStatus: p.liveStatus || parsed.liveStatus || null,
              latestDeploymentId: p.latestDeploymentId || parsed.latestDeploymentId || null,
              latestStatus: p.latestStatus || parsed.latestStatus || null,
              targetInstanceId: p.targetInstanceId || parsed.targetInstanceId || null
            };
          } catch {}
        }
        return record;
      });
    }

    // List all
    const allDbProjects = db.find('projects');
    if (allDbProjects.length > 0) {
      return allDbProjects.map(p => {
        let record = {
          id: p.id,
          projectId: p.id,
          name: p.name,
          runtime: p.runtime || 'Node.js',
          status: p.status,
          organizationId: p.organizationId,
          liveDeploymentId: p.liveDeploymentId || null,
          liveUrl: p.liveUrl || null,
          liveEndpoint: p.liveEndpoint || null,
          liveInstanceId: p.liveInstanceId || null,
          liveStatus: p.liveStatus || null,
          latestDeploymentId: p.latestDeploymentId || null,
          latestStatus: p.latestStatus || null,
          targetInstanceId: p.targetInstanceId || null
        };
        if (p.analysisJson) {
          try {
            const parsed = JSON.parse(p.analysisJson);
            record = {
              ...record,
              ...parsed,
              id: p.id,
              projectId: p.id,
              name: p.name || parsed.project?.name || p.id,
              runtime: p.runtime || parsed.project?.runtime || 'Node.js',
              liveDeploymentId: p.liveDeploymentId || parsed.liveDeploymentId || null,
              liveUrl: p.liveUrl || parsed.liveUrl || null,
              liveEndpoint: p.liveEndpoint || parsed.liveEndpoint || null,
              liveInstanceId: p.liveInstanceId || parsed.liveInstanceId || null,
              liveStatus: p.liveStatus || parsed.liveStatus || null,
              latestDeploymentId: p.latestDeploymentId || parsed.latestDeploymentId || null,
              latestStatus: p.latestStatus || parsed.latestStatus || null,
              targetInstanceId: p.targetInstanceId || parsed.targetInstanceId || null
            };
          } catch {}
        }
        return record;
      });
    }

    return Array.from(this.projects.values()).map(p => ({
      id: p.projectId || p.id,
      projectId: p.projectId || p.id,
      name: p.name || p.project?.name || p.projectId,
      runtime: p.runtime || p.project?.runtime || 'Node.js',
      ...p
    }));
  }

  getAWSState(projectId) {
    const project = this.getProject(projectId);
    if (project && project.awsState) {
      return project.awsState;
    }
    try {
      const awsDeploymentService = require('./aws/aws.deployment.service');
      return awsDeploymentService.getStatus(projectId);
    } catch {
      return null;
    }
  }

  cleanupAll() {
    if (fs.existsSync(config.tempBaseDir)) {
      fs.rmSync(config.tempBaseDir, { recursive: true, force: true });
      this.ensureBaseDir();
    }
    this.projects.clear();
    db.clearAll();
  }
}

module.exports = new StorageService();
module.exports.StorageService = StorageService;
