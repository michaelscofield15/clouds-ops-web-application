const terraformEngine = require('../services/terraform');
const terraformStateService = require('../services/terraform/terraform.state.service');
const terraformAdoptionService = require('../services/terraform/terraform.adoption.service');

/**
 * Controller handling Terraform REST API endpoints.
 */

// Global preflight / status check
async function getGlobalStatus(req, res, next) {
  try {
    const status = await terraformEngine.checkPrerequisites();
    return res.json(status);
  } catch (err) {
    return next(err);
  }
}

// Generates Terraform configuration
async function generateConfig(req, res, next) {
  try {
    const { projectId } = req.params;
    const customOptions = req.body || {};
    const result = await terraformEngine.generateConfiguration(projectId, customOptions);
    return res.json({
      success: true,
      message: 'Terraform configuration generated successfully',
      data: result
    });
  } catch (err) {
    return next(err);
  }
}

// Runs terraform init
async function initProject(req, res, next) {
  try {
    const { projectId } = req.params;
    const options = req.body || {};
    const result = await terraformEngine.init(projectId, options);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// Runs terraform validate
async function validateProject(req, res, next) {
  try {
    const { projectId } = req.params;
    const options = req.body || {};
    const result = await terraformEngine.validate(projectId, options);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// Runs terraform plan
async function planProject(req, res, next) {
  try {
    const { projectId } = req.params;
    const options = req.body || {};
    const result = await terraformEngine.plan(projectId, options);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// Runs terraform apply
async function applyProject(req, res, next) {
  try {
    const { projectId } = req.params;
    const options = req.body || {};
    const result = await terraformEngine.apply(projectId, options);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// Runs terraform destroy
async function destroyProject(req, res, next) {
  try {
    const { projectId } = req.params;
    const options = req.body || {};
    const result = await terraformEngine.destroy(projectId, options);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// Gets project Terraform state/status
function getProjectStatus(req, res, next) {
  try {
    const { projectId } = req.params;
    const status = terraformEngine.getStatus(projectId);
    return res.json(status);
  } catch (err) {
    return next(err);
  }
}

// Gets latest plan summary
function getProjectPlan(req, res, next) {
  try {
    const { projectId } = req.params;
    const plan = terraformEngine.getPlan(projectId);
    return res.json(plan);
  } catch (err) {
    return next(err);
  }
}

// Gets project Terraform logs
function getProjectLogs(req, res, next) {
  try {
    const { projectId } = req.params;
    const logs = terraformEngine.getLogs(projectId);
    return res.json(logs);
  } catch (err) {
    return next(err);
  }
}

// Discovers existing AWS resources for adoption
async function discoverResources(req, res, next) {
  try {
    const { projectId } = req.params;
    const region = req.query.region || req.body?.region || 'ap-south-1';
    const discovered = await terraformAdoptionService.discoverExistingResources(projectId, region);
    return res.json(discovered);
  } catch (err) {
    return next(err);
  }
}

// Adopts an existing AWS resource into state
async function importResource(req, res, next) {
  try {
    const { projectId } = req.params;
    const { resourceAddress, resourceId } = req.body || {};
    if (!resourceAddress || !resourceId) {
      return res.status(400).json({ error: 'Both resourceAddress and resourceId are required' });
    }
    const result = await terraformAdoptionService.adoptResource(projectId, resourceAddress, resourceId, req.body);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getGlobalStatus,
  generateConfig,
  initProject,
  validateProject,
  planProject,
  applyProject,
  destroyProject,
  getProjectStatus,
  getProjectPlan,
  getProjectLogs,
  discoverResources,
  importResource
};
