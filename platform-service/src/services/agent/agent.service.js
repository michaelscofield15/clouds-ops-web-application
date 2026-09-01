const crypto = require('crypto');
const db = require('../db/db.service');
const auditService = require('../audit.service');

const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const HEARTBEAT_TIMEOUT_MS = 60 * 1000; // 60 seconds

class AgentService {
  /**
   * Generates a short-lived single-use pairing code for a tenant
   */
  createPairingCode({ organizationId, userId }) {
    if (!organizationId) {
      throw new Error('Organization context is required to generate pairing code');
    }

    const code = `PAIR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const pairing = {
      id: `pair-${crypto.randomUUID()}`,
      code,
      organizationId,
      userId: userId || 'usr-default',
      used: false,
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString()
    };

    db.insert('agent_pairings', pairing);

    auditService.log('system', 'AGENT_PAIRING_REQUESTED', 'SUCCESS', {
      organizationId,
      userId,
      code
    });

    return {
      code,
      expiresAt: pairing.expiresAt,
      ttlSeconds: PAIRING_TTL_MS / 1000
    };
  }

  /**
   * Exchanges pairing code for a permanent agent token
   */
  exchangePairingCode({ code, machineInfo = {} }) {
    if (!code) {
      throw new Error('Pairing code is required');
    }

    const cleanCode = code.trim().toUpperCase();
    const pairing = db.findOne('agent_pairings', { code: cleanCode, used: false });

    if (!pairing) {
      throw new Error('Invalid or already used pairing code');
    }

    if (new Date(pairing.expiresAt).getTime() < Date.now()) {
      throw new Error('Pairing code has expired. Please generate a new one in CloudOps settings.');
    }

    // Mark pairing as used
    db.update('agent_pairings', pairing.id, { used: true, usedAt: new Date().toISOString() });

    const org = db.findById('organizations', pairing.organizationId) || { name: 'Tenant Workspace' };
    const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const agentToken = `agtok_${crypto.randomBytes(24).toString('hex')}`;

    // Clean up existing agent for this organization if any
    const existingAgents = db.find('docker_agents', { organizationId: pairing.organizationId });
    for (const ea of existingAgents) {
      db.delete('docker_agents', ea.id);
    }

    const agentRecord = {
      id: agentId,
      organizationId: pairing.organizationId,
      userId: pairing.userId,
      agentToken,
      machineInfo: {
        hostname: machineInfo.hostname || 'localhost',
        os: machineInfo.os || process.platform,
        arch: machineInfo.arch || process.arch,
        dockerVersion: machineInfo.dockerVersion || 'Docker Engine',
        agentVersion: machineInfo.agentVersion || '1.0.0'
      },
      status: 'ONLINE',
      dockerStatus: {
        running: true,
        version: machineInfo.dockerVersion || 'Docker Engine'
      },
      lastHeartbeat: new Date().toISOString()
    };

    db.insert('docker_agents', agentRecord);

    auditService.log('system', 'AGENT_PAIRED', 'SUCCESS', {
      organizationId: pairing.organizationId,
      agentId,
      hostname: agentRecord.machineInfo.hostname
    });

    return {
      agentId,
      agentToken,
      organizationId: pairing.organizationId,
      organizationName: org.name
    };
  }

  /**
   * Verifies agent token and updates heartbeat
   */
  recordHeartbeat(agentId, agentToken, dockerStatus = {}) {
    const agent = db.findOne('docker_agents', { id: agentId, agentToken });
    if (!agent) {
      throw new Error('Unauthorized agent: Invalid credentials');
    }

    const updated = db.update('docker_agents', agentId, {
      status: 'ONLINE',
      dockerStatus: {
        running: dockerStatus.running !== false,
        version: dockerStatus.version || agent.dockerStatus?.version || 'Docker Engine',
        containersCount: dockerStatus.containersCount || 0,
        imagesCount: dockerStatus.imagesCount || 0
      },
      lastHeartbeat: new Date().toISOString()
    });

    return {
      success: true,
      agentId,
      status: 'ONLINE',
      lastHeartbeat: updated.lastHeartbeat
    };
  }

  /**
   * Retrieves active agent status for an organization
   */
  getAgentStatus(organizationId) {
    if (!organizationId) return { connected: false, status: 'NOT_CONNECTED' };

    const agent = db.findOne('docker_agents', { organizationId });
    if (!agent) {
      return { connected: false, status: 'NOT_CONNECTED' };
    }

    const lastBeat = new Date(agent.lastHeartbeat).getTime();
    const isOnline = Date.now() - lastBeat < HEARTBEAT_TIMEOUT_MS;

    if (!isOnline && agent.status === 'ONLINE') {
      db.update('docker_agents', agent.id, { status: 'OFFLINE' });
      agent.status = 'OFFLINE';
    }

    return {
      connected: isOnline,
      status: isOnline ? 'ONLINE' : 'OFFLINE',
      organizationId: agent.organizationId,
      agentId: agent.id,
      machineInfo: agent.machineInfo,
      dockerStatus: agent.dockerStatus,
      lastHeartbeat: agent.lastHeartbeat
    };
  }

  /**
   * Disconnects an agent for an organization
   */
  disconnectAgent(organizationId) {
    const agent = db.findOne('docker_agents', { organizationId });
    if (!agent) return { success: true, message: 'No agent was connected' };

    db.delete('docker_agents', agent.id);
    auditService.log('system', 'AGENT_DISCONNECTED', 'SUCCESS', {
      organizationId,
      agentId: agent.id
    });

    return { success: true, message: 'Agent disconnected successfully' };
  }
}

module.exports = new AgentService();
