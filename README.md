# 4C Cloud Native Security — KCD Vietnam 2026 Demo

> 🌐 **English** · [Tiếng Việt](./README.md)

> Demo project for the **"4C Cloud Native Security"** talk at **Kubernetes Community Days (KCD) Vietnam 2026**.
>
> It deploys an **intentionally vulnerable** e-commerce app on Kubernetes to walk through a **full attack chain** (RCE → steal the ServiceAccount token → call the kube-apiserver → read a Secret → pivot to MySQL and exfiltrate data) and the matching **defense layers** following the 4C model (Cloud, Cluster, Container, Code).

> ⚠️ **WARNING**: All code and docs here are for **educational** use and testing in **your own isolated lab** only. **Do not** target any real system or system you are not authorized to test. All data in the demo is **100% fake**.

---

## Table of contents

- [Overview](#overview)
- [ShopApp web application](#shopapp-web-application)
- [Directory layout](#directory-layout)
- [Architecture & intentional flaws](#architecture--intentional-flaws)
- [Attack chain (Kill Chain)](#attack-chain-kill-chain)
- [Lab deployment](#lab-deployment)
- [Running the attack demo](#running-the-attack-demo)
- [Defense layers](#defense-layers)
- [CI/CD — image scanning with Trivy](#cicd--image-scanning-with-trivy)
- [Flaw ↔ mitigation table](#flaw--mitigation-table)

---

## Overview

| Item | Value |
|------|-------|
| **Vulnerability** | CVE-2026-26832 — OS Command Injection |
| **Affected component** | `node-tesseract-ocr` <= 2.2.1 |
| **Endpoint** | `POST /api/products/scan-label` |
| **Target (lab)** | `https://ecommerce.vdevopssphere.ddnsfree.com` |
| **Impact** | RCE → steal SA token → call kube-apiserver → read Secret → pivot to MySQL and exfiltrate data |

The `shop-app` application is a tech store with a **complete web UI**, plus a "seller uploads a product-label image → OCR auto-reads the text to fill the form" feature. That feature calls `node-tesseract-ocr`, a library that **does not sanitize** `imagePath` before concatenating it into a shell command passed to `child_process.exec()` — opening the door to OS Command Injection.

---

## ShopApp web application

The frontend is a plain SPA (HTML/CSS/JS, **no build tooling**) served statically by Express, which makes the demo more tangible: the audience sees an ordinary seller feature, then that very same `imagePath` field gets exploited.

**The UI includes:**

- **Home page**: sticky header, animated hero, product grid, and a seller CTA section.
- **Product catalog**: 8 fake products, category filtering, and an "Add to cart" button.
- **"Scan label (OCR)" modal**: enter an `imagePath` → call the OCR endpoint → show the result/error. **This is the attack surface** for CVE-2026-26832.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Web UI (served from `app/public/`) |
| `GET` | `/healthz` | Health check |
| `GET` | `/api/products` | Fake product catalog (JSON) |
| `POST` | `/api/products/scan-label` | **OCR — the CVE-2026-26832 endpoint** |

**Run locally (no Kubernetes required):**

```bash
cd app
npm install
node server.js
# Open http://localhost:8080
```

> Note: OCR needs the `tesseract-ocr` binary installed in the Docker image. Running `node server.js` directly on a machine without `tesseract` still serves the web page and catalog, but the "Scan" button will return an error — use Docker to test the OCR feature end to end.

---

## Directory layout

```
KCD2026/
├── app/                              # shop-app application (intentionally vulnerable)
│   ├── server.js                     # Express: serves UI + /api/products + OCR (CVE-2026-26832)
│   ├── public/                       # Web UI (static SPA)
│   │   ├── index.html                #   Home page + OCR scan-label modal
│   │   ├── styles.css                #   Styling (gradients, responsive)
│   │   └── app.js                    #   Fetch products, filter, call OCR endpoint
│   ├── package.json                  # Pins node-tesseract-ocr 2.2.1 (vuln)
│   └── Dockerfile                    # "Full" base image, runs as root, ships mysql-client
├── .github/workflows/
│   └── build-scan.yml                # CI: build image + Trivy scan + comment on PR
├── manifest/                         # Kubernetes manifests
│   ├── 01-ecommerce-insecure.yaml    # ecommerce namespace + over-broad RBAC + shop-app Deployment
│   ├── 02-database-insecure.yaml     # database namespace + base64 Secret + MySQL + seed data
│   ├── 03-case1-hardening.yaml       # Pod hardening: disable automount SA, readOnlyRootFilesystem...
│   ├── 04-networkpolicy.yaml         # NetworkPolicy blocking the east-west pivot to MySQL
│   └── falco.yaml                    # Helm values for Falco (runtime detection)
├── attack.sh                         # Exploit PoC — attack() function + each kill-chain step
├── attack-scenario.md                # Detailed attack & defense scenario doc (Vietnamese)
├── attack-scenario.en.md             # Detailed attack & defense scenario doc (English)
└── 4C-CloudNative-Security-KCD-Vietnam-2026.pptx   # Slide deck
```

---

## Architecture & intentional flaws

The lab has 2 namespaces:

- **`ecommerce`** — hosts `shop-app` (frontend/API) and the `shop-app-sa` ServiceAccount.
- **`database`** — hosts MySQL 8.0, the credentials Secret, and a ConfigMap seeding the `users` data.

Common misconfigurations are planted intentionally to illustrate each 4C layer:

| Layer (4C) | Intentional flaw | Location |
|------------|------------------|----------|
| **Code** | `node-tesseract-ocr` 2.2.1 with a CVE; no SCA/`npm audit` in the build | `app/server.js`, `app/package.json`, `app/Dockerfile` |
| **Container** | Non-distroless base image, runs as **root**, ships `default-mysql-client` (a pivot tool) | `app/Dockerfile` |
| **Cluster** | Over-broad RBAC: the frontend SA can `get/list/watch` `pods/secrets/services` **cluster-wide** | `manifest/01-ecommerce-insecure.yaml` |
| **Cluster** | Secret only **base64** (not encrypted); no NetworkPolicy blocking east-west traffic | `manifest/02-database-insecure.yaml` |

> Note: in `01-ecommerce-insecure.yaml`, `automountServiceAccountToken` is set to `false` — depending on the demo variant you can toggle it to compare before/after hardening.

---

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

Payload injected into the `imagePath` field:

```
" >/dev/null 2>&1; <YOUR_COMMAND> #
```

| Component | Meaning |
|-----------|---------|
| `"` | Closes the double quote tesseract wraps around `imagePath` (breaks out of the argument) |
| `>/dev/null 2>&1` | Discards the empty tesseract command's output/errors to keep things clean |
| `; <command>` | Runs the attacker's arbitrary command |
| `#` | Comments out the trailing `" stdout -l eng ..."` remainder |

See the full walkthrough in [`attack-scenario.en.md`](./attack-scenario.en.md).

---

## Lab deployment

**Requirements**: a lab Kubernetes cluster (kind/minikube/k3s...), `kubectl`, and (for the attack demo) `bash`, `curl`, `jq` on your machine.

### 1. Build the app image (optional)

```bash
cd app
docker build -t shop-app:vuln .
# Or use the image referenced in the manifest: crvt4722/demo-rce-app
```

### 2. Deploy the "insecure" environment

```bash
kubectl apply -f manifest/01-ecommerce-insecure.yaml
kubectl apply -f manifest/02-database-insecure.yaml
```

Access the app via NodePort `30080` (the `shop-app-svc` service).

### 3. (Optional) Install Falco to observe runtime detection

```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update
helm install falco falcosecurity/falco -n falco --create-namespace -f manifest/falco.yaml
```

---

## Running the attack demo

> Only run this against your own lab. `attack.sh` calls the endpoint configured in the file — update the URL to point at your lab before running.

```bash
# Load the attack() function and variables
source attack.sh

# Then call each step manually to present it (the script is designed to run interactively)
```

Main steps in `attack.sh`:

1. **Grab the SA token** — `cat /var/run/secrets/kubernetes.io/serviceaccount/token`
2. **Call the kube-apiserver** — list namespaces / pods cluster-wide (proves the over-broad RBAC)
3. **Read the Secret** in the `database` namespace — get the MySQL creds (base64)
4. **Decode the creds** — `base64 -d` (reminder: base64 ≠ encryption)
5. **Pivot to MySQL** — `show tables;` then `SELECT * FROM users;` to exfiltrate the fake PII

---

## Defense layers

Applied along the **4C model (Cloud → Cluster → Container → Code)**:

- **Pod hardening** (`manifest/03-case1-hardening.yaml`): disable `automountServiceAccountToken`, enable `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`.
- **NetworkPolicy** (`manifest/04-networkpolicy.yaml`): `default-deny-ingress` for the `database` namespace + a least-privilege allow rule for only the legitimate source → breaks the pivot link (step 5).
  - Requires a CNI that supports NetworkPolicy (Calico, Cilium, Weave... — **not** default Flannel).
- **Runtime detection** (`manifest/falco.yaml`): deploy Falco to detect anomalous behavior (reading the SA token, unexpected shell spawns, suspicious DB connections...).
- **Shift-left / CI scan** (`.github/workflows/build-scan.yml`): scan the image with Trivy right in the Pull Request to block CVEs before they reach the cluster (see the section below).

---

## CI/CD — image scanning with Trivy

The [`.github/workflows/build-scan.yml`](./.github/workflows/build-scan.yml) workflow demonstrates the **"shift-left security"** defense for the **Code/Container** layers: catch vulnerabilities right from the Pull Request instead of letting them reach the cluster.

**Trigger:** on Pull Requests (`opened`, `synchronize`, `reopened`).

**Steps:**

1. **Build the image** from the `./app` context (using Docker Buildx, loaded into the local docker).
2. **Trivy scan** the image → export a JSON report (`os,library`, all severities), without failing at this step so stats can still be gathered.
3. **Summarize results**: count vulnerabilities per severity, build a Markdown table + list CRITICAL/HIGH details.
4. **Comment on the PR**: upsert a **single** comment (look up by marker; update if present, otherwise create).
5. **Fail the pipeline** if any **CRITICAL** vulnerability is found.

> With the intentionally "full" image (`node:20-bullseye` + many system packages) in the demo, Trivy reports a lot of CVEs → illustrating why you should use a minimal (distroless) base image and scan in CI.

---

## Flaw ↔ mitigation table

| Exploited weakness | Mitigation |
|--------------------|------------|
| `exec()` without input sanitization | Use `execFile()`/arg arrays; validate & escape input; upgrade `node-tesseract-ocr` |
| Default SA token automount | `automountServiceAccountToken: false` when the pod doesn't need the API |
| Over-broad RBAC | Least-privilege; scope by namespace/resource |
| Base64 (unencrypted) Secret | Enable encryption-at-rest; use an external secret manager (Vault, SealedSecrets) |
| No NetworkPolicy | Apply NetworkPolicy to block east-west traffic between namespaces |
| MySQL client baked into the image | Use a minimal image (distroless), drop unneeded tools; run as non-root |
| No runtime detection | Deploy Falco to detect anomalous behavior |
| CVE slips into the image, unscanned | Scan the image with Trivy in CI (PR); fail the pipeline on CRITICAL |

---

## Related docs

- [`attack-scenario.en.md`](./attack-scenario.en.md) — step-by-step attack scenario.
- `4C-CloudNative-Security-KCD-Vietnam-2026.pptx` — slide deck.

---

<sub>Made for KCD Vietnam 2026 · Educational use only.</sub>
