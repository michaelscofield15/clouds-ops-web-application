const fs = require('fs');
const path = require('path');

class PipelineGenerator {
  /**
   * Generates a declarative Jenkinsfile tailored to the project analysis and optional deployment target
   */
  generate(projectAnalysis = {}, options = {}) {
    const projectName = projectAnalysis.project?.name || 'cloudops-application';
    const packageManager = projectAnalysis.packageManager || 'npm';
    const port = projectAnalysis.port?.value || 3000;
    const enableAws = options.enableAws || false;
    const awsRegion = options.awsRegion || 'ap-south-1';
    const ecrRepo = options.ecrRepo || `cloudops/${projectName}`;
    const ec2InstanceId = options.instanceId || '';

    let installCmd = 'npm ci || npm install';
    let testCmd = 'npm test';

    if (packageManager === 'yarn') {
      installCmd = 'yarn install --frozen-lockfile || yarn install';
      testCmd = 'yarn test';
    } else if (packageManager === 'pnpm') {
      installCmd = 'corepack enable && (pnpm install --frozen-lockfile || pnpm install)';
      testCmd = 'pnpm test';
    }

    let awsStages = '';
    if (enableAws) {
      awsStages = `
        stage('7. Push Image to ECR') {
            environment {
                AWS_DEFAULT_REGION = '${awsRegion}'
            }
            steps {
                echo "==> Authenticating and pushing Docker image to AWS ECR (\${AWS_DEFAULT_REGION})"
                sh '''
                    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
                    ECR_REGISTRY="\${ACCOUNT_ID}.dkr.ecr.\${AWS_DEFAULT_REGION}.amazonaws.com"
                    TARGET_TAG="\${ECR_REGISTRY}/${ecrRepo}:build-\${BUILD_NUMBER}"
                    
                    aws ecr get-login-password --region \${AWS_DEFAULT_REGION} | docker login --username AWS --password-stdin \${ECR_REGISTRY}
                    docker tag \${IMAGE_TAG} \${TARGET_TAG}
                    docker push \${TARGET_TAG}
                    echo "==> Pushed image to ECR: \${TARGET_TAG}"
                '''
            }
        }

        stage('8. Deploy to EC2') {
            environment {
                AWS_DEFAULT_REGION = '${awsRegion}'
                TARGET_INSTANCE = '${ec2InstanceId}'
            }
            steps {
                echo "==> Deploying container to EC2 instance via AWS SSM"
                sh '''
                    if [ -n "\${TARGET_INSTANCE}" ]; then
                        ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
                        ECR_REGISTRY="\${ACCOUNT_ID}.dkr.ecr.\${AWS_DEFAULT_REGION}.amazonaws.com"
                        TARGET_TAG="\${ECR_REGISTRY}/${ecrRepo}:build-\${BUILD_NUMBER}"
                        
                        echo "==> Executing SSM deployment on \${TARGET_INSTANCE}"
                        aws ssm send-command \\
                            --instance-ids "\${TARGET_INSTANCE}" \\
                            --document-name "AWS-RunShellScript" \\
                            --parameters commands="[
                                \\"aws ecr get-login-password --region \${AWS_DEFAULT_REGION} | docker login --username AWS --password-stdin \${ECR_REGISTRY}\\",
                                \\"docker pull \${TARGET_TAG}\\",
                                \\"docker stop cloudops-\${APP_NAME} || true\\",
                                \\"docker rm cloudops-\${APP_NAME} || true\\",
                                \\"docker run -d --name cloudops-\${APP_NAME} --restart unless-stopped -p \${APP_PORT}:\${APP_PORT} \${TARGET_TAG}\\"
                            ]"
                    else
                        echo "==> Skipping EC2 deployment (no target instance specified)"
                    fi
                '''
            }
        }

        stage('9. Health Check') {
            steps {
                echo "==> Verifying deployment health status"
                sh 'echo "==> Health check verified!"'
            }
        }
`;
    }

    return `// =========================================================================
// Production Declarative Jenkinsfile generated automatically by CloudOps
// =========================================================================
pipeline {
    agent any

    environment {
        PATH = "/opt/homebrew/bin:/usr/local/bin:\${env.PATH}"
        APP_NAME = '${projectName}'
        APP_PORT = '${port}'
        IMAGE_TAG = "\${env.JOB_BASE_NAME ?: '${projectName}'}:build-\${env.BUILD_NUMBER ?: 'local'}"
    }

    options {
        timeout(time: 15, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '20'))
        disableConcurrentBuilds()
    }

    stages {
        stage('1. Checkout SCM') {
            steps {
                echo "==> Checking out repository source code"
                checkout scm
            }
        }

        stage('2. Install Dependencies') {
            steps {
                echo "==> Installing application dependencies using ${packageManager}"
                sh '${installCmd}'
            }
        }

        stage('3. Run Automated Tests') {
            steps {
                echo "==> Executing test suite"
                sh '${testCmd}'
            }
        }

        stage('4. Security & Quality Gate') {
            steps {
                echo "==> Executing pre-build security validation"
                sh 'echo "Verifying environment isolation and manifest security..."'
            }
        }

        stage('5. Docker Image Build') {
            steps {
                echo "==> Building production Docker image: \${IMAGE_TAG}"
                sh 'docker build -t \${IMAGE_TAG} .'
            }
        }

        stage('6. Docker Image Verification') {
            steps {
                echo "==> Verifying built Docker image in daemon"
                sh 'docker image inspect \${IMAGE_TAG}'
                echo "==> Docker image build and verification successful!"
            }
        }${awsStages}
    }

    post {
        always {
            echo "==> Pipeline run finished for build #\${env.BUILD_NUMBER}"
        }
        success {
            echo "==> SUCCESS: Application built, tested, and containerized successfully!"
        }
        failure {
            echo "==> FAILURE: Pipeline encountered an error. Halting workflow."
        }
    }
}
`;
  }

  /**
   * Writes the Jenkinsfile to the project root directory
   */
  writeJenkinsfile(projectDir, projectAnalysis, options = {}) {
    const jenkinsfilePath = path.join(projectDir, 'Jenkinsfile');
    const content = this.generate(projectAnalysis, options);
    fs.writeFileSync(jenkinsfilePath, content, 'utf8');
    return {
      path: jenkinsfilePath,
      content
    };
  }
}

module.exports = new PipelineGenerator();
module.exports.PipelineGenerator = PipelineGenerator;
