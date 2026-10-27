{{- define "orq.image" -}}
{{ .root.Values.image.registry }}/orquestador-{{ .name }}:{{ default .root.Chart.AppVersion .root.Values.image.tag }}
{{- end -}}
{{- define "orq.env" -}}
- { name: APP_ENV, value: {{ .Values.global.appEnv | quote }} }
- { name: VAULT_TOKEN, valueFrom: { secretKeyRef: { name: {{ .Values.vault.tokenSecretName }}, key: {{ .Values.vault.tokenSecretKey }} } } }
{{- range $k, $v := .Values.config }}
- { name: {{ $k }}, value: {{ $v | quote }} }
{{- end }}
{{- end -}}
