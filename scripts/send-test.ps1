# Fire a test notification. Usage:
#   .\scripts\send-test.ps1 -ApiKey nk_dev_xxxxx
#   .\scripts\send-test.ps1 -ApiKey nk_dev_xxxxx -Workflow order-shipped -Subscriber customer-42
param(
  [Parameter(Mandatory = $true)] [string]$ApiKey,
  [string]$Workflow = "order-shipped",
  [string]$Subscriber = "customer-42",
  [string]$Email = "customer42@example.com",
  [string]$ApiUrl = "http://localhost:3000"
)

$payload = @{
  workflowKey   = $Workflow
  priority      = "p1"
  to            = @(@{ subscriberId = $Subscriber; email = $Email })
  payload       = @{ name = "Ravi"; orderId = "ORD-7731"; carrier = "BlueDart"; eta = "Tuesday" }
} | ConvertTo-Json -Depth 5

$result = Invoke-RestMethod "$ApiUrl/v1/events/trigger" -Method POST -Body $payload `
  -ContentType 'application/json' -Headers @{ 'x-api-key' = $ApiKey }

Write-Host "accepted!  transactionId: $($result.transactionId)"
Write-Host "watch it:  dashboard Activity page + http://localhost:8025 (Mailpit)"
