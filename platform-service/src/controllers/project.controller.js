const storageService = require('../services/storage.service');
const zipService = require('../services/zip.service');
const { analyzeProject } = require('../services/analyzer');
const auditService = require('../services/audit.service');

/**
 * Handle ZIP upload, safe extraction, and static analysis under tenant ownership
 */
const uploadProject = (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded',
        message: "A ZIP file must be uploaded under the 'project' form field."
      });
    }

    const { originalname, buffer, size } = req.file;

    if (!originalname || !originalname.toLowerCase().endsWith('.zip')) {
      return res.status(400).json({
        error: 'Invalid file type',
        message: 'Only .zip archive files are accepted.'
      });
    }

    if (!size || size === 0 || !buffer || buffer.length === 0) {
      return res.status(400).json({
        error: 'Empty archive',
        message: 'The uploaded ZIP file is empty.'
      });
    }

    const orgId = req.organization?.id || 'org-default-dev';
    const userId = req.user?.id || 'usr-default-dev';

    // 1. Create an isolated temporary workspace for this tenant
    const workspace = storageService.createWorkspace(undefined, orgId);

    // 2. Safely extract archive with Zip Slip protection
    let extraction;
    try {
      extraction = zipService.extractSafely(buffer, workspace.extractDir);
    } catch (zipErr) {
      storageService.deleteWorkspace(workspace.projectId, orgId);
      return res.status(400).json({
        error: 'Archive extraction failed',
        message: zipErr.message
      });
    }

    // 3. Perform static analysis on extracted files
    const analysisReport = analyzeProject(extraction.effectiveProjectRoot);
    analysisReport.uploadMetadata = {
      filename: originalname,
      sizeBytes: size,
      checksum: extraction.checksum,
      fileCount: extraction.fileCount,
      totalUncompressedBytes: extraction.totalBytes
    };

    // 4. Persist analysis record under tenant ownership
    const savedRecord = storageService.saveAnalysis(workspace.projectId, analysisReport, orgId, userId);

    auditService.log(workspace.projectId, 'PROJECT_UPLOAD', 'SUCCESS', {
      organizationId: orgId,
      userId,
      sizeBytes: size,
      checksum: extraction.checksum,
      filename: originalname
    });

    return res.status(201).json({
      projectId: workspace.projectId,
      organizationId: orgId,
      status: 'uploaded',
      checksum: extraction.checksum,
      analysis: savedRecord
    });
  } catch (err) {
    return next(err);
  }
};

/**
 * List all projects belonging to the authenticated tenant
 */
const listTenantProjects = (req, res) => {
  const orgId = req.organization?.id;
  const projects = storageService.listProjects(orgId);
  return res.status(200).json({ projects });
};

/**
 * Retrieve analysis report by project ID with IDOR protection
 */
const getProjectAnalysis = (req, res) => {
  const { projectId } = req.params;
  const orgId = req.organization?.id;

  const project = storageService.getProject(projectId);
  const analysis = storageService.getAnalysis(projectId, orgId);
  if (!analysis && !project) {
    return res.status(404).json({
      error: 'Project not found',
      message: `No analysis found for project ID '${projectId}'`
    });
  }

  return res.status(200).json({
    ...(analysis || {}),
    ...(project || {})
  });
};

/**
 * Delete / clean up project workspace
 */
const deleteProject = (req, res) => {
  const { projectId } = req.params;
  const orgId = req.organization?.id;

  const analysis = storageService.getAnalysis(projectId, orgId);
  if (!analysis) {
    return res.status(404).json({
      error: 'Project not found',
      message: `No project found with ID '${projectId}'`
    });
  }

  storageService.deleteWorkspace(projectId, orgId);

  auditService.log(projectId, 'PROJECT_DELETED', 'SUCCESS', {
    organizationId: orgId,
    userId: req.user?.id
  });

  return res.status(200).json({
    message: `Workspace for project '${projectId}' deleted successfully.`,
    projectId
  });
};

module.exports = {
  uploadProject,
  listTenantProjects,
  getProjectAnalysis,
  deleteProject
};
