output "vpc_id" {
  description = "The ID of the Kanakku VPC"
  value       = aws_vpc.kanakku_vpc.id
}

output "rds_endpoint" {
  description = "PostgreSQL 16 RDS endpoint"
  value       = aws_db_instance.postgres16.endpoint
}

output "vpc_connector_arn" {
  description = "ARN of the App Runner VPC connector"
  value       = aws_apprunner_vpc_connector.rds_connector.arn
}

output "secrets_manager_db_url_secret_arn" {
  description = "ARN of the Secrets Manager database URL secret (plain connection string)"
  value       = aws_secretsmanager_secret.database_url.arn
}

output "secrets_manager_db_admin_credentials_secret_arn" {
  description = "ARN of the Secrets Manager administrative database credentials JSON secret (kanakku_admin)"
  value       = aws_secretsmanager_secret.database_admin_credentials.arn
}

output "secrets_manager_audit_anchor_secret_arn" {
  description = "ARN of the Secrets Manager audit anchor HMAC secret"
  value       = aws_secretsmanager_secret.audit_anchor_secret.arn
}

output "apprunner_instance_role_arn" {
  description = "IAM Role ARN for App Runner services"
  value       = aws_iam_role.apprunner_instance_role.arn
}

output "cloudwatch_audit_log_group" {
  description = "CloudWatch log group for audit anchoring"
  value       = aws_cloudwatch_log_group.audit_anchors.name
}

output "ecr_mcp_server_repository_url" {
  description = "ECR Repository URL for Kanakku MCP Server"
  value       = aws_ecr_repository.mcp_server.repository_url
}

output "ecr_console_repository_url" {
  description = "ECR Repository URL for Kanakku Web Console"
  value       = aws_ecr_repository.console.repository_url
}

output "apprunner_mcp_server_url" {
  description = "Public HTTPS URL for Kanakku MCP Server"
  value       = length(aws_apprunner_service.mcp_server) > 0 ? "https://${aws_apprunner_service.mcp_server[0].service_url}" : "pending-deployment"
}

output "apprunner_console_url" {
  description = "Public HTTPS URL for Kanakku Web Console"
  value       = length(aws_apprunner_service.console) > 0 ? "https://${aws_apprunner_service.console[0].service_url}" : "pending-deployment"
}
