ui            = true
disable_mlock = true
api_addr      = "http://vault:8200"

storage "file" {
  path = "/vault/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1 # internal docker network only; Traefik terminates TLS for the UI

  telemetry {
    unauthenticated_metrics_access = true # Prometheus scrapes over the internal network; no secrets are exposed
  }
}

telemetry {
  prometheus_retention_time = "30s"
  disable_hostname          = true
}
