/**
 * Phase 6 AWS Configuration Settings
 */
const awsConfig = {
  region: process.env.AWS_REGION || 'ap-south-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  sessionToken: process.env.AWS_SESSION_TOKEN || '',
  defaultInstanceType: process.env.AWS_DEFAULT_INSTANCE_TYPE || 't3.micro',
  defaultArmInstanceType: process.env.AWS_DEFAULT_ARM_INSTANCE_TYPE || 't4g.micro',
  securityGroupName: process.env.AWS_SECURITY_GROUP_NAME || 'cloudops-app-sg',
  iamRoleName: process.env.AWS_IAM_ROLE_NAME || 'CloudOpsEC2SSMRole',
  instanceProfileName: process.env.AWS_INSTANCE_PROFILE_NAME || 'CloudOpsEC2SSMInstanceProfile',
  ssmTimeoutMs: parseInt(process.env.AWS_SSM_TIMEOUT_MS, 10) || 180000,
  healthCheckTimeoutMs: parseInt(process.env.AWS_HEALTH_TIMEOUT_MS, 10) || 30000,
  healthCheckRetries: parseInt(process.env.AWS_HEALTH_RETRIES, 10) || 10,
  healthCheckIntervalMs: parseInt(process.env.AWS_HEALTH_INTERVAL_MS, 10) || 3000,
  tags: {
    ManagedBy: 'CloudOpsPlatform',
    Environment: 'deployment',
    Component: 'application'
  }
};

module.exports = awsConfig;
