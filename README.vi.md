# 4C Cloud Native Security — Demo KCD Vietnam 2026

> 🌐 **Tiếng Việt** · [English](./README.en.md)

> Bộ demo cho phần trình bày **"4C Cloud Native Security"** tại **Kubernetes Community Days (KCD) Vietnam 2026**.
>
> Dự án dựng một ứng dụng e-commerce **cố tình có lỗ hổng** trên Kubernetes, minh hoạ **trọn chuỗi tấn công** (RCE → chiếm ServiceAccount token → gọi kube-apiserver → đọc Secret → pivot sang MySQL đánh cắp dữ liệu) và **các lớp phòng thủ** theo mô hình 4C (Cloud, Cluster, Container, Code).

> ⚠️ **CẢNH BÁO**: Toàn bộ mã và tài liệu ở đây chỉ dùng cho mục đích **giáo dục** và kiểm thử trong **lab cô lập của chính bạn**. **Không** được nhắm vào bất kỳ hệ thống thật hoặc hệ thống mà bạn không có quyền. Mọi dữ liệu trong demo là **100% giả lập**.

---

## Mục lục

- [Tổng quan](#tổng-quan)
- [Ứng dụng web ShopApp](#ứng-dụng-web-shopapp)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)
- [Kiến trúc & lỗ hổng cố ý](#kiến-trúc--lỗ-hổng-cố-ý)
- [Chuỗi tấn công (Kill Chain)](#chuỗi-tấn-công-kill-chain)
- [Triển khai lab](#triển-khai-lab)
- [Chạy demo tấn công](#chạy-demo-tấn-công)
- [Các lớp phòng thủ](#các-lớp-phòng-thủ)
- [CI/CD — quét image bằng Trivy](#cicd--quét-image-bằng-trivy)
- [Bảng lỗ hổng ↔ biện pháp](#bảng-lỗ-hổng--biện-pháp)

---

## Tổng quan

| Mục | Giá trị |
|-----|---------|
| **Lỗ hổng** | CVE-2026-26832 — OS Command Injection |
| **Thành phần bị ảnh hưởng** | `node-tesseract-ocr` <= 2.2.1 |
| **Endpoint** | `POST /api/products/scan-label` |
| **Mục tiêu (lab)** | `https://ecommerce.vdevopssphere.ddnsfree.com` |
| **Tác động** | RCE → chiếm SA token → gọi kube-apiserver → đọc Secret → pivot MySQL đánh cắp dữ liệu |

Ứng dụng `shop-app` là một cửa hàng công nghệ có **giao diện web hoàn chỉnh**, kèm tính năng "seller upload ảnh nhãn sản phẩm → OCR tự đọc text để điền form". Tính năng này gọi `node-tesseract-ocr`, thư viện **không sanitize** `imagePath` trước khi nối vào chuỗi lệnh shell và đưa vào `child_process.exec()` — mở đường cho OS Command Injection.

---

## Ứng dụng web ShopApp

Frontend là một SPA thuần (HTML/CSS/JS, **không cần build tool**) do Express phục vụ tĩnh, giúp buổi demo trực quan hơn: khán giả thấy một tính năng bình thường của người bán, rồi chính field `imagePath` đó bị khai thác.

**Giao diện gồm:**

- **Trang chủ**: header sticky, hero có animation, lưới sản phẩm, khu vực CTA cho người bán.
- **Danh mục sản phẩm**: 8 sản phẩm giả lập, lọc theo category, nút "Thêm vào giỏ".
- **Modal "Quét nhãn (OCR)"**: nhập `imagePath` → gọi endpoint OCR → hiển thị kết quả/lỗi. **Đây chính là bề mặt tấn công** của CVE-2026-26832.

**Các endpoint:**

| Method | Path | Mô tả |
|--------|------|-------|
| `GET` | `/` | Trang giao diện (phục vụ từ `app/public/`) |
| `GET` | `/healthz` | Health check |
| `GET` | `/api/products` | Danh mục sản phẩm giả lập (JSON) |
| `POST` | `/api/products/scan-label` | **OCR — endpoint dính CVE-2026-26832** |

**Chạy thử tại máy (không cần Kubernetes):**

```bash
cd app
npm install
node server.js
# Mở http://localhost:8080
```

> Lưu ý: OCR cần binary `tesseract-ocr` cài trong image Docker. Chạy `node server.js` trực tiếp trên máy chưa cài `tesseract` thì trang web và danh mục vẫn hoạt động, nhưng nút "Quét" sẽ trả lỗi — dùng Docker để test đầy đủ tính năng OCR.

---

## Cấu trúc thư mục

```
KCD2026/
├── app/                              # Ứng dụng shop-app (cố ý có lỗ hổng)
│   ├── server.js                     # Express: phục vụ UI + /api/products + OCR (CVE-2026-26832)
│   ├── public/                       # Giao diện web (SPA tĩnh)
│   │   ├── index.html                #   Trang chủ + modal quét nhãn OCR
│   │   ├── styles.css                #   Giao diện (gradient, responsive)
│   │   └── app.js                    #   Fetch sản phẩm, lọc, gọi endpoint OCR
│   ├── package.json                  # Ghim node-tesseract-ocr 2.2.1 (vuln)
│   └── Dockerfile                    # Base "đầy đủ", chạy root, có sẵn mysql-client
├── .github/workflows/
│   └── build-scan.yml                # CI: build image + quét Trivy + comment vào PR
├── manifest/                         # Manifest Kubernetes
│   ├── 01-ecommerce-insecure.yaml    # Namespace ecommerce + RBAC quá rộng + Deployment shop-app
│   ├── 02-database-insecure.yaml     # Namespace database + Secret base64 + MySQL + seed data
│   ├── 03-case1-hardening.yaml       # Hardening pod: tắt automount SA, readOnlyRootFilesystem...
│   ├── 04-networkpolicy.yaml         # NetworkPolicy chặn pivot east-west sang MySQL
│   └── falco.yaml                    # Helm values cho Falco (runtime detection)
├── attack.sh                         # PoC khai thác — hàm attack() + từng bước kill chain
├── attack-scenario.md                # Tài liệu chi tiết kịch bản tấn công & phòng thủ
└── 4C-CloudNative-Security-KCD-Vietnam-2026.pptx   # Slide trình bày
```

---

## Kiến trúc & lỗ hổng cố ý

Lab gồm 2 namespace:

- **`ecommerce`** — chứa `shop-app` (frontend/API) và ServiceAccount `shop-app-sa`.
- **`database`** — chứa MySQL 8.0, Secret credentials và ConfigMap seed dữ liệu `users`.

Các "lỗi cấu hình phổ biến" được gài sẵn để minh hoạ (theo từng lớp trong 4C):

| Lớp (4C) | Lỗ hổng cố ý | Vị trí |
|----------|--------------|--------|
| **Code** | `node-tesseract-ocr` 2.2.1 dính CVE, không SCA/`npm audit` trong build | `app/server.js`, `app/package.json`, `app/Dockerfile` |
| **Container** | Base image không distroless, chạy **root**, cài sẵn `default-mysql-client` (công cụ pivot) | `app/Dockerfile` |
| **Cluster** | RBAC quá rộng: SA frontend `get/list/watch` được `pods/secrets/services` **toàn cluster** | `manifest/01-ecommerce-insecure.yaml` |
| **Cluster** | Secret chỉ **base64** (không mã hoá), không có NetworkPolicy chặn east-west | `manifest/02-database-insecure.yaml` |

> Lưu ý: trong `01-ecommerce-insecure.yaml`, `automountServiceAccountToken` đã được đặt `false` — tuỳ phiên bản demo có thể bật/tắt để so sánh trước/sau hardening.

---

## Chuỗi tấn công (Kill Chain)

```
[1] RCE qua OCR endpoint
      │  child_process.exec() không sanitize imagePath
      ▼
[2] Đọc ServiceAccount token (automount mặc định)
      │  /var/run/secrets/kubernetes.io/serviceaccount/token
      ▼
[3] Gọi kube-apiserver bằng token
      │  RBAC quá rộng → liệt kê namespaces / pods toàn cluster
      ▼
[4] Đọc Secret trong namespace `database`
      │  .data chứa creds MySQL (base64, KHÔNG mã hoá)
      ▼
[5] Pivot sang MySQL (không có NetworkPolicy chặn)
      │  mysql client có sẵn trong image
      ▼
[6] Đánh cắp toàn bộ bảng `users` (PII)  ← điểm kết
```

Payload chèn vào field `imagePath`:

```
" >/dev/null 2>&1; <LỆNH_CỦA_BẠN> #
```

| Thành phần | Ý nghĩa |
|-----------|---------|
| `"` | Đóng dấu nháy kép mà tesseract bọc quanh `imagePath` (thoát khỏi argument) |
| `>/dev/null 2>&1` | Vứt output/lỗi của lệnh tesseract rỗng cho sạch |
| `; <lệnh>` | Chạy lệnh tuỳ ý của kẻ tấn công |
| `#` | Comment hoá phần `" stdout -l eng ..."` còn thừa phía sau |

Xem chi tiết đầy đủ tại [`attack-scenario.md`](./attack-scenario.md).

---

## Triển khai lab

**Yêu cầu**: một cluster Kubernetes lab (kind/minikube/k3s...), `kubectl`, và (cho demo tấn công) `bash`, `curl`, `jq` trên máy bạn.

### 1. Build image ứng dụng (tuỳ chọn)

```bash
cd app
docker build -t shop-app:vuln .
# Hoặc dùng image có sẵn trong manifest: crvt4722/demo-rce-app
```

### 2. Triển khai môi trường "insecure"

```bash
kubectl apply -f manifest/01-ecommerce-insecure.yaml
kubectl apply -f manifest/02-database-insecure.yaml
```

Truy cập app qua NodePort `30080` (service `shop-app-svc`).

### 3. (Tuỳ chọn) Cài Falco để quan sát runtime detection

```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update
helm install falco falcosecurity/falco -n falco --create-namespace -f manifest/falco.yaml
```

---

## Chạy demo tấn công

> Chỉ chạy trên lab của chính bạn. `attack.sh` gọi tới endpoint cấu hình trong file — sửa URL trỏ về lab của bạn trước khi chạy.

```bash
# Nạp hàm attack() và các biến
source attack.sh

# Sau đó tự gọi từng bước để trình diễn (script được thiết kế để chạy tương tác)
```

Các bước chính trong `attack.sh`:

1. **Lấy SA token** — `cat /var/run/secrets/kubernetes.io/serviceaccount/token`
2. **Gọi kube-apiserver** — liệt kê namespaces / pods toàn cluster (chứng minh RBAC quá rộng)
3. **Đọc Secret** namespace `database` — lấy creds MySQL (base64)
4. **Decode creds** — `base64 -d` (nhắc lại: base64 ≠ mã hoá)
5. **Pivot MySQL** — `show tables;` rồi `SELECT * FROM users;` đánh cắp PII giả lập

---

## Các lớp phòng thủ

Áp dụng theo mô hình **4C (Cloud → Cluster → Container → Code)**:

- **Hardening Pod** (`manifest/03-case1-hardening.yaml`): tắt `automountServiceAccountToken`, bật `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`.
- **NetworkPolicy** (`manifest/04-networkpolicy.yaml`): `default-deny-ingress` cho namespace `database` + chỉ allow least-privilege đúng nguồn cần thiết → chặn mắt xích pivot (bước 5).
  - Yêu cầu CNI hỗ trợ NetworkPolicy (Calico, Cilium, Weave... — **không** phải Flannel mặc định).
- **Runtime detection** (`manifest/falco.yaml`): triển khai Falco phát hiện hành vi bất thường (đọc SA token, spawn shell bất ngờ, kết nối DB lạ...).
- **Shift-left / CI scan** (`.github/workflows/build-scan.yml`): quét image bằng Trivy ngay trong Pull Request để chặn CVE trước khi lên cluster (xem mục bên dưới).

---

## CI/CD — quét image bằng Trivy

Workflow [`.github/workflows/build-scan.yml`](./.github/workflows/build-scan.yml) minh hoạ lớp phòng thủ **"shift-left security"** cho lớp **Code/Container**: bắt lỗ hổng ngay từ Pull Request thay vì để lọt lên cluster.

**Kích hoạt:** khi có Pull Request (`opened`, `synchronize`, `reopened`).

**Các bước:**

1. **Build image** từ context `./app` (dùng Docker Buildx, load vào docker local).
2. **Trivy scan** image → xuất báo cáo JSON (`os,library`, mọi mức severity), không fail ở bước này để còn thống kê.
3. **Tổng hợp kết quả**: đếm số lỗ hổng theo severity, dựng bảng Markdown + liệt kê chi tiết CRITICAL/HIGH.
4. **Comment vào PR**: upsert **một** comment duy nhất (tìm theo marker, có thì update, chưa có thì tạo mới).
5. **Fail pipeline** nếu phát hiện bất kỳ lỗ hổng **CRITICAL** nào.

> Với image cố ý "đầy đủ" (`node:20-bullseye` + nhiều package hệ thống) trong demo, Trivy sẽ báo rất nhiều CVE → minh hoạ vì sao nên dùng base image tối giản (distroless) và quét trong CI.

---

## Bảng lỗ hổng ↔ biện pháp

| Điểm yếu bị khai thác | Biện pháp khắc phục |
|----------------------|---------------------|
| `exec()` không sanitize input | Dùng `execFile()`/mảng args; validate & escape input; nâng cấp `node-tesseract-ocr` |
| Automount SA token mặc định | `automountServiceAccountToken: false` khi pod không cần API |
| RBAC quá rộng | Least-privilege; giới hạn theo namespace/resource |
| Secret base64 không mã hoá | Bật encryption-at-rest; dùng external secret manager (Vault, SealedSecrets) |
| Không có NetworkPolicy | Áp NetworkPolicy chặn traffic đông-tây giữa các namespace |
| Client MySQL nằm sẵn trong image | Dùng image tối giản (distroless), loại bỏ tool không cần thiết; chạy non-root |
| Không có runtime detection | Triển khai Falco để phát hiện hành vi bất thường |
| CVE lọt vào image, không quét | Quét image bằng Trivy trong CI (PR), fail pipeline khi có CRITICAL |

---

## Tài liệu liên quan

- [`attack-scenario.md`](./attack-scenario.md) — kịch bản tấn công chi tiết từng bước.
- `4C-CloudNative-Security-KCD-Vietnam-2026.pptx` — slide trình bày.

---

<sub>Made for KCD Vietnam 2026 · Educational use only.</sub>
