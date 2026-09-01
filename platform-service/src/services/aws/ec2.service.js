const awsClient = require('./aws.client');
const config = require('../../config');

const getEC2 = () => require('@aws-sdk/client-ec2');
const getIAM = () => require('@aws-sdk/client-iam');

class EC2Service {
  /**
   * Maps AWS EC2 instance architecture to OCI / Docker platform string
   * @param {string} arch EC2 architecture (e.g. 'x86_64', 'arm64', 'i386')
   * @returns {string} OCI platform string (e.g. 'linux/amd64', 'linux/arm64')
   */
  getPlatformForArchitecture(arch) {
    const clean = String(arch || '').toLowerCase().trim();
    if (clean === 'arm64' || clean === 'aarch64' || clean === 'linux/arm64') {
      return 'linux/arm64';
    }
    // Default to linux/amd64 for x86_64, amd64, x86, or unknown
    return 'linux/amd64';
  }

  /**
   * Resolves normalized architecture descriptors
   */
  resolveTargetPlatform(instOrArch) {
    const rawArch = typeof instOrArch === 'object' && instOrArch !== null
      ? (instOrArch.architecture || instOrArch.arch || 'x86_64')
      : String(instOrArch || 'x86_64');
    
    const platform = this.getPlatformForArchitecture(rawArch);
    const dockerArch = platform === 'linux/arm64' ? 'arm64' : 'amd64';
    const awsArch = platform === 'linux/arm64' ? 'arm64' : 'x86_64';

    return {
      platform,
      dockerArch,
      awsArch,
      isArm: platform === 'linux/arm64',
      isAmd64: platform === 'linux/amd64'
    };
  }

  /**
   * Retrieves instance details by ID (alias to validateExistingInstance)
   */
  async getInstanceDetails(instanceId, region = config.aws.region, clientOverride = null) {
    return this.validateExistingInstance(instanceId, region, clientOverride);
  }

  /**
   * Lists all EC2 instances in the target region for the authenticated tenant
   */
  async listInstances(region = config.aws.region, clientOverride = null) {
    const ec2 = (clientOverride || awsClient).getEC2Client(region);
    try {
      const { DescribeInstancesCommand } = getEC2();
      const res = await ec2.send(new DescribeInstancesCommand({}));
      const instances = [];

      for (const resv of (res.Reservations || [])) {
        for (const inst of (resv.Instances || [])) {
          const tags = (inst.Tags || []).reduce((acc, t) => {
            if (t.Key) acc[t.Key] = t.Value;
            return acc;
          }, {});

          const arch = inst.Architecture || 'x86_64';
          const platform = this.getPlatformForArchitecture(arch);

          instances.push({
            instanceId: inst.InstanceId,
            instanceType: inst.InstanceType,
            state: inst.State?.Name || 'unknown',
            publicIp: inst.PublicIpAddress || null,
            publicDns: inst.PublicDnsName || null,
            privateIp: inst.PrivateIpAddress || null,
            architecture: arch,
            platform,
            launchTime: inst.LaunchTime ? new Date(inst.LaunchTime).toISOString() : null,
            availabilityZone: inst.Placement?.AvailabilityZone || null,
            tags,
            name: tags.Name || inst.InstanceId
          });
        }
      }
      return instances;
    } catch (err) {
      throw new Error(`Failed to list EC2 instances in region '${region}': ${err.message}`);
    }
  }

  /**
   * Validates an existing EC2 instance by ID
   */
  async validateExistingInstance(instanceId, region = config.aws.region, clientOverride = null) {
    if (!instanceId || typeof instanceId !== 'string' || !instanceId.startsWith('i-')) {
      throw new Error(`Invalid EC2 instance ID format: '${instanceId}'`);
    }

    const ec2 = (clientOverride || awsClient).getEC2Client(region);

    try {
      const { DescribeInstancesCommand } = getEC2();
      const describeCmd = new DescribeInstancesCommand({
        InstanceIds: [instanceId]
      });
      const res = await ec2.send(describeCmd);

      if (!res.Reservations || res.Reservations.length === 0 || !res.Reservations[0].Instances || res.Reservations[0].Instances.length === 0) {
        throw new Error(`Instance '${instanceId}' not found in region '${region}'`);
      }

      const inst = res.Reservations[0].Instances[0];
      const stateName = inst.State?.Name || 'unknown';

      if (stateName !== 'running') {
        throw new Error(`EC2 instance '${instanceId}' is not in 'running' state (Current state: '${stateName}')`);
      }

      const arch = inst.Architecture || 'x86_64';
      const platform = this.getPlatformForArchitecture(arch);

      return {
        valid: true,
        instanceId: inst.InstanceId,
        instanceType: inst.InstanceType,
        state: stateName,
        publicIp: inst.PublicIpAddress || null,
        publicDns: inst.PublicDnsName || null,
        privateIp: inst.PrivateIpAddress || null,
        architecture: arch,
        platform,
        iamInstanceProfile: inst.IamInstanceProfile?.Arn || null,
        vpcId: inst.VpcId || null,
        subnetId: inst.SubnetId || null,
        availabilityZone: inst.Placement?.AvailabilityZone || null
      };
    } catch (err) {
      throw new Error(`Failed to validate EC2 instance '${instanceId}': ${err.message}`);
    }
  }

  /**
   * Discovers any existing running CloudOps EC2 instance
   */
  async findRunningCloudOpsInstance(region = config.aws.region, clientOverride = null) {
    const ec2 = (clientOverride || awsClient).getEC2Client(region);
    try {
      const { DescribeInstancesCommand } = getEC2();
      // First try to find instances tagged ManagedBy: CloudOps, CloudOpsPlatform, or cloudops
      let res = await ec2.send(new DescribeInstancesCommand({
        Filters: [
          { Name: 'tag:ManagedBy', Values: ['CloudOps', 'CloudOpsPlatform', 'cloudops'] },
          { Name: 'instance-state-name', Values: ['running'] }
        ]
      })).catch(() => null);

      if (!res || !res.Reservations || res.Reservations.length === 0) {
        // Fallback: discover any running instance in the account
        res = await ec2.send(new DescribeInstancesCommand({
          Filters: [
            { Name: 'instance-state-name', Values: ['running'] }
          ]
        })).catch(() => null);
      }

      for (const resv of (res?.Reservations || [])) {
        for (const inst of (resv.Instances || [])) {
          if (inst.State?.Name === 'running' && inst.PublicIpAddress) {
            const arch = inst.Architecture || 'x86_64';
            return {
              instanceId: inst.InstanceId,
              instanceType: inst.InstanceType,
              state: inst.State.Name,
              publicIp: inst.PublicIpAddress,
              publicDns: inst.PublicDnsName || null,
              privateIp: inst.PrivateIpAddress || null,
              architecture: arch,
              platform: this.getPlatformForArchitecture(arch),
              availabilityZone: inst.Placement?.AvailabilityZone || null
            };
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Discovers existing running EC2 instance specifically for the given tenant/project
   */
  async findCompatibleProjectInstance(projectId, organizationId = null, region = config.aws.region, clientOverride = null) {
    const ec2 = (clientOverride || awsClient).getEC2Client(region);
    try {
      const { DescribeInstancesCommand } = getEC2();
      
      // 1. Try finding instance tagged specifically with ProjectId and TenantId
      if (projectId) {
        const projectFilters = [
          { Name: 'tag:ProjectId', Values: [projectId] },
          { Name: 'instance-state-name', Values: ['running'] }
        ];
        if (organizationId) {
          projectFilters.push({ Name: 'tag:TenantId', Values: [organizationId] });
        }
        const projRes = await ec2.send(new DescribeInstancesCommand({ Filters: projectFilters })).catch(() => null);
        for (const resv of (projRes?.Reservations || [])) {
          for (const inst of (resv.Instances || [])) {
            if (inst.State?.Name === 'running' && inst.PublicIpAddress) {
              const arch = inst.Architecture || 'x86_64';
              return {
                instanceId: inst.InstanceId,
                instanceType: inst.InstanceType,
                state: inst.State.Name,
                publicIp: inst.PublicIpAddress,
                publicDns: inst.PublicDnsName || null,
                privateIp: inst.PrivateIpAddress || null,
                architecture: arch,
                platform: this.getPlatformForArchitecture(arch),
                availabilityZone: inst.Placement?.AvailabilityZone || null
              };
            }
          }
        }
      }

      // 2. Fallback: discover any running instance owned by this organization/tenant
      if (organizationId) {
        const orgRes = await ec2.send(new DescribeInstancesCommand({
          Filters: [
            { Name: 'tag:TenantId', Values: [organizationId] },
            { Name: 'instance-state-name', Values: ['running'] }
          ]
        })).catch(() => null);
        for (const resv of (orgRes?.Reservations || [])) {
          for (const inst of (resv.Instances || [])) {
            if (inst.State?.Name === 'running' && inst.PublicIpAddress) {
              const arch = inst.Architecture || 'x86_64';
              return {
                instanceId: inst.InstanceId,
                instanceType: inst.InstanceType,
                state: inst.State.Name,
                publicIp: inst.PublicIpAddress,
                publicDns: inst.PublicDnsName || null,
                privateIp: inst.PrivateIpAddress || null,
                architecture: arch,
                platform: this.getPlatformForArchitecture(arch),
                availabilityZone: inst.Placement?.AvailabilityZone || null
              };
            }
          }
        }
      }

      // 3. Fallback: general running CloudOps instance
      return await this.findRunningCloudOpsInstance(region, clientOverride);
    } catch {
      return null;
    }
  }

  /**
   * Calculates total active running/pending vCPUs across EC2 instances in region
   */
  async getRunningVcpus(region = config.aws.region, clientOverride = null) {
    const ec2 = (clientOverride || awsClient).getEC2Client(region);
    const { DescribeInstancesCommand } = getEC2();
    try {
      const res = await ec2.send(new DescribeInstancesCommand({
        Filters: [{ Name: 'instance-state-name', Values: ['running', 'pending'] }]
      }));

      const vcpuMap = {
        't3.nano': 2, 't3.micro': 2, 't3.small': 2, 't3.medium': 2, 't3.large': 2, 't3.xlarge': 4, 't3.2xlarge': 8,
        't4g.nano': 2, 't4g.micro': 2, 't4g.small': 2, 't4g.medium': 2, 't4g.large': 2, 't4g.xlarge': 4,
        't2.nano': 1, 't2.micro': 1, 't2.small': 1, 't2.medium': 2, 't2.large': 2,
        'c5.large': 2, 'c5.xlarge': 4, 'm5.large': 2, 'm5.xlarge': 4
      };

      let totalVcpus = 0;
      for (const resv of (res.Reservations || [])) {
        for (const inst of (resv.Instances || [])) {
          const type = inst.InstanceType || 't3.micro';
          totalVcpus += vcpuMap[type] || 2;
        }
      }
      return totalVcpus;
    } catch {
      return 0;
    }
  }

  /**
   * Checks if AWS EC2 vCPU quota allows provisioning an additional instance
   */
  async checkVcpuQuota(region = config.aws.region, requestedVcpus = 2, clientOverride = null, quotaLimit = 8) {
    const currentUsage = await this.getRunningVcpus(region, clientOverride);
    const available = Math.max(0, quotaLimit - currentUsage);
    const allowed = (currentUsage + requestedVcpus) <= quotaLimit;

    return {
      allowed,
      currentUsage,
      quota: quotaLimit,
      required: requestedVcpus,
      available
    };
  }

  /**
   * Safely cleans up temporary resources from a failed deployment attempt without touching live infrastructure
   */
  async cleanupFailedDeploymentResources(deploymentId, resourcesCreated = {}, protectedLiveInstanceId = null, region = config.aws.region, clientOverride = null) {
    const instanceToTerminate = resourcesCreated.instanceId;
    if (instanceToTerminate && instanceToTerminate !== protectedLiveInstanceId) {
      try {
        await this.terminateInstance(instanceToTerminate, region, clientOverride);
        return { cleaned: true, terminatedInstanceId: instanceToTerminate };
      } catch (err) {
        return { cleaned: false, error: err.message };
      }
    }
    return { cleaned: true, note: 'No ephemeral instance to clean up' };
  }

  /**
   * Discovers default VPC and available public subnets
   */
  async getDefaultVPCAndSubnet(region = config.aws.region, clientOverride = null) {
    const ec2 = (clientOverride || awsClient).getEC2Client(region);
    const { DescribeVpcsCommand, DescribeSubnetsCommand } = getEC2();

    const vpcRes = await ec2.send(new DescribeVpcsCommand({
      Filters: [{ Name: 'is-default', Values: ['true'] }]
    }));

    let vpcId;
    if (vpcRes.Vpcs && vpcRes.Vpcs.length > 0) {
      vpcId = vpcRes.Vpcs[0].VpcId;
    } else {
      // If no default VPC, get any available VPC
      const allVpcs = await ec2.send(new DescribeVpcsCommand({}));
      if (!allVpcs.Vpcs || allVpcs.Vpcs.length === 0) {
        throw new Error(`No VPC found in region '${region}'`);
      }
      vpcId = allVpcs.Vpcs[0].VpcId;
    }

    const subnetRes = await ec2.send(new DescribeSubnetsCommand({
      Filters: [{ Name: 'vpc-id', Values: [vpcId] }]
    }));

    if (!subnetRes.Subnets || subnetRes.Subnets.length === 0) {
      throw new Error(`No subnets found for VPC '${vpcId}' in region '${region}'`);
    }

    const subnet = subnetRes.Subnets[0];
    return {
      vpcId,
      subnetId: subnet.SubnetId,
      availabilityZone: subnet.AvailabilityZone
    };
  }

  /**
   * Ensures security group with application port ingress
   */
  async ensureSecurityGroup(vpcId, port = 3000, region = config.aws.region, tags = {}, clientOverride = null) {
    const ec2 = (clientOverride || awsClient).getEC2Client(region);
    const sgName = config.aws.securityGroupName;
    const { DescribeSecurityGroupsCommand, AuthorizeSecurityGroupIngressCommand, CreateSecurityGroupCommand } = getEC2();

    try {
      const describeRes = await ec2.send(new DescribeSecurityGroupsCommand({
        Filters: [
          { Name: 'group-name', Values: [sgName] },
          { Name: 'vpc-id', Values: [vpcId] }
        ]
      }));

      if (describeRes.SecurityGroups && describeRes.SecurityGroups.length > 0) {
        const existingSg = describeRes.SecurityGroups[0];
        // Check if port rule exists
        const hasPort = existingSg.IpPermissions?.some(p => p.FromPort === port && p.ToPort === port);
        if (!hasPort) {
          try {
            await ec2.send(new AuthorizeSecurityGroupIngressCommand({
              GroupId: existingSg.GroupId,
              IpPermissions: [{
                IpProtocol: 'tcp',
                FromPort: port,
                ToPort: port,
                IpRanges: [{ CidrIp: '0.0.0.0/0', Description: `CloudOps App Port ${port}` }]
              }]
            }));
          } catch (e) {
            // Ignore if duplicate
          }
        }
        return existingSg.GroupId;
      }
    } catch (err) {
      // Not found, will create
    }

    // Create Security Group
    const createRes = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: sgName,
      Description: 'CloudOps Platform Application Security Group',
      VpcId: vpcId,
      TagSpecifications: [{
        ResourceType: 'security-group',
        Tags: Object.entries({ ...config.aws.tags, ...tags }).map(([Key, Value]) => ({ Key, Value: String(Value) }))
      }]
    }));

    const groupId = createRes.GroupId;

    // Authorize application port
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: port,
        ToPort: port,
        IpRanges: [{ CidrIp: '0.0.0.0/0', Description: `CloudOps App Port ${port}` }]
      }]
    }));

    return groupId;
  }

  /**
   * Ensures IAM role and instance profile with SSM and ECR read policies
   */
  async ensureIAMInstanceProfile(clientOverride = null) {
    const iam = (clientOverride || awsClient).getIAMClient();
    const roleName = config.aws.iamRoleName;
    const profileName = config.aws.instanceProfileName;
    const { GetRoleCommand, CreateRoleCommand, AttachRolePolicyCommand, GetInstanceProfileCommand, CreateInstanceProfileCommand, AddRoleToInstanceProfileCommand } = getIAM();

    const trustPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Service: 'ec2.amazonaws.com' },
        Action: 'sts:AssumeRole'
      }]
    });

    // 1. Check or Create IAM Role
    try {
      await iam.send(new GetRoleCommand({ RoleName: roleName }));
    } catch (err) {
      if (err.name === 'NoSuchEntityException' || err.name === 'NoSuchEntity') {
        await iam.send(new CreateRoleCommand({
          RoleName: roleName,
          AssumeRolePolicyDocument: trustPolicy,
          Description: 'Role for EC2 instances managed by CloudOps via SSM and pulling from ECR',
          Tags: Object.entries(config.aws.tags).map(([Key, Value]) => ({ Key, Value: String(Value) }))
        }));
      } else {
        throw err;
      }
    }

    // 2. Attach Required Managed Policies
    const policies = [
      'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
      'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly'
    ];

    for (const policyArn of policies) {
      try {
        await iam.send(new AttachRolePolicyCommand({
          RoleName: roleName,
          PolicyArn: policyArn
        }));
      } catch (err) {
        // Policy may already be attached
      }
    }

    // 3. Check or Create Instance Profile
    let instanceProfileArn;
    try {
      const getProfileRes = await iam.send(new GetInstanceProfileCommand({
        InstanceProfileName: profileName
      }));
      instanceProfileArn = getProfileRes.InstanceProfile.Arn;
    } catch (err) {
      if (err.name === 'NoSuchEntityException' || err.name === 'NoSuchEntity') {
        const createProfileRes = await iam.send(new CreateInstanceProfileCommand({
          InstanceProfileName: profileName,
          Tags: Object.entries(config.aws.tags).map(([Key, Value]) => ({ Key, Value: String(Value) }))
        }));
        instanceProfileArn = createProfileRes.InstanceProfile.Arn;

        // Add Role to Profile
        try {
          await iam.send(new AddRoleToInstanceProfileCommand({
            InstanceProfileName: profileName,
            RoleName: roleName
          }));
        } catch (addErr) {
          // May already be associated
        }
      } else {
        throw err;
      }
    }

    return {
      roleName,
      instanceProfileName: profileName,
      instanceProfileArn
    };
  }

  /**
   * Finds the latest Amazon Linux 2023 AMI for target architecture
   */
  async getLatestAL2023AMI(arch = 'x86_64', region = config.aws.region, clientOverride = null) {
    const ec2 = (clientOverride || awsClient).getEC2Client(region);
    const archFilter = arch === 'arm64' ? 'arm64' : 'x86_64';
    const namePattern = `al2023-ami-2023.*-${archFilter}`;
    const { DescribeImagesCommand } = getEC2();

    try {
      const res = await ec2.send(new DescribeImagesCommand({
        Owners: ['amazon'],
        Filters: [
          { Name: 'name', Values: [namePattern] },
          { Name: 'state', Values: ['available'] },
          { Name: 'image-type', Values: ['machine'] }
        ]
      }));

      if (!res.Images || res.Images.length === 0) {
        throw new Error(`No Amazon Linux 2023 AMI found for architecture '${arch}' in region '${region}'`);
      }

      // Sort by creation date descending
      const sorted = res.Images.sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate));
      return sorted[0].ImageId;
    } catch (err) {
      throw new Error(`Failed to find AMI for ${arch} in ${region}: ${err.message}`);
    }
  }

  /**
   * Provisions a new EC2 instance with Docker and SSM pre-installed
   */
  async provisionInstance(options = {}) {
    const {
      port = 3000,
      arch = 'x86_64',
      instanceType,
      projectId,
      projectName,
      organizationId,
      environment = 'production',
      region = config.aws.region,
      onLog,
      awsClient: customAwsClient
    } = options;
    const log = (msg) => { if (typeof onLog === 'function') onLog(msg); };
    const activeClient = customAwsClient || awsClient;
    const ec2 = activeClient.getEC2Client(region);
    const { RunInstancesCommand, DescribeInstancesCommand } = getEC2();

    log(`[EC2] Discovering default VPC and subnet in region '${region}'...`);
    const network = await this.getDefaultVPCAndSubnet(region, activeClient);
    log(`[EC2] Network selected: VPC ${network.vpcId}, Subnet ${network.subnetId} (${network.availabilityZone})`);

    log(`[EC2] Configuring security group for application port ${port}...`);
    const securityGroupId = await this.ensureSecurityGroup(network.vpcId, port, region, { ProjectId: projectId }, activeClient);
    log(`[EC2] Security Group verified: ${securityGroupId}`);

    log(`[EC2] Ensuring IAM instance profile with SSM & ECR permissions...`);
    const iamProfile = await this.ensureIAMInstanceProfile(activeClient);
    log(`[EC2] IAM Instance Profile verified: ${iamProfile.instanceProfileName}`);

    const selectedArch = arch === 'arm64' ? 'arm64' : 'x86_64';
    const selectedInstanceType = instanceType || (selectedArch === 'arm64' ? config.aws.defaultArmInstanceType : config.aws.defaultInstanceType);

    log(`[EC2] Resolving latest Amazon Linux 2023 AMI for '${selectedArch}'...`);
    const imageId = await this.getLatestAL2023AMI(selectedArch, region, activeClient);
    log(`[EC2] AMI resolved: ${imageId} (Type: ${selectedInstanceType})`);

    log(`[EC2] Launching EC2 instance...`);

    // User data script installs Docker and SSM agent and enables them
    const userDataScript = Buffer.from(`#!/bin/bash
dnf update -y
dnf install -y docker amazon-ssm-agent
systemctl enable --now docker
systemctl enable --now amazon-ssm-agent
usermod -aG docker ec2-user
`).toString('base64');

    const runCmd = new RunInstancesCommand({
      ImageId: imageId,
      InstanceType: selectedInstanceType,
      MinCount: 1,
      MaxCount: 1,
      NetworkInterfaces: [{
        DeviceIndex: 0,
        SubnetId: network.subnetId,
        AssociatePublicIpAddress: true,
        Groups: [securityGroupId]
      }],
      IamInstanceProfile: { Name: iamProfile.instanceProfileName },
      UserData: userDataScript,
      TagSpecifications: [{
        ResourceType: 'instance',
        Tags: Object.entries({
          ManagedBy: 'CloudOps',
          TenantId: options.organizationId || options.tenantId || 'tenant-workspace',
          ProjectId: projectId,
          ProjectName: projectName,
          Environment: options.environment || 'production',
          Name: `cloudops-${projectId.slice(0, 8)}`
        }).map(([Key, Value]) => ({ Key, Value: String(Value) }))
      }]
    });

    // Retry launching instance if IAM instance profile is still propagating
    let runRes;
    let launchAttempts = 0;
    const maxLaunchAttempts = 6;

    while (launchAttempts < maxLaunchAttempts) {
      launchAttempts++;
      try {
        runRes = await ec2.send(runCmd);
        break;
      } catch (err) {
        if (
          (err.name === 'InvalidParameterValue' || err.message.includes('Invalid IAM Instance Profile') || err.message.includes('iamInstanceProfile')) &&
          launchAttempts < maxLaunchAttempts
        ) {
          log(`[EC2] IAM Instance Profile is propagating in AWS (Attempt ${launchAttempts}/${maxLaunchAttempts}). Retrying in 5s...`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          throw err;
        }
      }
    }

    const instanceId = runRes.Instances[0].InstanceId;
    log(`[EC2] Instance requested: ${instanceId}. Waiting for 'running' state and public IP...`);

    // Poll until running
    const maxWaitMs = 180000;
    const start = Date.now();
    let instanceDetails = null;

    while (Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, 5000));
      const describeRes = await ec2.send(new DescribeInstancesCommand({
        InstanceIds: [instanceId]
      }));

      const inst = describeRes.Reservations[0]?.Instances[0];
      if (inst && inst.State?.Name === 'running') {
        instanceDetails = {
          instanceId: inst.InstanceId,
          instanceType: inst.InstanceType,
          state: inst.State.Name,
          publicIp: inst.PublicIpAddress || null,
          publicDns: inst.PublicDnsName || null,
          privateIp: inst.PrivateIpAddress || null,
          architecture: inst.Architecture,
          availabilityZone: inst.Placement?.AvailabilityZone || null
        };
        break;
      }
    }

    if (!instanceDetails) {
      throw new Error(`Timed out waiting for EC2 instance '${instanceId}' to enter 'running' state`);
    }

    log(`[EC2] Instance is RUNNING: ${instanceDetails.instanceId} (Public IP: ${instanceDetails.publicIp})`);
    return instanceDetails;
  }

  /**
   * Terminates an EC2 instance
   */
  async terminateInstance(instanceId, region = config.aws.region, clientOverride = null) {
    const ec2 = (clientOverride || awsClient).getEC2Client(region);
    const { TerminateInstancesCommand } = getEC2();
    try {
      const res = await ec2.send(new TerminateInstancesCommand({
        InstanceIds: [instanceId]
      }));
      return {
        instanceId,
        previousState: res.TerminatingInstances?.[0]?.PreviousState?.Name,
        currentState: res.TerminatingInstances?.[0]?.CurrentState?.Name
      };
    } catch (err) {
      throw new Error(`Failed to terminate instance '${instanceId}': ${err.message}`);
    }
  }
}

module.exports = new EC2Service();
module.exports.EC2Service = EC2Service;
