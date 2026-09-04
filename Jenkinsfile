pipeline {
    agent any

    environment {
        PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

        AWS_REGION = "ap-south-1"

        ECR_REGISTRY = "979214968440.dkr.ecr.ap-south-1.amazonaws.com"
        ECR_REPOSITORY = "cloudops-platform"

        EKS_CLUSTER = "cloudops-platform-eks"
        K8S_DEPLOYMENT = "cloudops-platform"
        K8S_CONTAINER = "cloudops-platform"
        K8S_SERVICE = "cloudops-platform"

        IMAGE_TAG = "jenkins-${BUILD_NUMBER}"
        IMAGE_URI = "979214968440.dkr.ecr.ap-south-1.amazonaws.com/cloudops-platform:jenkins-${BUILD_NUMBER}"
    }

    stages {

        stage('Checkout') {
            steps {
                echo "Source code was checked out from GitHub."
            }
        }

        stage('Verify AWS Access') {
            steps {
                sh '''
                    set -e

                    echo "Checking AWS access..."
                    aws sts get-caller-identity

                    echo "AWS access verified."
                '''
            }
        }

        stage('Docker Build') {
            steps {
                sh '''
                    set -e

                    echo "Building Docker image for EKS..."

                    docker build \
                        --platform linux/amd64 \
                        -t ${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG} \
                        .

                    echo "Docker image built successfully."
                    docker images ${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}
                '''
            }
        }

        stage('ECR Login') {
            steps {
                sh '''
                    set -e

                    echo "Logging Docker into Amazon ECR..."

                    aws ecr get-login-password \
                        --region ${AWS_REGION} | \
                    docker login \
                        --username AWS \
                        --password-stdin ${ECR_REGISTRY}

                    echo "ECR login successful."
                '''
            }
        }

        stage('Push Image to ECR') {
            steps {
                sh '''
                    set -e

                    echo "Pushing image to Amazon ECR..."
                    echo "Image: ${IMAGE_URI}"

                    docker push ${IMAGE_URI}

                    echo "Image pushed successfully."
                '''
            }
        }

        stage('Configure Kubernetes') {
            steps {
                sh '''
                    set -e

                    echo "Configuring kubectl for EKS..."

                    aws eks update-kubeconfig \
                        --region ${AWS_REGION} \
                        --name ${EKS_CLUSTER}

                    echo "Checking EKS cluster access..."
                    kubectl get nodes

                    echo "Kubernetes access verified."
                '''
            }
        }

        stage('Deploy to EKS') {
            steps {
                sh '''
                    set -e

                    echo "Deploying image to EKS..."

                    kubectl set image deployment/${K8S_DEPLOYMENT} \
                        ${K8S_CONTAINER}=${IMAGE_URI}

                    echo "Deployment updated."
                '''
            }
        }

        stage('Wait for Rollout') {
            steps {
                sh '''
                    set -e

                    echo "Waiting for Kubernetes rollout..."

                    kubectl rollout status \
                        deployment/${K8S_DEPLOYMENT} \
                        --timeout=5m

                    echo "Rollout completed successfully."
                '''
            }
        }

        stage('Verify Deployment') {
            steps {
                sh '''
                    set -e

                    echo "Checking Kubernetes deployment..."
                    kubectl get deployment ${K8S_DEPLOYMENT}

                    echo ""
                    echo "Checking pods..."
                    kubectl get pods \
                        -l app=${K8S_DEPLOYMENT} \
                        -o wide

                    echo ""
                    echo "Checking service..."
                    kubectl get service ${K8S_SERVICE}

                    echo ""
                    echo "Deployment verification successful."
                '''
            }
        }

        stage('Show Public URL') {
            steps {
                script {
                    def loadBalancer = sh(
                        script: '''
                            kubectl get service ${K8S_SERVICE} \
                                -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
                        ''',
                        returnStdout: true
                    ).trim()

                    if (!loadBalancer) {
                        error("Load Balancer hostname was not available.")
                    }

                    echo ""
                    echo "=============================================="
                    echo "       CLOUDOPS DEPLOYMENT SUCCESSFUL"
                    echo "=============================================="
                    echo "Image: ${IMAGE_URI}"
                    echo "EKS Cluster: ${EKS_CLUSTER}"
                    echo "Load Balancer: ${loadBalancer}"
                    echo ""
                    echo "PUBLIC APPLICATION URL:"
                    echo "http://${loadBalancer}:4000"
                    echo "=============================================="
                }
            }
        }
    }

    post {
        success {
            echo "CI/CD pipeline completed successfully."
        }

        failure {
            echo "CI/CD pipeline failed. Check the stage above for the error."
        }
    }
}
