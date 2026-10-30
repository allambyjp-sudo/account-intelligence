-- Runs once, when the Docker volume is first created. Integration tests use their own database.
CREATE DATABASE aip_test OWNER aip;
\connect aip_test
CREATE EXTENSION IF NOT EXISTS vector;
\connect aip
CREATE EXTENSION IF NOT EXISTS vector;
