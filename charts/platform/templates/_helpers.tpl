{{- define "platform.labels" -}}
app.kubernetes.io/part-of: orders-platform
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
