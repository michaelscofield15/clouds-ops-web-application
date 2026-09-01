const ec2Service = require('../aws/ec2.service');
const ecrService = require('../aws/ecr.service');
const storageService = require('../storage.service');
const terraformClient = require('./terraform.client');
const terraformStateService = require('./terraform.state.service');

/**
 * Handles discovery and safe adoption/import of existing AWS resources into Terraform state.
 */
class TerraformAdoptionService {
  /**
   * Discovers existing AWS resources associated with a project ID
   */
  async discoverExistingResources(projectId, region = 'ap-south-1') {
    const project = storageService.getProject(projectId);
    const discovered = {
      projectId,
      hasExistingDeployment: false,
      resources: []
    };

    // 1. Check existing platform state in storage
    if (project && project.awsState) {
      discovered.hasExistingDeployment = true;
      if (project.awsState.ec2?.instanceId) {
        discovered.resources.push({
          type: 'aws_instance',
          address: 'aws_instance.app',
          id: project.awsState.ec2.instanceId,
          state: project.awsState.ec2.state,
          publicIp: project.awsState.ec2.publicIp,
          source: 'Platform AWS State'
        });
      }
      if (project.awsState.ecr?.repositoryName) {
        discovered.resources.push({
          type: 'aws_ecr_repository',
          address: 'aws_ecr_repository.app',
          id: project.awsState.ecr.repositoryName,
          repositoryUri: project.awsState.ecr.repositoryUri,
          source: 'Platform AWS State'
        });
      }
    }

    // 2. Discover via AWS tag querying
    try {
      const liveInstances = await ec2Service.listInstances({ region });
      for (const inst of liveInstances) {
        const hasTag = inst.tags?.some(
          (t) => (t.Key === 'ProjectId' && t.Value === projectId) || (t.Key === 'ManagedBy' && t.Value === 'CloudOpsPlatform')
        );
        if (hasTag && !discovered.resources.some((r) => r.id === inst.instanceId)) {
          discovered.resources.push({
            type: 'aws_instance',
            address: 'aws_instance.app',
            id: inst.instanceId,
            state: inst.state,
            publicIp: inst.publicIp,
            source: 'AWS Tag Discovery'
          });
        }
      }
    } catch {
      // Non-blocking if tag query fails
    }

    return discovered;
  }

  /**
   * Imports an existing AWS resource into the project's Terraform state
   */
  async adoptResource(projectId, resourceAddress, resourceId, options = {}) {
    const workspaceDir = terraformStateService.getWorkspaceDir(projectId);
    terraformClient.acquireLock(projectId);
    try {
      terraformStateService.startOperation(projectId, 'IMPORT');
      terraformStateService.addLog(
        projectId,
        `Importing existing AWS resource '${resourceId}' into Terraform address '${resourceAddress}'...`
      );

      const result = await terraformClient.importResource(workspaceDir, resourceAddress, resourceId, options);
      terraformStateService.completeOperation(projectId, result);
      return {
        success: true,
        resourceAddress,
        resourceId,
        stdout: result.stdout
      };
    } catch (err) {
      terraformStateService.failOperation(projectId, err);
      throw err;
    } finally {
      terraformClient.releaseLock(projectId);
    }
  }
}

module.exports = new TerraformAdoptionService();
module.exports.TerraformAdoptionService = TerraformAdoptionService;
