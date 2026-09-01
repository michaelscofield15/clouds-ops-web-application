const awsClient = require('./aws.client');
const config = require('../../config');

const getSSM = () => require('@aws-sdk/client-ssm');

class SSMService {
  /**
   * Waits for an EC2 instance to register and report 'Online' in AWS Systems Manager
   */
  async waitForInstanceOnline(instanceId, region = config.aws.region, maxWaitMs = config.aws.ssmTimeoutMs, onLog, clientOverride = null) {
    const log = (msg) => { if (typeof onLog === 'function') onLog(msg); };
    const ssm = (clientOverride || awsClient).getSSMClient(region);
    const start = Date.now();
    const pollIntervalMs = 5000;
    const { DescribeInstanceInformationCommand } = getSSM();

    log(`[SSM] Waiting for instance '${instanceId}' to register with AWS Systems Manager (Max wait: ${Math.round(maxWaitMs / 1000)}s)...`);

    while (Date.now() - start < maxWaitMs) {
      try {
        const describeCmd = new DescribeInstanceInformationCommand({
          Filters: [{ Key: 'InstanceIds', Values: [instanceId] }]
        });
        const res = await ssm.send(describeCmd);

        if (res.InstanceInformationList && res.InstanceInformationList.length > 0) {
          const info = res.InstanceInformationList[0];
          if (info.PingStatus === 'Online') {
            log(`[SSM] Instance '${instanceId}' is ONLINE in SSM (Agent version: ${info.AgentVersion}, Platform: ${info.PlatformName})`);
            return {
              online: true,
              agentVersion: info.AgentVersion,
              platformType: info.PlatformType,
              platformName: info.PlatformName
            };
          }
        }
      } catch (err) {
        // May fail initially before agent initializes
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    throw new Error(`Timed out after ${Math.round(maxWaitMs / 1000)}s waiting for instance '${instanceId}' to become Online in Systems Manager`);
  }

  /**
   * Executes shell commands on an EC2 instance via AWS Systems Manager Run Command
   */
  async executeCommand(instanceId, commands, options = {}) {
    const region = options.region || config.aws.region;
    const timeoutSeconds = options.timeoutSeconds || 120;
    const rawComment = options.comment || 'CloudOps Deployment Execution';
    const comment = typeof rawComment === 'string' ? rawComment.slice(0, 95) : 'CloudOps Deployment Execution';
    const ssm = (options.awsClient || options.clientOverride || awsClient).getSSMClient(region);
    const { SendCommandCommand, GetCommandInvocationCommand } = getSSM();

    if (!Array.isArray(commands) || commands.length === 0) {
      throw new Error('Commands must be a non-empty array of shell strings');
    }

    try {
      const sendCmd = new SendCommandCommand({
        DocumentName: 'AWS-RunShellScript',
        InstanceIds: [instanceId],
        Parameters: {
          commands,
          executionTimeout: [String(timeoutSeconds)]
        },
        Comment: comment,
        TimeoutSeconds: timeoutSeconds
      });

      const sendRes = await ssm.send(sendCmd);
      const commandId = sendRes.Command?.CommandId;

      if (!commandId) {
        throw new Error('SSM SendCommand did not return a valid CommandId');
      }

      // Poll for command execution completion
      const maxPollMs = (timeoutSeconds + 15) * 1000;
      const start = Date.now();
      const pollIntervalMs = 3000;

      while (Date.now() - start < maxPollMs) {
        await new Promise(r => setTimeout(r, pollIntervalMs));

        const getInvocationCmd = new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId
        });

        const inv = await ssm.send(getInvocationCmd);
        const status = inv.Status;

        if (status === 'Success') {
          return {
            success: true,
            status,
            commandId,
            responseCode: inv.ResponseCode,
            stdout: inv.StandardOutputContent || '',
            stderr: inv.StandardErrorContent || '',
            executionTime: inv.ExecutionElapsedTime || null
          };
        } else if (['Failed', 'Cancelled', 'TimedOut', 'Cancelling'].includes(status)) {
          const errMsg = inv.StandardErrorContent || inv.StandardOutputContent || `SSM Command finished with status '${status}'`;
          const err = new Error(errMsg);
          err.status = status;
          err.commandId = commandId;
          err.responseCode = inv.ResponseCode;
          err.stdout = inv.StandardOutputContent;
          err.stderr = inv.StandardErrorContent;
          throw err;
        }
      }

      throw new Error(`Timed out waiting for SSM Command '${commandId}' to complete on instance '${instanceId}'`);
    } catch (err) {
      throw new Error(`SSM Command Execution failed on instance '${instanceId}': ${err.message}`);
    }
  }

  /**
   * Deploys Docker container on the EC2 instance via SSM Run Command
   */
  async deployDockerContainer(instanceId, {
    ecrRegistryHost,
    targetImageUri,
    containerName,
    port = 3000,
    region = config.aws.region,
    awsClient: customAwsClient,
    clientOverride,
    onLog
  }) {
    const log = (msg) => { if (typeof onLog === 'function') onLog(msg); };
    const activeClient = customAwsClient || clientOverride || awsClient;

    log(`[SSM] Deploying container '${containerName}' to EC2 instance '${instanceId}'...`);

    const deployScript = [
      'set -e',
      'echo "==> Step 0: Verifying Docker daemon is active..."',
      'for i in {1..30}; do if systemctl is-active --quiet docker; then break; fi; echo "Waiting for docker daemon..."; sleep 2; done',
      'systemctl status docker --no-pager || true',
      'echo "==> Step 1: Authenticating Docker with AWS ECR..."',
      `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${ecrRegistryHost}`,
      'echo "==> Step 2: Pulling image from ECR..."',
      `docker pull ${targetImageUri}`,
      'echo "==> Step 3: Stopping and removing previous container on target port if active..."',
      `OLD_PORT_CONTAINERS=$(docker ps -q --filter "publish=${port}")`,
      'if [ -n "$OLD_PORT_CONTAINERS" ]; then docker stop $OLD_PORT_CONTAINERS || true; docker rm $OLD_PORT_CONTAINERS || true; fi',
      `docker stop ${containerName} || true`,
      `docker rm ${containerName} || true`,
      'echo "==> Step 4: Launching new Docker container..."',
      `docker run -d --name ${containerName} --restart unless-stopped -p ${port}:${port} ${targetImageUri}`,
      'echo "==> Step 5: Verifying container is running..."',
      `docker ps --filter name=${containerName}`,
      'echo "==> Step 6: Initial local health check on instance..."',
      'sleep 3',
      `curl -fsS http://localhost:${port}/health || curl -fsS http://localhost:${port}/ || true`,
      `echo "CONTAINER_ID_OUTPUT=$(docker inspect --format '{{.Id}}' ${containerName} 2>/dev/null || echo '')"`,
      'echo "==> Container deployed and active!"'
    ];

    const result = await this.executeCommand(instanceId, deployScript, {
      region,
      comment: `Deploy ${containerName} (${targetImageUri})`,
      awsClient: activeClient
    });

    let containerId = null;
    const match = result.stdout.match(/CONTAINER_ID_OUTPUT=([a-f0-9]+)/);
    if (match && match[1]) {
      containerId = match[1];
    }

    log(`[SSM] Container '${containerName}' started successfully on instance '${instanceId}' (Container ID: ${containerId ? containerId.slice(0, 12) : 'unknown'}).`);

    return {
      success: true,
      containerName,
      containerId,
      targetImageUri,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  /**
   * Directly queries SSM agent information for a specific instance
   */
  async getInstanceInformation(instanceId, region = config.aws.region, clientOverride = null) {
    const ssm = (clientOverride || awsClient).getSSMClient(region);
    try {
      const { DescribeInstanceInformationCommand } = getSSM();
      const describeCmd = new DescribeInstanceInformationCommand({
        Filters: [{ Key: 'InstanceIds', Values: [instanceId] }]
      });
      const res = await ssm.send(describeCmd);
      if (res.InstanceInformationList && res.InstanceInformationList.length > 0) {
        const info = res.InstanceInformationList[0];
        return {
          instanceId,
          region,
          source: 'AWS Systems Manager',
          pingStatus: info.PingStatus || 'UNKNOWN',
          isOnline: info.PingStatus === 'Online',
          agentVersion: info.AgentVersion || null,
          platformType: info.PlatformType || null,
          platformName: info.PlatformName || null,
          platformVersion: info.PlatformVersion || null,
          lastPingDateTime: info.LastPingDateTime ? new Date(info.LastPingDateTime).toISOString() : null,
          ipAddress: info.IPAddress || null
        };
      }
      return {
        instanceId,
        region,
        source: 'AWS Systems Manager',
        pingStatus: 'NOT_REGISTERED',
        isOnline: false,
        error: 'Instance not found in SSM Managed Instances list'
      };
    } catch (err) {
      return {
        instanceId,
        region,
        source: 'AWS Systems Manager',
        pingStatus: 'SSM_UNHEALTHY',
        isOnline: false,
        error: err.message || 'Failed to query SSM DescribeInstanceInformation'
      };
    }
  }

  /**
   * Retrieves real guest OS memory and disk utilization via SSM Run Command
   */
  async getSystemMetrics(instanceId, region = config.aws.region, clientOverride = null) {
    const commands = [
      'free -b',
      'echo "---DISK---"',
      'df -P /'
    ];

    try {
      const result = await this.executeCommand(instanceId, commands, {
        region,
        timeoutSeconds: 30,
        comment: 'CloudOps OS Metrics Probe',
        awsClient: clientOverride
      });

      const parts = result.stdout.split('---DISK---');
      const memoryRaw = parts[0] || '';
      const diskRaw = parts[1] || '';

      // 1. Parse free -b output
      // Mem:       999882752   432128000   123456789   ...   567754752
      let memory = {
        source: 'EC2 via SSM',
        status: 'UNAVAILABLE',
        totalBytes: null,
        usedBytes: null,
        availableBytes: null,
        freeBytes: null,
        usedPercentage: null
      };

      const memLine = memoryRaw.split('\n').find(l => l.trim().startsWith('Mem:'));
      if (memLine) {
        const tokens = memLine.trim().split(/\s+/);
        const total = parseInt(tokens[1], 10);
        const used = parseInt(tokens[2], 10);
        const free = parseInt(tokens[3], 10);
        const available = tokens[6] ? parseInt(tokens[6], 10) : (total - used);

        if (!isNaN(total) && total > 0) {
          const actualUsed = total - (available || free);
          const usedPct = Number(((actualUsed / total) * 100).toFixed(2));
          memory = {
            source: 'EC2 via SSM',
            status: 'AVAILABLE',
            totalBytes: total,
            usedBytes: actualUsed,
            availableBytes: available,
            freeBytes: free,
            totalMB: Math.round(total / (1024 * 1024)),
            usedMB: Math.round(actualUsed / (1024 * 1024)),
            availableMB: Math.round(available / (1024 * 1024)),
            usedPercentage: usedPct
          };
        }
      }

      // 2. Parse df -P / output
      // /dev/root   31457280   5242880   26214400      17% /
      let disk = {
        source: 'EC2 via SSM',
        status: 'UNAVAILABLE',
        filesystem: null,
        totalBytes: null,
        usedBytes: null,
        availableBytes: null,
        usedPercentage: null
      };

      const diskLines = diskRaw.trim().split('\n');
      if (diskLines.length >= 2) {
        const dataLine = diskLines[diskLines.length - 1].trim();
        const tokens = dataLine.split(/\s+/);
        if (tokens.length >= 6) {
          const filesystem = tokens[0];
          const totalBlocks = parseInt(tokens[1], 10); // 1024-byte blocks
          const usedBlocks = parseInt(tokens[2], 10);
          const availBlocks = parseInt(tokens[3], 10);
          const capacityStr = tokens[4]; // e.g. "17%"
          const usedPct = parseInt(capacityStr.replace('%', ''), 10);

          if (!isNaN(totalBlocks) && totalBlocks > 0) {
            disk = {
              source: 'EC2 via SSM',
              status: 'AVAILABLE',
              filesystem,
              totalBytes: totalBlocks * 1024,
              usedBytes: usedBlocks * 1024,
              availableBytes: availBlocks * 1024,
              totalGB: Number(((totalBlocks * 1024) / (1024 * 1024 * 1024)).toFixed(2)),
              usedGB: Number(((usedBlocks * 1024) / (1024 * 1024 * 1024)).toFixed(2)),
              availableGB: Number(((availBlocks * 1024) / (1024 * 1024 * 1024)).toFixed(2)),
              usedPercentage: isNaN(usedPct) ? null : usedPct
            };
          }
        }
      }

      return {
        instanceId,
        region,
        source: 'EC2 via SSM',
        timestamp: new Date().toISOString(),
        memory,
        disk
      };
    } catch (err) {
      return {
        instanceId,
        region,
        source: 'EC2 via SSM',
        timestamp: new Date().toISOString(),
        error: err.message,
        memory: { source: 'EC2 via SSM', status: 'UNAVAILABLE', error: err.message, usedPercentage: null },
        disk: { source: 'EC2 via SSM', status: 'UNAVAILABLE', error: err.message, usedPercentage: null }
      };
    }
  }

  /**
   * Retrieves Docker daemon and container status & statistics from EC2 instance
   */
  async getDockerMetrics(instanceId, containerName, region = config.aws.region) {
    const commands = [
      'systemctl is-active docker 2>/dev/null || echo "inactive"',
      'echo "---INSPECT---"',
      containerName ? `docker inspect ${containerName} 2>/dev/null || echo "CONTAINER_NOT_FOUND"` : 'echo "NO_CONTAINER"',
      'echo "---STATS---"',
      containerName ? `docker stats --no-stream --format '{{json .}}' ${containerName} 2>/dev/null || echo "STATS_UNAVAILABLE"` : 'echo "NO_CONTAINER"'
    ];

    try {
      const result = await this.executeCommand(instanceId, commands, {
        region,
        timeoutSeconds: 30,
        comment: `CloudOps Docker Probe (${containerName || 'daemon'})`
      });

      const parts = result.stdout.split(/---INSPECT---|---STATS---/);
      const daemonOutput = (parts[0] || '').trim();
      const inspectOutput = (parts[1] || '').trim();
      const statsOutput = (parts[2] || '').trim();

      // 1. Docker Daemon Status
      const isDaemonActive = daemonOutput.includes('active');
      const daemon = {
        source: 'Docker via SSM',
        status: isDaemonActive ? 'running' : 'stopped',
        isActive: isDaemonActive
      };

      // 2. Container Inspect
      let container = {
        source: 'Docker via SSM',
        name: containerName,
        status: 'CONTAINER_NOT_FOUND',
        state: 'unknown',
        containerId: null,
        image: null,
        restarts: 0,
        uptimeSeconds: null,
        startedAt: null,
        ports: null,
        oomKilled: false
      };

      if (inspectOutput && !inspectOutput.includes('CONTAINER_NOT_FOUND') && !inspectOutput.includes('NO_CONTAINER')) {
        try {
          const inspectData = JSON.parse(inspectOutput);
          const rawInfo = Array.isArray(inspectData) ? inspectData[0] : inspectData;
          if (rawInfo && rawInfo.State) {
            const state = rawInfo.State;
            const startedAt = state.StartedAt ? new Date(state.StartedAt) : null;
            const uptimeSeconds = (startedAt && state.Running) ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)) : 0;

            let status = 'stopped';
            if (state.Running) status = 'running';
            else if (state.Restarting) status = 'restarting';
            else if (state.Dead) status = 'dead';
            else if (state.OOMKilled) status = 'oom_killed';

            container = {
              source: 'Docker via SSM',
              name: rawInfo.Name ? rawInfo.Name.replace(/^\//, '') : containerName,
              containerId: rawInfo.Id ? rawInfo.Id.slice(0, 12) : null,
              fullContainerId: rawInfo.Id || null,
              image: rawInfo.Config?.Image || null,
              status,
              state: state.Status || status,
              isRunning: state.Running || false,
              restarts: rawInfo.RestartCount || 0,
              uptimeSeconds,
              startedAt: state.StartedAt || null,
              oomKilled: state.OOMKilled || false,
              ports: rawInfo.NetworkSettings?.Ports || null
            };
          }
        } catch {
          // JSON parsing fallback
        }
      }

      // 3. Container Stats
      let stats = {
        source: 'Docker via SSM',
        status: 'UNAVAILABLE',
        cpuPercent: null,
        memoryUsage: null,
        memoryLimit: null,
        memoryPercent: null,
        networkIO: null,
        blockIO: null,
        pids: null
      };

      if (statsOutput && !statsOutput.includes('STATS_UNAVAILABLE') && !statsOutput.includes('NO_CONTAINER')) {
        try {
          const parsedStats = JSON.parse(statsOutput);
          // CPUPerc: "0.02%", MemUsage: "24.16MiB / 954.2MiB", MemPerc: "2.53%", NetIO: "1.2kB / 0B", BlockIO: "0B / 0B", PIDs: "11"
          const cpuPct = parsedStats.CPUPerc ? parseFloat(parsedStats.CPUPerc.replace('%', '')) : null;
          const memPct = parsedStats.MemPerc ? parseFloat(parsedStats.MemPerc.replace('%', '')) : null;

          stats = {
            source: 'Docker via SSM',
            status: 'AVAILABLE',
            cpuPercent: isNaN(cpuPct) ? null : cpuPct,
            memoryUsageRaw: parsedStats.MemUsage || null,
            memoryPercent: isNaN(memPct) ? null : memPct,
            networkIO: parsedStats.NetIO || null,
            blockIO: parsedStats.BlockIO || null,
            pids: parsedStats.PIDs ? parseInt(parsedStats.PIDs, 10) : null
          };
        } catch {
          // Ignore
        }
      }

      return {
        instanceId,
        containerName,
        region,
        source: 'Docker via SSM',
        timestamp: new Date().toISOString(),
        daemon,
        container,
        stats
      };
    } catch (err) {
      return {
        instanceId,
        containerName,
        region,
        source: 'Docker via SSM',
        timestamp: new Date().toISOString(),
        error: err.message,
        daemon: { source: 'Docker via SSM', status: 'unavailable', isActive: false, error: err.message },
        container: { source: 'Docker via SSM', name: containerName, status: 'UNAVAILABLE', error: err.message },
        stats: { source: 'Docker via SSM', status: 'UNAVAILABLE', error: err.message }
      };
    }
  }

  /**
   * Retrieves bounded real container logs from EC2 instance
   */
  async getContainerLogs(instanceId, containerName, lines = 100, region = config.aws.region) {
    const boundedLines = Math.max(10, Math.min(500, parseInt(lines, 10) || 100));

    const commands = [
      `docker logs --tail ${boundedLines} --timestamps ${containerName} 2>&1 || docker logs --tail ${boundedLines} ${containerName} 2>&1 || echo "NO_LOGS_AVAILABLE"`
    ];

    try {
      const result = await this.executeCommand(instanceId, commands, {
        region,
        timeoutSeconds: 30,
        comment: `CloudOps Logs Tail (${containerName})`
      });

      let rawLogs = result.stdout || result.stderr || '';

      // Mask any sensitive credentials in log lines
      const sanitizedLogs = rawLogs
        .replace(/(AWS_SECRET_ACCESS_KEY|SECRET_KEY|PASSWORD|TOKEN|BEARER|SECRET)=([^\s\n]+)/gi, '$1=********')
        .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA****************')
        .replace(/ghp_[0-9a-zA-Z]{36}/g, 'ghp_************************************');

      const logLines = sanitizedLogs.split('\n').filter(l => l.length > 0);

      return {
        instanceId,
        containerName,
        region,
        source: 'Docker via SSM',
        linesCount: logLines.length,
        requestedLines: boundedLines,
        logs: sanitizedLogs,
        logLines,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      return {
        instanceId,
        containerName,
        region,
        source: 'Docker via SSM',
        error: err.message,
        linesCount: 0,
        logs: `Failed to retrieve logs from instance '${instanceId}': ${err.message}`,
        logLines: [],
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Performs an all-in-one consolidated monitoring probe over SSM in a single fast execution
   */
  async getFullMonitoringProbe(instanceId, containerName, lines = 100, region = config.aws.region) {
    const boundedLines = Math.max(10, Math.min(500, parseInt(lines, 10) || 100));

    const commands = [
      'free -b',
      'echo "===SECTION_SPLIT:DISK==="',
      'df -P /',
      'echo "===SECTION_SPLIT:DOCKER_DAEMON==="',
      'systemctl is-active docker 2>/dev/null || echo "inactive"',
      'echo "===SECTION_SPLIT:CONTAINER_INSPECT==="',
      containerName ? `docker inspect ${containerName} 2>/dev/null || echo "CONTAINER_NOT_FOUND"` : 'echo "NO_CONTAINER"',
      'echo "===SECTION_SPLIT:CONTAINER_STATS==="',
      containerName ? `docker stats --no-stream --format '{{json .}}' ${containerName} 2>/dev/null || echo "STATS_UNAVAILABLE"` : 'echo "NO_CONTAINER"',
      'echo "===SECTION_SPLIT:CONTAINER_LOGS==="',
      containerName ? `docker logs --tail ${boundedLines} --timestamps ${containerName} 2>&1 || echo "NO_LOGS_AVAILABLE"` : 'echo "NO_LOGS"'
    ];

    try {
      const result = await this.executeCommand(instanceId, commands, {
        region,
        timeoutSeconds: 30,
        comment: `CloudOps Full Monitor Probe (${containerName || 'instance'})`
      });

      const stdout = result.stdout || '';
      const sections = {};
      const parts = stdout.split(/===SECTION_SPLIT:([A-Z_]+)===\n?/);

      // Initial section is MEMORY
      sections.MEMORY = parts[0] || '';
      for (let i = 1; i < parts.length; i += 2) {
        const key = parts[i];
        const val = parts[i + 1] || '';
        sections[key] = val;
      }

      // 1. Memory
      let memory = { source: 'EC2 via SSM', status: 'UNAVAILABLE', totalBytes: null, usedBytes: null, availableBytes: null, freeBytes: null, usedPercentage: null };
      const memLine = (sections.MEMORY || '').split('\n').find(l => l.trim().startsWith('Mem:'));
      if (memLine) {
        const tokens = memLine.trim().split(/\s+/);
        const total = parseInt(tokens[1], 10);
        const used = parseInt(tokens[2], 10);
        const free = parseInt(tokens[3], 10);
        const available = tokens[6] ? parseInt(tokens[6], 10) : (total - used);
        if (!isNaN(total) && total > 0) {
          const actualUsed = total - (available || free);
          memory = {
            source: 'EC2 via SSM',
            status: 'AVAILABLE',
            totalBytes: total,
            usedBytes: actualUsed,
            availableBytes: available,
            freeBytes: free,
            totalMB: Math.round(total / (1024 * 1024)),
            usedMB: Math.round(actualUsed / (1024 * 1024)),
            availableMB: Math.round(available / (1024 * 1024)),
            usedPercentage: Number(((actualUsed / total) * 100).toFixed(2))
          };
        }
      }

      // 2. Disk
      let disk = { source: 'EC2 via SSM', status: 'UNAVAILABLE', filesystem: null, totalBytes: null, usedBytes: null, availableBytes: null, usedPercentage: null };
      const diskLines = (sections.DISK || '').trim().split('\n');
      if (diskLines.length >= 2) {
        const dataLine = diskLines[diskLines.length - 1].trim();
        const tokens = dataLine.split(/\s+/);
        if (tokens.length >= 6) {
          const totalBlocks = parseInt(tokens[1], 10);
          const usedBlocks = parseInt(tokens[2], 10);
          const availBlocks = parseInt(tokens[3], 10);
          const usedPct = parseInt(tokens[4].replace('%', ''), 10);
          if (!isNaN(totalBlocks) && totalBlocks > 0) {
            disk = {
              source: 'EC2 via SSM',
              status: 'AVAILABLE',
              filesystem: tokens[0],
              totalBytes: totalBlocks * 1024,
              usedBytes: usedBlocks * 1024,
              availableBytes: availBlocks * 1024,
              totalGB: Number(((totalBlocks * 1024) / (1024 * 1024 * 1024)).toFixed(2)),
              usedGB: Number(((usedBlocks * 1024) / (1024 * 1024 * 1024)).toFixed(2)),
              availableGB: Number(((availBlocks * 1024) / (1024 * 1024 * 1024)).toFixed(2)),
              usedPercentage: isNaN(usedPct) ? null : usedPct
            };
          }
        }
      }

      // 3. Docker Daemon
      const daemonOut = (sections.DOCKER_DAEMON || '').trim();
      const isDaemonActive = daemonOut.includes('active');
      const daemon = { source: 'Docker via SSM', status: isDaemonActive ? 'running' : 'stopped', isActive: isDaemonActive };

      // 4. Container Inspect
      let container = { source: 'Docker via SSM', name: containerName, status: 'CONTAINER_NOT_FOUND', state: 'unknown', containerId: null, image: null, restarts: 0, uptimeSeconds: null, startedAt: null, ports: null, oomKilled: false };
      const inspectOut = (sections.CONTAINER_INSPECT || '').trim();
      if (inspectOut && !inspectOut.includes('CONTAINER_NOT_FOUND') && !inspectOut.includes('NO_CONTAINER')) {
        try {
          const inspectData = JSON.parse(inspectOut);
          const rawInfo = Array.isArray(inspectData) ? inspectData[0] : inspectData;
          if (rawInfo && rawInfo.State) {
            const state = rawInfo.State;
            const startedAt = state.StartedAt ? new Date(state.StartedAt) : null;
            const uptimeSeconds = (startedAt && state.Running) ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)) : 0;
            let status = 'stopped';
            if (state.Running) status = 'running';
            else if (state.Restarting) status = 'restarting';
            else if (state.Dead) status = 'dead';
            else if (state.OOMKilled) status = 'oom_killed';

            container = {
              source: 'Docker via SSM',
              name: rawInfo.Name ? rawInfo.Name.replace(/^\//, '') : containerName,
              containerId: rawInfo.Id ? rawInfo.Id.slice(0, 12) : null,
              fullContainerId: rawInfo.Id || null,
              image: rawInfo.Config?.Image || null,
              status,
              state: state.Status || status,
              isRunning: state.Running || false,
              restarts: rawInfo.RestartCount || 0,
              uptimeSeconds,
              startedAt: state.StartedAt || null,
              oomKilled: state.OOMKilled || false,
              ports: rawInfo.NetworkSettings?.Ports || null
            };
          }
        } catch {}
      }

      // 5. Container Stats
      let stats = { source: 'Docker via SSM', status: 'UNAVAILABLE', cpuPercent: null, memoryUsageRaw: null, memoryPercent: null, networkIO: null, blockIO: null, pids: null };
      const statsOut = (sections.CONTAINER_STATS || '').trim();
      if (statsOut && !statsOut.includes('STATS_UNAVAILABLE') && !statsOut.includes('NO_CONTAINER')) {
        try {
          const parsedStats = JSON.parse(statsOut);
          const cpuPct = parsedStats.CPUPerc ? parseFloat(parsedStats.CPUPerc.replace('%', '')) : null;
          const memPct = parsedStats.MemPerc ? parseFloat(parsedStats.MemPerc.replace('%', '')) : null;
          stats = {
            source: 'Docker via SSM',
            status: 'AVAILABLE',
            cpuPercent: isNaN(cpuPct) ? null : cpuPct,
            memoryUsageRaw: parsedStats.MemUsage || null,
            memoryPercent: isNaN(memPct) ? null : memPct,
            networkIO: parsedStats.NetIO || null,
            blockIO: parsedStats.BlockIO || null,
            pids: parsedStats.PIDs ? parseInt(parsedStats.PIDs, 10) : null
          };
        } catch {}
      }

      // 6. Logs
      const rawLogs = (sections.CONTAINER_LOGS || '').trim();
      const sanitizedLogs = rawLogs
        .replace(/(AWS_SECRET_ACCESS_KEY|SECRET_KEY|PASSWORD|TOKEN|BEARER|SECRET)=([^\s\n]+)/gi, '$1=********')
        .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA****************')
        .replace(/ghp_[0-9a-zA-Z]{36}/g, 'ghp_************************************');

      const logLines = sanitizedLogs.split('\n').filter(l => l.length > 0 && !l.includes('===SECTION_SPLIT:'));
      const logs = {
        source: 'Docker via SSM',
        linesCount: logLines.length,
        requestedLines: boundedLines,
        logs: sanitizedLogs,
        logLines,
        timestamp: new Date().toISOString()
      };

      return {
        instanceId,
        containerName,
        region,
        source: 'EC2 + Docker via SSM',
        timestamp: new Date().toISOString(),
        memory,
        disk,
        daemon,
        container,
        stats,
        logs
      };
    } catch (err) {
      return {
        instanceId,
        containerName,
        region,
        source: 'EC2 + Docker via SSM',
        timestamp: new Date().toISOString(),
        error: err.message,
        memory: { source: 'EC2 via SSM', status: 'UNAVAILABLE', error: err.message },
        disk: { source: 'EC2 via SSM', status: 'UNAVAILABLE', error: err.message },
        daemon: { source: 'Docker via SSM', status: 'unavailable', isActive: false, error: err.message },
        container: { source: 'Docker via SSM', name: containerName, status: 'UNAVAILABLE', error: err.message },
        stats: { source: 'Docker via SSM', status: 'UNAVAILABLE', error: err.message },
        logs: { source: 'Docker via SSM', linesCount: 0, logLines: [], logs: err.message }
      };
    }
  }
}

module.exports = new SSMService();
module.exports.SSMService = SSMService;
