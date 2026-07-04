{{- define "ns.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ns.labels" -}}
app.kubernetes.io/name: {{ include "ns.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ns.envFrom" -}}
envFrom:
  - configMapRef:
      name: {{ include "ns.name" . }}-config
  - secretRef:
      name: {{ include "ns.name" . }}-secrets
{{- end -}}
