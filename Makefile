.PHONY: help install test \
        circuits circuits-restore circuits-test fixtures vectors vectors-check ceremony ceremony-dry-run \
        solidity-build solidity-test solidity-gas \
        sdk sdk-test relayer relayer-test relayer-docker \
        ui-dev ui-sepolia ui-build ui-lint ui-test ui-config ui-docker \
        e2e e2e-browser dev dev-process dev-settle dev-results \
        sepolia-deploy sepolia-run gnosis-deploy deploy-test

# pnpm 10 without a global install.
PNPM ?= npx -y pnpm@10

# Foundry: the host install (~/.foundry/bin or PATH) when present, else the official image.
FORGE_BIN     ?= $(or $(wildcard $(HOME)/.foundry/bin/forge),$(shell command -v forge 2>/dev/null))
FOUNDRY_IMAGE ?= ghcr.io/foundry-rs/foundry:stable
ifeq ($(strip $(FORGE_BIN)),)
forge = docker run --rm --entrypoint forge -u $$(id -u):$$(id -g) -e HOME=/tmp -e FOUNDRY_PROFILE -e COUNCIL_GAS_GROUP \
	-v $(CURDIR):/work -w /work/solidity $(FOUNDRY_IMAGE) $(1)
else
forge = cd solidity && $(FORGE_BIN) $(1)
export E2E_FOUNDRY ?= host
endif

# The davinci-test CLI against a running `make dev` stack.
DAVINCI_CLI    := node tools/davinci-test/dist/cli.js
DEV_CLI_CONFIG := .dev/davinci-test.json

# Images (make relayer-docker / ui-docker).
IMAGE_TAG ?= dev

help: ## Show this help
	@echo "DAVINCI DKG Council"
	@echo ""
	@echo "Usage: make [target] [VAR=value ...]"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-18s %s\n", $$1, $$2}'

install: ## Install every workspace package (pnpm, frozen lockfile)
	$(PNPM) install --frozen-lockfile

test: solidity-test sdk-test relayer-test ui-test ## Fast suites: contracts, SDK, relayer, UI

# ---- Circuits -------------------------------------------------------------------------------

circuits: ## New DEV phase-2: compile, set up, verifiers, vectors, then re-pin SDK + contracts, fixtures
	$(PNPM) --filter ./circuits run build
	$(call forge,build)
	$(PNPM) --filter ./circuits run pin
	$(PNPM) --filter ./circuits run fixtures

# Production phase 2 (multi-party): circuits/scripts/ceremony/README.md. One step per call:
#   make ceremony ARGS="init --dir ~/ceremony-v2 --tag circuits-v2"
ceremony: ## Multi-party phase-2 ceremony tool: make ceremony ARGS="<command> …" (circuits/scripts/ceremony)
	circuits/node_modules/.bin/tsx circuits/scripts/ceremony/ceremony.ts $(ARGS)

ceremony-dry-run: ## Rehearse the ceremony (3 simulated contributors + drand beacon) in a temp dir [DIR=…]
	bash circuits/scripts/ceremony/dry-run.sh $(DIR)

circuits-restore: ## Restore circuits/build for the pinned release (compile + released zkeys, no setup)
	$(PNPM) --filter ./circuits run restore

circuits-test: ## Circuit witness, mutation and release tests (needs circuits/build)
	$(PNPM) --filter ./circuits run test

fixtures: ## Regenerate the canned proof fixtures from circuits/build
	$(PNPM) --filter ./circuits run fixtures

vectors: ## Regenerate tests/vectors/*.json
	$(PNPM) --filter ./circuits run vectors

vectors-check: ## Regenerate the vectors and fail if they changed
	$(PNPM) --filter ./circuits run vectors-check

# ---- Contracts ------------------------------------------------------------------------------

solidity-build: ## forge build, with runtime sizes
	$(call forge,build --sizes)

solidity-test: ## forge test
	$(call forge,test)

solidity-gas: export FOUNDRY_PROFILE := gas
solidity-gas: ## Per-action gas snapshots under Osaka and Amsterdam (FOUNDRY_PROFILE=gas)
	$(call forge,snapshot --match-contract Gas)
	export COUNCIL_GAS_GROUP=council-amsterdam; \
		$(call forge,snapshot --match-contract Gas --evm-version amsterdam --snap .gas-snapshot-amsterdam)

# ---- SDK and relayer ------------------------------------------------------------------------

sdk: ## Build the SDK
	$(PNPM) --filter ./sdk run build

sdk-test: ## Type-check and test the SDK
	$(PNPM) --filter ./sdk run check
	$(PNPM) --filter ./sdk run test

relayer: ## Build the relayer (and the SDK it needs)
	$(PNPM) --filter ./relayer run build

relayer-test: ## Type-check and test the relayer
	$(PNPM) --filter ./relayer run check
	$(PNPM) --filter ./relayer run test

relayer-docker: ## Build the relayer image (IMAGE_TAG)
	docker build -f relayer/Dockerfile -t ghcr.io/vocdoni/davinci-dkg-council-relayer:$(IMAGE_TAG) .

# ---- Web app --------------------------------------------------------------------------------

ui-dev: ## Serve the app against ui/public/config.json (the local stack by default)
	$(PNPM) --filter ./ui run dev

# Serve the app against the Sepolia placeholders in ui/public/config.sepolia.json:
#   make ui-sepolia RELAYER_URL=https://… [ARTIFACTS_URL=https://…]
ui-sepolia: ## Serve the app against config.sepolia.json (RELAYER_URL, ARTIFACTS_URL)
	VITE_CONFIG=/config.sepolia.json VITE_RELAYER_URL=$(RELAYER_URL) VITE_ARTIFACTS_URL=$(ARTIFACTS_URL) \
		$(PNPM) --filter ./ui run dev

ui-build: ## Production build of the app into ui/dist
	$(PNPM) --filter ./ui run build

ui-lint: ## Type-check and lint the app
	$(PNPM) --filter ./ui run lint

ui-test: ## App unit tests (vitest, jsdom)
	$(PNPM) --filter ./ui run test

ui-config: ## Re-render ui/public/config.json from CHAIN_ID, MANAGER_ADDRESS, RPC_URLS, …
	bash scripts/render-ui-config.sh

ui-docker: ## Build the app image (IMAGE_TAG; config build args in ui/Dockerfile)
	docker build -f ui/Dockerfile -t ghcr.io/vocdoni/davinci-dkg-council-ui:$(IMAGE_TAG) .

# ---- End to end -----------------------------------------------------------------------------

e2e: ## Headless suite on Anvil (Osaka): lifecycles, relayer, DAVINCI round trip
	$(PNPM) --filter ./tests run test

e2e-browser: ## Playwright journeys against `make dev` (started here when not running)
	$(PNPM) --filter ./ui exec playwright test

# Local stack: Anvil + verifiers + manager + DAVINCI registry + relayer + circuit files + app.
dev: ## The whole stack on this machine; Ctrl-C stops it
	bash scripts/dev-stack.sh

# Against a running `make dev`: a DAVINCI process on a committee key, its settled tally, its results.
dev-process: ## make dev-process CEREMONY=0x<bytes12> [FIELDS=4]
	@test -n "$(CEREMONY)" || { echo "usage: make dev-process CEREMONY=0x<bytes12> [FIELDS=4]"; exit 2; }
	$(DAVINCI_CLI) create --config $(DEV_CLI_CONFIG) --ceremony $(CEREMONY) --fields $(or $(FIELDS),4)

dev-settle: ## make dev-settle PROCESS=0x<bytes31> TALLY=7,0,3
	@test -n "$(PROCESS)" -a -n "$(TALLY)" || { echo "usage: make dev-settle PROCESS=0x<bytes31> TALLY=7,0,3"; exit 2; }
	bash scripts/dev-stack.sh settle --process $(PROCESS) --tally $(TALLY)

dev-results: ## make dev-results PROCESS=0x<bytes31>
	@test -n "$(PROCESS)" || { echo "usage: make dev-results PROCESS=0x<bytes31>"; exit 2; }
	$(DAVINCI_CLI) results --config $(DEV_CLI_CONFIG) --process $(PROCESS) --finalize

# ---- Testnet --------------------------------------------------------------------------------

sepolia-deploy: ## Deploy verifiers + manager + test adapter (COUNCIL_KEY_FILE)
	bash scripts/sepolia/deploy.sh

sepolia-run: ## One n=3, t=2 ceremony against scripts/sepolia/deployment.json (COUNCIL_KEY_FILE)
	bash scripts/sepolia/run.sh

gnosis-deploy: ## Deploy verifiers + manager to Gnosis (COUNCIL_KEY_FILE; a DEV release needs ALLOW_DEV_SETUP=true)
	bash scripts/gnosis/deploy.sh

deploy-test: ## The deploy scripts' release policy on throwaway Anvil chains (100, 11155111)
	bash scripts/deploy.test.sh
