# Read-only access to this environment's secrets and connector credentials.
path "secret/data/orquestador/*"     { capabilities = ["read"] }
path "secret/metadata/orquestador/*" { capabilities = ["list", "read"] }
