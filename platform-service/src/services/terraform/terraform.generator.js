const fs = require('fs');
const path = require('path');
const config = require('../../config');

/**
 * Generates dynamic, production-grade Terraform configurations based on project analysis.
 */
class TerraformGenerator {
  /**
   * Sanitizes names for AWS resource naming
   */
  _sanitizeName(name = 'app') {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);
  }

  /**
   * Generates all required Terraform configuration files in the project's terraform directory
   * @param {string} workspaceDir Path to temporary/projects/<id>/terraform/
   * @param {object} projectAnalysis Analysis object from Phase 2
   * @param {object} customOptions Custom overrides (region, port, instanceType, etc.)
   * @returns {object} Summary of generated files and variables
   */
  generate(workspaceDir, projectAnalysis = {}, customOptions = {}) {
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }

    const projectId = customOptions.projectId || projectAnalysis.projectId || 'cloudops-project';
    const rawProjectName = projectAnalysis.project?.name || customOptions.projectName || 'cloudops-app';
    const projectName = this._sanitizeName(rawProjectName);
    const port = customOptions.port || projectAnalysis.port?.value || 3000;
    const region = customOptions.region || config.aws.region || 'ap-south-1';
    const environment = customOptions.environment || 'production';
    const instanceType = customOptions.instanceType || 't3.micro';
    const ecrRepoName = customOptions.ecrRepositoryName || `cloudops-${projectName}`;

    // 1. versions.tf
    const versionsTf = `terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
`;

    // 2. provider.tf
    const providerTf = `provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}
`;

    // 3. variables.tf
    const variablesTf = `variable "project_id" {
  type        = string
  description = "Unique project identifier"
}

variable "project_name" {
  type        = string
  description = "Application project name"
}

variable "environment" {
  type        = string
  description = "Deployment environment"
  default     = "production"
}

variable "aws_region" {
  type        = string
  description = "AWS deployment region"
  default     = "ap-south-1"
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type"
  default     = "t3.micro"
}

variable "application_port" {
  type        = number
  description = "Application container listening port"
  default     = 3000
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for VPC"
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  type        = string
  description = "CIDR block for public subnet"
  default     = "10.0.1.0/24"
}

variable "ecr_repository_name" {
  type        = string
  description = "Name of the ECR container repository"
}
`;

    // 4. locals.tf
    const localsTf = `locals {
  name_prefix = "cloudops-\${var.project_name}"

  common_tags = {
    ManagedBy   = "CloudOpsPlatform"
    ProjectId   = var.project_id
    ProjectName = var.project_name
    Environment = var.environment
    Terraform   = "true"
  }
}
`;

    // 5. network.tf
    const networkTf = `resource "aws_vpc" "app" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-vpc"
  })
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.app.id
  cidr_block              = var.subnet_cidr
  map_public_ip_on_launch = true
  availability_zone       = "\${var.aws_region}a"

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-subnet-public"
  })
}

resource "aws_internet_gateway" "app" {
  vpc_id = aws_vpc.app.id

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-igw"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.app.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.app.id
  }

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-rt-public"
  })
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}
`;

    // 6. security.tf
    const securityTf = `resource "aws_security_group" "app" {
  name        = "\${local.name_prefix}-sg"
  description = "Security group for \${var.project_name} application"
  vpc_id      = aws_vpc.app.id

  ingress {
    description = "Application HTTP ingress"
    from_port   = var.application_port
    to_port     = var.application_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-sg"
  })
}
`;

    // 7. iam.tf
    const iamTf = `resource "aws_iam_role" "ec2_ssm_role" {
  name = "\${local.name_prefix}-ssm-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.ec2_ssm_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ec2_profile" {
  name = "\${local.name_prefix}-instance-profile"
  role = aws_iam_role.ec2_ssm_role.name
  tags = local.common_tags
}
`;

    // 8. ecr.tf
    const ecrTf = `resource "aws_ecr_repository" "app" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Name = var.ecr_repository_name
  })
}
`;

    // 9. ec2.tf
    const ec2Tf = `data "aws_ami" "amazon_linux_2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_instance" "app" {
  ami                  = data.aws_ami.amazon_linux_2023.id
  instance_type        = var.instance_type
  subnet_id            = aws_subnet.public.id
  iam_instance_profile = aws_iam_instance_profile.ec2_profile.name

  vpc_security_group_ids = [
    aws_security_group.app.id
  ]

  user_data = <<-EOF
              #!/bin/bash
              dnf update -y
              dnf install -y docker
              systemctl start docker
              systemctl enable docker
              usermod -aG docker ec2-user
              dnf install -y amazon-ssm-agent
              systemctl enable amazon-ssm-agent
              systemctl start amazon-ssm-agent
              EOF

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-ec2"
  })

  depends_on = [
    aws_iam_role_policy_attachment.ssm_core,
    aws_route_table_association.public
  ]
}
`;

    // 10. outputs.tf
    const outputsTf = `output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.app.id
}

output "subnet_id" {
  description = "Public Subnet ID"
  value       = aws_subnet.public.id
}

output "security_group_id" {
  description = "Security Group ID"
  value       = aws_security_group.app.id
}

output "iam_role_name" {
  description = "IAM Role Name"
  value       = aws_iam_role.ec2_ssm_role.name
}

output "iam_instance_profile" {
  description = "IAM Instance Profile Name"
  value       = aws_iam_instance_profile.ec2_profile.name
}

output "ecr_repository_url" {
  description = "ECR Repository URL"
  value       = aws_ecr_repository.app.repository_url
}

output "ecr_repository_name" {
  description = "ECR Repository Name"
  value       = aws_ecr_repository.app.name
}

output "ec2_instance_id" {
  description = "EC2 Instance ID"
  value       = aws_instance.app.id
}

output "ec2_public_ip" {
  description = "EC2 Public IPv4 Address"
  value       = aws_instance.app.public_ip
}

output "application_url" {
  description = "Application Live URL"
  value       = "http://\${aws_instance.app.public_ip}:\${var.application_port}/health"
}
`;

    // 11. terraform.tfvars
    const tfvars = `project_id          = "${projectId}"
project_name        = "${projectName}"
environment         = "${environment}"
aws_region          = "${region}"
instance_type       = "${instanceType}"
application_port    = ${port}
vpc_cidr            = "10.0.0.0/16"
subnet_cidr         = "10.0.1.0/24"
ecr_repository_name = "${ecrRepoName}"
`;

    const files = {
      'versions.tf': versionsTf,
      'provider.tf': providerTf,
      'variables.tf': variablesTf,
      'locals.tf': localsTf,
      'network.tf': networkTf,
      'security.tf': securityTf,
      'iam.tf': iamTf,
      'ecr.tf': ecrTf,
      'ec2.tf': ec2Tf,
      'outputs.tf': outputsTf,
      'terraform.tfvars': tfvars
    };

    for (const [filename, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(workspaceDir, filename), content, 'utf8');
    }

    return {
      workspaceDir,
      projectId,
      projectName,
      region,
      port,
      ecrRepoName,
      filesGenerated: Object.keys(files),
      createdAt: new Date().toISOString()
    };
  }
}

module.exports = new TerraformGenerator();
module.exports.TerraformGenerator = TerraformGenerator;
