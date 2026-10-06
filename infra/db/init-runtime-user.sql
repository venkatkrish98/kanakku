-- =============================================================================
-- Kanakku RDS PostgreSQL Least-Privilege Application User Provisioning
-- =============================================================================
-- Run by administrator (kanakku_admin) during initial deployment / migration.
-- Grants runtime containers (kanakku_app) strictly required DML permissions.
-- Prevents runtime application compromise from executing DDL or dropping tables.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'kanakku_app') THEN
    -- In production, password is supplied dynamically via Terraform db_app_password
    CREATE USER kanakku_app WITH PASSWORD '${APP_USER_PASSWORD}';
  END IF;
END
$$;

-- 1. Database Connection & Schema Access
GRANT CONNECT ON DATABASE kanakkudb TO kanakku_app;
GRANT USAGE ON SCHEMA public TO kanakku_app;

-- 2. Data Manipulation Permissions (DML Only: SELECT, INSERT, UPDATE, DELETE)
-- No DDL permissions (no CREATE TABLE, DROP TABLE, ALTER TABLE)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kanakku_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kanakku_app;

-- 3. Default Privileges for New Tables Created by Migrations
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kanakku_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO kanakku_app;
