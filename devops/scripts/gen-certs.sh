#!/usr/bin/env bash
# Local TLS: mkcert when available (trusted automatically), otherwise a private CA built with openssl.
set -euo pipefail
cd "$(dirname "$0")/../certs"
DOMAIN="${DOMAIN:-orquestador.localhost}"
if [ -f local.crt ] && [ -f local.key ]; then echo "certs already present (delete devops/certs to regenerate)"; exit 0; fi

if command -v mkcert >/dev/null 2>&1; then
  mkcert -install >/dev/null
  mkcert -cert-file local.crt -key-file local.key "$DOMAIN" "*.$DOMAIN" localhost 127.0.0.1 ::1
  cp "$(mkcert -CAROOT)/rootCA.pem" ca.crt
  echo "issued with mkcert (already trusted by your system and browsers)"
  exit 0
fi

openssl genrsa -out ca.key 4096 2>/dev/null
openssl req -x509 -new -nodes -key ca.key -sha256 -days 825 -subj "/O=Orquestador local/CN=Orquestador local CA" -out ca.crt
openssl genrsa -out local.key 2048 2>/dev/null
cat > ext.cnf <<CNF
subjectAltName = DNS:$DOMAIN, DNS:*.$DOMAIN, DNS:localhost, IP:127.0.0.1
extendedKeyUsage = serverAuth
keyUsage = digitalSignature, keyEncipherment
CNF
openssl req -new -key local.key -subj "/O=Orquestador local/CN=$DOMAIN" -out local.csr
openssl x509 -req -in local.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out local.crt -days 397 -sha256 -extfile ext.cnf 2>/dev/null
rm -f local.csr ext.cnf ca.srl
chmod 600 local.key ca.key
cat <<MSG
Generated a local CA at devops/certs/ca.crt. To avoid browser warnings, trust it once:
  macOS:  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain devops/certs/ca.crt
  Linux:  sudo cp devops/certs/ca.crt /usr/local/share/ca-certificates/orquestador.crt && sudo update-ca-certificates
(or install mkcert and delete devops/certs to regenerate)
MSG
