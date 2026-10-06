terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "Kanakku"
      ManagedBy   = "Terraform"
      Environment = var.environment
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

# ------------------------------------------------------------------------------
# 1. VPC, Subnets & Internet / NAT Gateways for Secure Egress
# ------------------------------------------------------------------------------
resource "aws_vpc" "kanakku_vpc" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "kanakku-${var.environment}-vpc"
  }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.kanakku_vpc.id

  tags = {
    Name = "kanakku-${var.environment}-igw"
  }
}

# Public Subnets (For NAT Gateway & Ingress)
resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.kanakku_vpc.id
  cidr_block              = "10.0.10.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name = "kanakku-${var.environment}-public-a"
  }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.kanakku_vpc.id
  cidr_block              = "10.0.20.0/24"
  availability_zone       = data.aws_availability_zones.available.names[1]
  map_public_ip_on_launch = true

  tags = {
    Name = "kanakku-${var.environment}-public-b"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.kanakku_vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = {
    Name = "kanakku-${var.environment}-public-rt"
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

# NAT Gateway for Secure Outbound Egress from Private Subnets
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name = "kanakku-${var.environment}-nat-eip"
  }
}

resource "aws_nat_gateway" "nat" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public_a.id

  tags = {
    Name = "kanakku-${var.environment}-nat"
  }

  depends_on = [aws_internet_gateway.igw]
}

# Private Subnets (Isolated for RDS, VPC Endpoints & App Runner VPC Connector)
resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.kanakku_vpc.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = data.aws_availability_zones.available.names[0]

  tags = {
    Name = "kanakku-${var.environment}-private-a"
  }
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.kanakku_vpc.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = data.aws_availability_zones.available.names[1]

  tags = {
    Name = "kanakku-${var.environment}-private-b"
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.kanakku_vpc.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat.id
  }

  tags = {
    Name = "kanakku-${var.environment}-private-rt"
  }
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private.id
}

# ------------------------------------------------------------------------------
# 2. Security Groups
# ------------------------------------------------------------------------------
resource "aws_security_group" "apprunner_connector_sg" {
  name        = "kanakku-${var.environment}-apprunner-sg"
  description = "Security group for App Runner VPC Connector"
  vpc_id      = aws_vpc.kanakku_vpc.id

  egress {
    description = "Allow egress to RDS PostgreSQL"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.kanakku_vpc.cidr_block]
  }

  egress {
    description = "Allow HTTPS outbound for AWS APIs and external services via NAT"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "kanakku-${var.environment}-apprunner-sg"
  }
}

resource "aws_security_group" "rds_sg" {
  name        = "kanakku-${var.environment}-rds-sg"
  description = "Security group for Amazon RDS PostgreSQL"
  vpc_id      = aws_vpc.kanakku_vpc.id

  ingress {
    description     = "Allow inbound PostgreSQL strictly from App Runner VPC connector"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.apprunner_connector_sg.id]
  }

  egress {
    description = "Disallow all outbound connections from RDS"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "kanakku-${var.environment}-rds-sg"
  }
}

resource "aws_security_group" "vpc_endpoints_sg" {
  name        = "kanakku-${var.environment}-vpc-endpoints-sg"
  description = "Security group for AWS PrivateLink VPC Endpoints"
  vpc_id      = aws_vpc.kanakku_vpc.id

  ingress {
    description     = "Allow HTTPS from App Runner VPC Connector"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.apprunner_connector_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "kanakku-${var.environment}-vpc-endpoints-sg"
  }
}

# ------------------------------------------------------------------------------
# 3. AWS PrivateLink VPC Endpoints (SecretsManager, CloudWatch Logs, Bedrock)
# ------------------------------------------------------------------------------
resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = aws_vpc.kanakku_vpc.id
  service_name        = "com.amazonaws.${var.aws_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  security_group_ids  = [aws_security_group.vpc_endpoints_sg.id]
  private_dns_enabled = true

  tags = {
    Name = "kanakku-${var.environment}-vpce-secretsmanager"
  }
}

resource "aws_vpc_endpoint" "logs" {
  vpc_id              = aws_vpc.kanakku_vpc.id
  service_name        = "com.amazonaws.${var.aws_region}.logs"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  security_group_ids  = [aws_security_group.vpc_endpoints_sg.id]
  private_dns_enabled = true

  tags = {
    Name = "kanakku-${var.environment}-vpce-logs"
  }
}

resource "aws_vpc_endpoint" "bedrock_runtime" {
  vpc_id              = aws_vpc.kanakku_vpc.id
  service_name        = "com.amazonaws.${var.aws_region}.bedrock-runtime"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  security_group_ids  = [aws_security_group.vpc_endpoints_sg.id]
  private_dns_enabled = true

  tags = {
    Name = "kanakku-${var.environment}-vpce-bedrock"
  }
}

# ------------------------------------------------------------------------------
# 4. Amazon RDS PostgreSQL 16
# ------------------------------------------------------------------------------
resource "aws_db_subnet_group" "kanakku_db_subnets" {
  name       = "kanakku-${var.environment}-db-subnets"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]

  tags = {
    Name = "kanakku-${var.environment}-db-subnets"
  }
}

resource "random_password" "db_master_password" {
  length           = 24
  special          = true
  override_special = "!-_=+."
}

# Separate least-privilege password for application runtime containers
resource "random_password" "db_app_password" {
  length           = 24
  special          = true
  override_special = "!-_=+."
}

resource "aws_db_instance" "postgres16" {
  identifier             = "kanakku-${var.environment}-pg16"
  engine                 = "postgres"
  engine_version         = "16.2"
  instance_class         = var.db_instance_class
  allocated_storage      = var.db_allocated_storage
  max_allocated_storage  = 200
  storage_type           = "gp3"
  storage_encrypted      = true
  db_name                = "kanakkudb"
  username               = "kanakku_admin"
  password               = random_password.db_master_password.result
  db_subnet_group_name   = aws_db_subnet_group.kanakku_db_subnets.name
  vpc_security_group_ids = [aws_security_group.rds_sg.id]
  skip_final_snapshot    = true
  deletion_protection    = true
  multi_az               = true

  tags = {
    Name = "kanakku-${var.environment}-postgres16"
  }
}

# ------------------------------------------------------------------------------
# 5. AWS Secrets Manager: Database Credentials & Audit Anchor Secrets
# ------------------------------------------------------------------------------
# Least-privilege runtime connection string secret injected directly into App Runner DATABASE_URL
resource "aws_secretsmanager_secret" "database_url" {
  name                    = "kanakku/${var.environment}/database-url"
  description             = "Least-privilege runtime PostgreSQL connection string for Kanakku applications (kanakku_app)"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "database_url_val" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://kanakku_app:${urlencode(random_password.db_app_password.result)}@${aws_db_instance.postgres16.address}:5432/${aws_db_instance.postgres16.db_name}?sslmode=require"
}

# Administrative credentials secret for schema migrations, DDL, and database maintenance only
# Not accessible to application runtime containers
resource "aws_secretsmanager_secret" "database_admin_credentials" {
  name                    = "kanakku/${var.environment}/database-admin-credentials"
  description             = "Administrative master credentials for Kanakku database migrations and maintenance (kanakku_admin)"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "database_admin_credentials_val" {
  secret_id = aws_secretsmanager_secret.database_admin_credentials.id
  secret_string = jsonencode({
    DATABASE_URL = "postgresql://${aws_db_instance.postgres16.username}:${urlencode(random_password.db_master_password.result)}@${aws_db_instance.postgres16.address}:5432/${aws_db_instance.postgres16.db_name}?sslmode=require"
    DB_HOST      = aws_db_instance.postgres16.address
    DB_PORT      = 5432
    DB_NAME      = aws_db_instance.postgres16.db_name
    DB_USER      = aws_db_instance.postgres16.username
    DB_PASSWORD  = random_password.db_master_password.result
  })
}

resource "random_password" "audit_anchor_secret" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "audit_anchor_secret" {
  name                    = "kanakku/${var.environment}/audit-anchor-secret"
  description             = "Cryptographic HMAC signing secret for CloudWatch audit trail anchors"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "audit_anchor_secret_val" {
  secret_id     = aws_secretsmanager_secret.audit_anchor_secret.id
  secret_string = random_password.audit_anchor_secret.result
}

# ------------------------------------------------------------------------------
# 6. AWS App Runner VPC Connector
# ------------------------------------------------------------------------------
resource "aws_apprunner_vpc_connector" "rds_connector" {
  vpc_connector_name = "kanakku-${var.environment}-connector"
  subnets            = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  security_groups    = [aws_security_group.apprunner_connector_sg.id]
}

# ------------------------------------------------------------------------------
# 7. Amazon ECR Repositories for Docker Images
# ------------------------------------------------------------------------------
resource "aws_ecr_repository" "mcp_server" {
  name                 = "kanakku-mcp-server"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "kanakku-mcp-server-ecr"
  }
}

resource "aws_ecr_repository" "console" {
  name                 = "kanakku-console"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "kanakku-console-ecr"
  }
}

# ------------------------------------------------------------------------------
# 8. IAM Roles for App Runner
# ------------------------------------------------------------------------------
# Role for App Runner to pull images from Amazon ECR
resource "aws_iam_role" "apprunner_access_role" {
  name = "kanakku-${var.environment}-ecr-access-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "build.apprunner.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "apprunner_access_role_attach" {
  role       = aws_iam_role.apprunner_access_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# Instance Role assumed by running containers (Least Privilege)
resource "aws_iam_role" "apprunner_instance_role" {
  name = "kanakku-${var.environment}-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "tasks.apprunner.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_policy" "kanakku_apprunner_policy" {
  name        = "kanakku-${var.environment}-apprunner-policy"
  description = "Permissions for Bedrock Converse API, Secrets Manager, and CloudWatch"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream"
        ]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-*",
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          aws_secretsmanager_secret.database_url.arn,
          aws_secretsmanager_secret.audit_anchor_secret.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = [
          "arn:aws:logs:*:*:log-group:/kanakku/*",
          "arn:aws:logs:*:*:log-group:/kanakku/*:*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "apprunner_policy_attach" {
  role       = aws_iam_role.apprunner_instance_role.name
  policy_arn = aws_iam_policy.kanakku_apprunner_policy.arn
}

# ------------------------------------------------------------------------------
# 9. CloudWatch Log Group for Audit Trail Anchoring (ADR-005)
# ------------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "audit_anchors" {
  name              = "/kanakku/${var.environment}/audit-anchors"
  retention_in_days = 365 # 365-day log event retention policy

  tags = {
    Name = "kanakku-${var.environment}-audit-anchors"
  }
}

# ------------------------------------------------------------------------------
# 10. AWS App Runner Services (Image-Based Container Deployments)
# Staged creation: controlled by var.enable_apprunner_services so initial bootstrap apply
# provisions ECR, RDS, VPC & Secrets cleanly before images are pushed.
# ------------------------------------------------------------------------------
resource "aws_apprunner_service" "mcp_server" {
  count        = var.enable_apprunner_services ? 1 : 0
  service_name = "kanakku-${var.environment}-mcp-server"

  source_configuration {
    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_access_role.arn
    }
    image_repository {
      image_identifier      = "${aws_ecr_repository.mcp_server.repository_url}:${var.mcp_image_tag}"
      image_repository_type = "ECR"
      image_configuration {
        port = "3001"
        runtime_environment_variables = {
          NODE_ENV                   = "production"
          PORT                       = "3001"
          CLOUDWATCH_AUDIT_LOG_GROUP = aws_cloudwatch_log_group.audit_anchors.name
        }
        runtime_environment_secrets = {
          DATABASE_URL        = aws_secretsmanager_secret.database_url.arn
          AUDIT_ANCHOR_SECRET = aws_secretsmanager_secret.audit_anchor_secret.arn
        }
      }
    }
    auto_deployments_enabled = false
  }

  network_configuration {
    egress_configuration {
      egress_type       = "VPC"
      vpc_connector_arn = aws_apprunner_vpc_connector.rds_connector.arn
    }
  }

  instance_configuration {
    cpu               = "1024"
    memory            = "2048"
    instance_role_arn = aws_iam_role.apprunner_instance_role.arn
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/health"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 3
  }

  tags = {
    Name = "kanakku-${var.environment}-mcp-server"
  }
}

resource "aws_apprunner_service" "console" {
  count        = var.enable_apprunner_services ? 1 : 0
  service_name = "kanakku-${var.environment}-console"

  source_configuration {
    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_access_role.arn
    }
    image_repository {
      image_identifier      = "${aws_ecr_repository.console.repository_url}:${var.console_image_tag}"
      image_repository_type = "ECR"
      image_configuration {
        port = "3000"
        runtime_environment_variables = {
          NODE_ENV                = "production"
          PORT                    = "3000"
          NEXT_TELEMETRY_DISABLED = "1"
          AWS_REGION              = var.aws_region
          MCP_SERVER_URL          = length(aws_apprunner_service.mcp_server) > 0 ? "https://${aws_apprunner_service.mcp_server[0].service_url}" : ""
        }
        runtime_environment_secrets = {
          DATABASE_URL = aws_secretsmanager_secret.database_url.arn
        }
      }
    }
    auto_deployments_enabled = false
  }

  network_configuration {
    egress_configuration {
      egress_type       = "VPC"
      vpc_connector_arn = aws_apprunner_vpc_connector.rds_connector.arn
    }
  }

  instance_configuration {
    cpu               = "1024"
    memory            = "2048"
    instance_role_arn = aws_iam_role.apprunner_instance_role.arn
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/api/health"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 3
  }

  tags = {
    Name = "kanakku-${var.environment}-console"
  }

  depends_on = [aws_apprunner_service.mcp_server]
}
