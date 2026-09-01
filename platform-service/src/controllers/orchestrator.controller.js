const orchestratorEngine = require('../services/orchestrator');

/**
 * Trigger Project Analysis & Requirement Evaluation
 */
async function analyze(req, res) {
  try {
    const { projectId } = req.params;
    const result = await orchestratorEngine.analyze(projectId);
    return res.status(200).json({
      success: true,
      projectId,
      ...result
    });
  } catch (err) {
    return res.status(err.message.includes('not found') ? 404 : 500).json({
      success: false,
      error: err.message
    });
  }
}

/**
 * Get Current Requirements Matrix
 */
async function getRequirements(req, res) {
  try {
    const { projectId } = req.params;
    const deployment = orchestratorEngine.storage.getDeployment(projectId);
    if (!deployment || !deployment.requirements) {
      const result = await orchestratorEngine.resolveRequirements(projectId);
      return res.status(200).json(result.requirements);
    }
    return res.status(200).json(deployment.requirements);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Resolve Missing Requirements with User Input / Connections
 */
async function resolveRequirements(req, res) {
  try {
    const { projectId } = req.params;
    const { userConnections, secrets } = req.body || {};
    const result = await orchestratorEngine.resolveRequirements(projectId, userConnections, secrets);
    return res.status(200).json({
      success: true,
      projectId,
      ...result
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Generate Explainable Deployment Plan
 */
async function generatePlan(req, res) {
  try {
    const { projectId } = req.params;
    const options = req.body || {};
    const plan = await orchestratorEngine.generatePlan(projectId, options);
    return res.status(200).json({
      success: true,
      plan
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Get Current Plan
 */
async function getPlan(req, res) {
  try {
    const { projectId } = req.params;
    const deployment = orchestratorEngine.storage.getDeployment(projectId);
    if (!deployment || !deployment.plan) {
      const plan = await orchestratorEngine.generatePlan(projectId);
      return res.status(200).json(plan);
    }
    return res.status(200).json(deployment.plan);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Run Preflight Validation
 */
async function runPreflight(req, res) {
  try {
    const { projectId } = req.params;
    const options = req.body || {};
    const preflight = await orchestratorEngine.runPreflight(projectId, options);
    return res.status(200).json({
      success: true,
      preflight
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Execute Complete Autonomous Deployment Pipeline
 */
async function deploy(req, res) {
  try {
    const { projectId } = req.params;
    const options = req.body || {};
    const result = await orchestratorEngine.deploy(projectId, options);
    return res.status(202).json({
      success: true,
      ...result
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
}

/**
 * Get Full Real-Time Deployment Status
 */
async function getStatus(req, res) {
  try {
    const { projectId } = req.params;
    const deployment = orchestratorEngine.getStatus(projectId);
    if (!deployment) {
      return res.status(404).json({ success: false, error: `No deployment found for project '${projectId}'` });
    }
    return res.status(200).json(deployment);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Get Deployment Execution Logs
 */
async function getLogs(req, res) {
  try {
    const { projectId } = req.params;
    const deployment = orchestratorEngine.getStatus(projectId);
    if (!deployment) {
      return res.status(404).json({ success: false, error: `No deployment found for project '${projectId}'` });
    }
    return res.status(200).json({
      projectId,
      state: deployment.state,
      currentStage: deployment.currentStage,
      logs: deployment.logs || []
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Get Failure Root Cause Analysis
 */
async function getFailure(req, res) {
  try {
    const { projectId } = req.params;
    const deployment = orchestratorEngine.getStatus(projectId);
    if (!deployment) {
      return res.status(404).json({ success: false, error: `No deployment found for project '${projectId}'` });
    }
    return res.status(200).json({
      projectId,
      state: deployment.state,
      failure: deployment.failure || null
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Cancel Active Deployment
 */
async function cancel(req, res) {
  try {
    const { projectId } = req.params;
    const deployment = orchestratorEngine.cancel(projectId);
    return res.status(200).json({
      success: true,
      deployment
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  analyze,
  getRequirements,
  resolveRequirements,
  generatePlan,
  getPlan,
  runPreflight,
  deploy,
  getStatus,
  getLogs,
  getFailure,
  cancel
};
