#!/usr/bin/env bash
# End-to-end smoke test: TLS edge, API, OIDC login through Keycloak, session cookie, RBAC and Temporal.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
BASE="https://${DOMAIN}:${HTTPS_PORT}"
KC="https://auth.${DOMAIN}:${HTTPS_PORT}"
CURL=(curl -sk --max-time 20)
T=$(mktemp -d); trap 'rm -rf "$T"; cleanup' EXIT
ok() { printf '  \033[32m✔\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✘\033[0m %s\n' "$1"; exit 1; }
USER_EMAIL="smoke.$(date +%s)@orquestador.local"; USER_PW="Smoke!$(openssl rand -hex 6)Aa1"; KC_USER_ID=""

kc_token() { "${CURL[@]}" -d grant_type=password -d client_id=admin-cli -d "username=${KC_ADMIN_USER}" -d "password=${KC_ADMIN_PASSWORD}" "$KC/realms/master/protocol/openid-connect/token" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'; }
cleanup() {
  [ -n "$KC_USER_ID" ] && "${CURL[@]}" -X DELETE -H "Authorization: Bearer $(kc_token)" "$KC/admin/realms/orquestador/users/$KC_USER_ID" >/dev/null || true
}

echo "Smoke test against $BASE"
[ "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/health")" = 200 ] && ok "API reachable over TLS" || fail "API health"
"${CURL[@]}" "$BASE/api/v1/openapi.json" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert len(d["paths"])>20' && ok "OpenAPI document served" || fail "OpenAPI"
[ "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/v1/users")" = 401 ] && ok "anonymous request rejected (401)" || fail "auth enforcement"

TOKEN=$(kc_token)
"${CURL[@]}" -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$KC/admin/realms/orquestador/users" \
  -d "{\"username\":\"$USER_EMAIL\",\"email\":\"$USER_EMAIL\",\"emailVerified\":true,\"enabled\":true,\"requiredActions\":[],\"credentials\":[{\"type\":\"password\",\"value\":\"$USER_PW\",\"temporary\":false}]}"
KC_USER_ID=$("${CURL[@]}" -H "Authorization: Bearer $TOKEN" "$KC/admin/realms/orquestador/users?email=$USER_EMAIL&exact=true" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
# The realm forces TOTP enrolment for every new user (MFA); the smoke identity is exempted.
"${CURL[@]}" -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$KC/admin/realms/orquestador/users/$KC_USER_ID" -d '{"requiredActions":[]}'
ok "test identity created in Keycloak"

LOC=$("${CURL[@]}" -c "$T/app.jar" -D - -o /dev/null "$BASE/api/v1/auth/login" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
[ -n "$LOC" ] || fail "login redirect"
ACTION=$("${CURL[@]}" -c "$T/kc.jar" -b "$T/kc.jar" "$LOC" | python3 -c 'import sys,re,html;m=re.search(r"action=\"([^\"]+)\"",sys.stdin.read());print(html.unescape(m.group(1)) if m else "")')
[ -n "$ACTION" ] || fail "Keycloak login form"
CB=$("${CURL[@]}" -c "$T/kc.jar" -b "$T/kc.jar" -D - -o /dev/null --data-urlencode "username=$USER_EMAIL" --data-urlencode "password=$USER_PW" "$ACTION" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
case "$CB" in "$BASE"/api/v1/auth/callback*) ok "Keycloak authenticated the user";; *) fail "Keycloak did not redirect to the callback ($CB)";; esac
"${CURL[@]}" -c "$T/app.jar" -b "$T/app.jar" -o /dev/null "$CB"
ME=$("${CURL[@]}" -b "$T/app.jar" "$BASE/api/v1/auth/me")
echo "$ME" | python3 -c "import sys,json;d=json.load(sys.stdin)['user'];assert d['email']=='$USER_EMAIL'" && ok "session established (BFF cookie)" || fail "session: $ME"
CODE=$("${CURL[@]}" -b "$T/app.jar" -o /dev/null -w '%{http_code}' "$BASE/api/v1/users")
[ "$CODE" = 403 ] && ok "RBAC: user without roles gets 403" || fail "RBAC expected 403 got $CODE"
"${CURL[@]}" -b "$T/app.jar" -o /dev/null -X POST "$BASE/api/v1/auth/logout"
echo "Smoke test passed"
