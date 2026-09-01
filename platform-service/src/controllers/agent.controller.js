const config = require('../config');
const agentService = require('../services/agent/agent.service');
const auditService = require('../services/audit.service');

class AgentController {
  /**
   * POST /api/agent/pair/request (Authenticated Tenant)
   */
  async requestPairing(req, res, next) {
    try {
      const orgId = req.organization?.id;
      const userId = req.user?.id;
      if (!orgId) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      }

      const pairing = agentService.createPairingCode({ organizationId: orgId, userId });
      const hostUrl = `${req.protocol}://${req.get('host')}`;
      const serverUrl = config.publicBaseUrl && !config.publicBaseUrl.includes('localhost') ? config.publicBaseUrl : hostUrl;
      return res.status(201).json({
        ...pairing,
        serverUrl
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/agent/pair/exchange (Agent CLI Endpoint)
   */
  async exchangePairing(req, res, next) {
    try {
      const { code, machineInfo } = req.body;
      if (!code) {
        return res.status(400).json({ error: 'Missing Code', message: 'Pairing code is required' });
      }

      const result = agentService.exchangePairingCode({ code, machineInfo });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(400).json({ error: 'Pairing Failed', message: err.message });
    }
  }

  /**
   * POST /api/agent/heartbeat (Agent CLI Endpoint with Bearer token)
   */
  async heartbeat(req, res, next) {
    try {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      const { agentId, dockerStatus } = req.body;

      if (!agentId || !token) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Agent ID and Bearer Token required' });
      }

      const result = agentService.recordHeartbeat(agentId, token, dockerStatus);
      return res.status(200).json(result);
    } catch (err) {
      return res.status(401).json({ error: 'Heartbeat Failed', message: err.message });
    }
  }

  /**
   * GET /api/agent/status (Authenticated Tenant)
   */
  async getStatus(req, res, next) {
    try {
      const orgId = req.organization?.id;
      if (!orgId) {
        return res.status(200).json({ connected: false, status: 'NOT_CONNECTED' });
      }

      const status = agentService.getAgentStatus(orgId);
      return res.status(200).json(status);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/agent/disconnect (Authenticated Tenant)
   */
  async disconnect(req, res, next) {
    try {
      const orgId = req.organization?.id;
      if (!orgId) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      }

      const result = agentService.disconnectAgent(orgId);
      return res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AgentController();
