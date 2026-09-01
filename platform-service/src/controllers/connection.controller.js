const providerConnectionService = require('../services/connections/provider.connection.service');

class ConnectionController {
  async listConnections(req, res) {
    try {
      const orgId = req.organization?.id;
      const connections = providerConnectionService.listConnections(orgId);
      res.status(200).json({ connections });
    } catch (err) {
      res.status(500).json({ error: 'ConnectionError', message: err.message });
    }
  }

  async createConnection(req, res) {
    try {
      const orgId = req.organization?.id;
      const userId = req.user?.id;
      const { provider, name, credentials, metadata } = req.body;

      const connection = await providerConnectionService.createConnection({
        organizationId: orgId,
        userId,
        provider,
        name,
        credentials,
        metadata
      });

      res.status(201).json({
        success: true,
        message: `${provider} connection created successfully.`,
        connection
      });
    } catch (err) {
      res.status(400).json({ error: 'ConnectionCreationError', message: err.message });
    }
  }

  async getConnection(req, res) {
    try {
      const orgId = req.organization?.id;
      const { id } = req.params;
      const connection = providerConnectionService.getConnection(id, orgId);

      if (!connection) {
        return res.status(404).json({ error: 'NotFound', message: `Connection '${id}' not found` });
      }

      res.status(200).json({ connection });
    } catch (err) {
      res.status(500).json({ error: 'ConnectionError', message: err.message });
    }
  }

  async testConnection(req, res) {
    try {
      const orgId = req.organization?.id;
      const { id } = req.params;
      const testResult = await providerConnectionService.testConnection(id, orgId);

      res.status(200).json({
        success: true,
        message: 'Connection verified successfully with remote provider.',
        result: testResult
      });
    } catch (err) {
      res.status(400).json({
        error: 'ConnectionVerificationFailed',
        message: err.message
      });
    }
  }

  async deleteConnection(req, res) {
    try {
      const orgId = req.organization?.id;
      const { id } = req.params;
      const deleted = providerConnectionService.deleteConnection(id, orgId);

      if (!deleted) {
        return res.status(404).json({ error: 'NotFound', message: `Connection '${id}' not found` });
      }

      res.status(200).json({
        success: true,
        message: `Connection '${id}' deleted successfully.`
      });
    } catch (err) {
      res.status(500).json({ error: 'ConnectionError', message: err.message });
    }
  }
}

module.exports = new ConnectionController();
