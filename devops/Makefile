# Orquestador local deployment. `make help` lists everything.
SHELL := /bin/bash
DC_DIR := compose
ENVFILE := .env
CORE := -f $(DC_DIR)/docker-compose.yml
OBS := -f $(DC_DIR)/docker-compose.observability.yml
TOOLS := -f $(DC_DIR)/docker-compose.tools.yml
MOCKS := $(if $(wildcard $(DC_DIR)/docker-compose.mocks.yml),-f $(DC_DIR)/docker-compose.mocks.yml,)
BACKUP := -f $(DC_DIR)/docker-compose.backup.yml
ALL := $(CORE) $(OBS) $(TOOLS) $(MOCKS) $(BACKUP)
# Image builds share one pnpm cache mount; building in parallel can deadlock on its lock.
export COMPOSE_PARALLEL_LIMIT ?= 1
COMPOSE = docker compose --env-file $(ENVFILE)
DOMAIN ?= $(shell grep -s '^DOMAIN=' $(ENVFILE) | cut -d= -f2)
HTTPS_PORT ?= $(shell grep -s '^HTTPS_PORT=' $(ENVFILE) | cut -d= -f2)

.DEFAULT_GOAL := help
.PHONY: help init certs up up-all down nuke ps logs build config urls smoke migrate seed-demo verify-audit backup restore-drill test-load

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

init: ## Generate .env secrets and local TLS certificates
	@./scripts/init-env.sh
	@DOMAIN=$(or $(DOMAIN),orquestador.localhost) ./scripts/gen-certs.sh

certs: ## (Re)generate local TLS certificates
	@./scripts/gen-certs.sh

build: ## Build all images
	$(COMPOSE) $(ALL) build

up: init ## Start the core stack (app, identity, vault, workflow engine, storage)
	$(COMPOSE) $(CORE) up -d --build --remove-orphans
	@$(MAKE) --no-print-directory urls

up-all: init ## Start core + observability + tools (Metabase) + mock systems + backups
	$(COMPOSE) $(ALL) up -d --build --remove-orphans
	@$(MAKE) --no-print-directory urls

bi-bootstrap: ## Connect Metabase to the BI views, create the dashboards and enable signed embedding
	@python3 scripts/metabase-bootstrap.py

restart: ## Restart services (SERVICE="api worker"); to apply .env changes use `make up-all` instead
	$(COMPOSE) $(ALL) restart $(SERVICE)

down: ## Stop everything (data is kept)
	$(COMPOSE) $(ALL) down

nuke: ## Stop everything and DELETE all data volumes
	$(COMPOSE) $(ALL) down -v

ps: ## Container status
	$(COMPOSE) $(ALL) ps

logs: ## Tail logs (SERVICE=api to filter)
	$(COMPOSE) $(ALL) logs -f --tail=100 $(SERVICE)

config: ## Validate and print the merged compose model
	$(COMPOSE) $(ALL) config -q && echo "compose OK"

urls: ## Print service URLs
	@echo; echo "  App          https://$(DOMAIN):$(HTTPS_PORT)"; \
	echo "  API docs     https://$(DOMAIN):$(HTTPS_PORT)/api/docs"; \
	echo "  Keycloak     https://auth.$(DOMAIN):$(HTTPS_PORT)"; \
	echo "  Temporal UI  https://temporal.$(DOMAIN):$(HTTPS_PORT)"; \
	echo "  Mailpit      https://mail.$(DOMAIN):$(HTTPS_PORT)"; \
	echo "  MinIO        https://minio.$(DOMAIN):$(HTTPS_PORT)"; \
	echo "  Vault        https://vault.$(DOMAIN):$(HTTPS_PORT)"; \
	echo "  Grafana      https://grafana.$(DOMAIN):$(HTTPS_PORT)   (observability profile)"; \
	echo "  Metabase     https://bi.$(DOMAIN):$(HTTPS_PORT)        (tools profile)"; \
	echo "  Mock systems https://mocks.$(DOMAIN):$(HTTPS_PORT)     (mocks profile)"; echo

smoke: ## End-to-end smoke test against the running stack
	@./scripts/smoke.sh

migrate: ## Re-run database migrations + base seed
	$(COMPOSE) $(CORE) run --rm migrate

seed-demo: ## Load demo delegations, customers and technicians
	$(COMPOSE) $(CORE) run --rm -e NODE_ENV=development --entrypoint "" -w /repo/packages/db migrate node_modules/.bin/tsx src/cli.ts seed-demo

verify-audit: ## Verify the audit-log hash chain
	$(COMPOSE) $(CORE) run --rm --entrypoint "" -w /repo/packages/db migrate node_modules/.bin/tsx src/cli.ts verify-audit

backup: ## Take a base backup now (WAL-G) and mirror it to the second site
	$(COMPOSE) $(CORE) $(BACKUP) exec walg-backup /scripts/backup-now.sh

restore-drill: ## Restore the latest backup into a scratch database and verify it
	./scripts/restore-drill.sh

test-load: ## k6 load test (200 users by default; USERS=500 for the peak profile)
	./scripts/load-test.sh
