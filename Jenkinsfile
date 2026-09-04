pipeline {
    agent any

    environment {
        PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    }

    stages {

        stage('Checkout') {
            steps {
                echo 'Project source code loaded from GitHub.'
            }
        }

        stage('Verify Jenkins') {
            steps {
                echo 'Jenkinsfile was successfully loaded from GitHub!'
            }
        }

    }
}
