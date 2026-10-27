#!/usr/bin/env python3
"""Sets up Metabase for the Orquestador BI dashboards (ORF-053). Idempotent: existing dashboards are reused.

 - first run: creates the admin account and connects the read-only `bi_reader` role to the app database
 - creates three dashboards from native SQL over the flat `bi.*` views
 - enables signed embedding with the delegation filter *locked* (the API fills it in per user, so a delegation
   manager can never see another delegation's figures)
 - writes METABASE_SITE_URL and METABASE_DASHBOARDS to devops/.env (restart api + worker afterwards)
"""
import json, os, re, socket, ssl, sys, time, urllib.request, urllib.error
from pathlib import Path

# Python's resolver does not know that *.localhost is loopback (curl and browsers do).
_getaddrinfo = socket.getaddrinfo
socket.getaddrinfo = lambda host, *a, **k: _getaddrinfo("127.0.0.1" if str(host).endswith(".localhost") else host, *a, **k)

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
env = {}
for line in ENV_FILE.read_text().splitlines():
    m = re.match(r"^([A-Z0-9_]+)=(.*)$", line)
    if m:
        env[m.group(1)] = m.group(2).strip().strip('"')
env.update({k: v for k, v in os.environ.items() if k in ("MB_URL", "MB_ADMIN_EMAIL", "MB_ADMIN_PASSWORD")})

SITE = f"https://bi.{env['DOMAIN']}:{env['HTTPS_PORT']}"
URL = env.get("MB_URL", SITE).rstrip("/")
ADMIN_EMAIL = env.get("MB_ADMIN_EMAIL", env.get("BOOTSTRAP_ADMIN_EMAIL", "admin@orquestador.local"))
ADMIN_PASSWORD = env.get("MB_ADMIN_PASSWORD") or ("Aa1!" + env["METABASE_EMBEDDING_SECRET"][:16])
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
token = None


def api(method, path, body=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Metabase-Session"] = token
    req = urllib.request.Request(URL + path, method=method, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} -> {e.code}: {e.read().decode()[:500]}")


def wait_ready():
    for _ in range(90):
        try:
            if api("GET", "/api/health").get("status") == "ok":
                return
        except SystemExit:
            pass
        except Exception:
            pass
        time.sleep(4)
    sys.exit("Metabase did not become healthy")


DB_DETAILS = {"host": "postgres", "port": 5432, "dbname": "orquestador", "user": "bi_reader", "password": env["BI_DB_PASSWORD"], "ssl": False}

wait_ready()
props = api("GET", "/api/session/properties")
if props.get("setup-token"):
    print("• first run: creating the admin account")
    session = api("POST", "/api/setup", {
        "token": props["setup-token"],
        "user": {"first_name": "Orquestador", "last_name": "BI", "email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        "prefs": {"site_name": "Orquestador BI", "site_locale": "es", "allow_tracking": False},
        "database": {"engine": "postgres", "name": "Orquestador", "details": DB_DETAILS, "is_full_sync": True},
    })
    token = session["id"]
else:
    token = api("POST", "/api/session", {"username": ADMIN_EMAIL, "password": ADMIN_PASSWORD})["id"]

api("PUT", "/api/setting/embedding-secret-key", {"value": env["METABASE_EMBEDDING_SECRET"]})
api("PUT", "/api/setting/enable-embedding-static", {"value": True})

dbs = api("GET", "/api/database")
dbs = dbs["data"] if isinstance(dbs, dict) else dbs
db = next((d for d in dbs if not d.get("is_sample") and d["engine"] == "postgres"), None)
if db is None:
    db = api("POST", "/api/database", {"engine": "postgres", "name": "Orquestador", "details": DB_DETAILS, "is_full_sync": True})
print(f"• database #{db['id']} ({db['name']})")
api("POST", f"/api/database/{db['id']}/sync_schema")


def field_ids():
    for _ in range(30):
        meta = api("GET", f"/api/database/{db['id']}/metadata?include_hidden=true")
        out = {t["name"]: {f["name"]: f["id"] for f in t["fields"]} for t in meta["tables"] if t.get("schema") == "bi"}
        if "work_orders" in out and "delegation" in out["work_orders"]:
            return out
        time.sleep(3)
    sys.exit("Metabase has not synced the bi schema yet; run this script again in a minute")


FIELDS = field_ids()

# (dashboard name) -> [(title, bi view, display, sql with {where} where the delegation filter goes)]
DASHBOARDS = {
    "Operaciones": [
        ("OT por estado", "work_orders", "bar", "SELECT status, count(*) AS ot FROM bi.work_orders WHERE {where} GROUP BY status ORDER BY ot DESC"),
        ("OT vencidas", "work_orders", "scalar", "SELECT count(*) AS vencidas FROM bi.work_orders WHERE overdue AND {where}"),
        ("OT por tipo de inspección", "work_orders", "pie", "SELECT coalesce(inspection_type, 'sin tipo') AS tipo, count(*) AS ot FROM bi.work_orders WHERE {where} GROUP BY 1 ORDER BY ot DESC"),
        ("OT creadas por semana", "work_orders", "line", "SELECT date_trunc('week', created_at)::date AS semana, count(*) AS ot FROM bi.work_orders WHERE {where} GROUP BY 1 ORDER BY 1"),
        ("Tareas con SLA vencido por cola", "tasks", "bar", "SELECT coalesce(queue, 'sin cola') AS cola, count(*) AS tareas FROM bi.tasks WHERE sla_breached AND {where} GROUP BY 1 ORDER BY tareas DESC"),
    ],
    "Visitas": [
        ("Visitas por estado", "visits", "bar", "SELECT status, count(*) AS visitas FROM bi.visits WHERE {where} GROUP BY status ORDER BY visitas DESC"),
        ("Duración real media por tipo (min)", "visits", "bar", "SELECT coalesce(visit_type, 'sin tipo') AS tipo, round(avg(actual_duration_min)::numeric, 1) AS minutos FROM bi.visits WHERE actual_duration_min IS NOT NULL AND {where} GROUP BY 1 ORDER BY minutos DESC"),
        ("Segundas visitas", "visits", "scalar", "SELECT count(*) AS segundas_visitas FROM bi.visits WHERE second_visit AND {where}"),
        ("Visitas fuera de plazo legal", "visits", "scalar", "SELECT count(*) AS fuera_de_plazo FROM bi.visits WHERE overdue AND {where}"),
    ],
    "Calidad y facturación": [
        ("No conformidades por estado", "nonconformities", "pie", "SELECT status, count(*) AS nc FROM bi.nonconformities WHERE {where} GROUP BY status"),
        ("NC con plazo de subsanación vencido", "nonconformities", "scalar", "SELECT count(*) AS vencidas FROM bi.nonconformities WHERE overdue AND {where}"),
        ("Certificados emitidos por mes", "certificates", "line", "SELECT date_trunc('month', issued_at)::date AS mes, count(*) AS certificados FROM bi.certificates WHERE issued_at IS NOT NULL AND {where} GROUP BY 1 ORDER BY 1"),
        ("Facturación por mes (€)", "billing_lines", "bar", "SELECT date_trunc('month', created_at)::date AS mes, sum(amount) AS importe FROM bi.billing_lines WHERE {where} GROUP BY 1 ORDER BY 1"),
    ],
}


def ensure_card(title, view, display, sql):
    existing = next((c for c in api("GET", "/api/card") if c["name"] == title and not c.get("archived")), None)
    query = {
        "database": db["id"],
        "type": "native",
        "native": {
            "query": sql.replace("{where}", "{{delegacion}}"),
            "template-tags": {"delegacion": {
                "id": f"delegacion-{view}", "name": "delegacion", "display-name": "Delegación", "type": "dimension",
                "dimension": ["field", FIELDS[view]["delegation"], None], "widget-type": "string/=",
            }},
        },
    }
    payload = {"name": title, "display": display, "dataset_query": query, "visualization_settings": {}}
    if existing:
        return api("PUT", f"/api/card/{existing['id']}", payload)["id"]
    return api("POST", "/api/card", payload)["id"]


listing = []
for name, cards in DASHBOARDS.items():
    ids = [(ensure_card(*c), c) for c in cards]
    dash = next((d for d in api("GET", "/api/dashboard") if d["name"] == name and not d.get("archived")), None) or api("POST", "/api/dashboard", {"name": name})
    parameter = {"id": "delegacion", "name": "Delegación", "slug": "delegacion", "type": "string/="}
    dashcards = [
        {
            "id": -(n + 1), "card_id": card_id, "row": (n // 2) * 5, "col": (n % 2) * 12, "size_x": 12, "size_y": 5,
            "parameter_mappings": [{"parameter_id": "delegacion", "card_id": card_id, "target": ["dimension", ["template-tag", "delegacion"]]}],
        }
        for n, (card_id, _) in enumerate(ids)
    ]
    api("PUT", f"/api/dashboard/{dash['id']}", {"parameters": [parameter], "dashcards": dashcards, "enable_embedding": True, "embedding_params": {"delegacion": "locked"}})
    print(f"• dashboard #{dash['id']} {name} ({len(ids)} cards)")
    listing.append(f"{dash['id']}:{name}")


def set_env(key, value):
    text = ENV_FILE.read_text()
    text = re.sub(rf"^#?\s*{key}=.*\n?", "", text, flags=re.M)
    ENV_FILE.write_text(text.rstrip("\n") + f"\n{key}={value}\n")


set_env("METABASE_SITE_URL", SITE)
set_env("METABASE_DASHBOARDS", '"' + ",".join(listing) + '"')
print(f"\nMetabase admin: {ADMIN_EMAIL} / {ADMIN_PASSWORD}\nUpdated devops/.env. Recreate the services so they pick it up:  make up-all")
