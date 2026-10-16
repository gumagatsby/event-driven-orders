{{- define "service.labels" -}}
app.kubernetes.io/name: {{ .Release.Name }}
app.kubernetes.io/part-of: orders-platform
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
{{- define "service.selector" -}}
app.kubernetes.io/name: {{ .Release.Name }}
{{- end }}
