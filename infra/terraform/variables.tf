variable "aws_region" {
  description = "AWS region for deployment (Default: ap-south-1 Mumbai for Indian business data residency)"
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Deployment environment name"
  type        = string
  default     = "production"
}

variable "vpc_cidr" {
  description = "CIDR block for the dedicated Kanakku VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "db_instance_class" {
  description = "Amazon RDS instance class for PostgreSQL 16"
  type        = string
  default     = "db.t4g.medium"
}

variable "db_allocated_storage" {
  description = "Allocated storage in GB for RDS"
  type        = number
  default     = 50
}

variable "mcp_image_tag" {
  description = "Docker image tag for Kanakku MCP Server"
  type        = string
  default     = "latest"
}

variable "console_image_tag" {
  description = "Docker image tag for Kanakku Web Console"
  type        = string
  default     = "latest"
}

variable "enable_apprunner_services" {
  description = "Whether to create App Runner service instances. Set to false for the initial bootstrap apply before container images are pushed to ECR."
  type        = bool
  default     = false
}
