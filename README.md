# Đậu TOEIC crawler

CLI TypeScript để thu thập dữ liệu TOEIC từ `dautoeic.com` trong phạm vi đã được cấp quyền. Tool dùng Google OAuth thủ công để lấy Supabase user session, sau đó capture các request được ứng dụng thực hiện. Mặc định mọi thao tác với nguồn là read-only.

## Yêu cầu

- Node.js 22 trở lên.
- Google Chrome.
- Tài khoản Đậu TOEIC được phép truy cập nội dung cần crawl.

## Cài đặt

```bash
npm install
npm run db:migrate
```

Project đã có `.env` với Supabase URL và anon key public được lấy từ frontend. Không thêm mật khẩu, OTP, cookie, access token hoặc refresh token vào `.env`.

## Đăng nhập Google

```bash
npm run auth
```

Chrome sẽ mở trang đăng nhập Đậu TOEIC mà không gắn automation. Tự nhập tài khoản/2FA trong browser; sau khi OAuth quay về Đậu TOEIC và tài khoản đã hiện, đóng toàn bộ cửa sổ Chrome tạm đó. Tool sẽ mở lại profile cục bộ để chỉ lấy session của website tại:

- `.auth/session.json`: session Supabase dùng bởi CLI.
- `.auth/storage-state.json`: browser state dùng cho discovery/DOM fallback.

Thư mục `.auth/` có quyền `0700`, file bên trong có quyền `0600` và đã nằm trong `.gitignore`.

Xóa session local:

```bash
npm run auth:clear
```

## Crawl dữ liệu

Đồng bộ catalog qua hai RPC read-only đã xác nhận:

```bash
npm run crawl -- catalog
```

Crawl một đề bằng ID từ catalog:

```bash
npm run crawl -- test --test-id <uuid>
```

Crawl toàn bộ đề tìm thấy; `--resume` bỏ qua đề đã hoàn tất:

```bash
npm run crawl -- all --all-discovered --resume
```

RPC catalog của giao diện chỉ liệt kê 6 đề. Để nhóm toàn bộ câu mock-test mà tài khoản được phép đọc và crawl các nhóm đủ chính xác 200 câu/Part 1–7:

```bash
npm run crawl -- discover-test-bank
npm run crawl -- test-bank --resume
```

`test-bank` mặc định ưu tiên lấy đủ nhiều đề: lưu câu hỏi, đáp án, giải thích, passage, transcript và URL audio/hình nhưng không tải binary. Thêm `--with-media` để tải media của toàn bộ kho. Crawler dùng RPC read-only `get_mock_test_media_batch` giống frontend để resolve các đường dẫn tương đối, tái sử dụng file đã tải và retry lỗi mạng tối đa ba lần.

Nếu không muốn chọn toàn bộ catalog, điền ID hoặc tên chính xác vào mảng `tests` trong `crawler.config.json`, rồi chạy:

```bash
npm run crawl -- all --resume
```

Thử tải lại các media đang có trạng thái `failed`:

```bash
npm run crawl -- retry-media
```

Các kho bài bổ sung ngoài full test:

```bash
npm run crawl -- discover-site
npm run crawl -- inventory
npm run crawl -- content
npm run crawl -- content-media --budget-mb 2048 --min-free-mb 1024
```

`content-media` hỗ trợ resume/dedup, có giới hạn số byte tải mới và tự dừng trước ngưỡng dung lượng trống.

Hai lệnh browser sau chỉ phục vụ discovery/debug. Chúng áp dụng allowlist và chặn source mutation:

```bash
npm run crawl -- catalog-browser
npm run crawl -- inspect --test-title "Test 1" --headed
```

Raw response đã redaction được nén vào `data/raw/`. Report ngắn gọn nằm trong `data/reports/`. Header/token/cookie và chữ ký của signed URL không được ghi vào hai nơi này.

POST/RPC không có trong `readOnlyPostEndpoints` sẽ bị chặn. Crawler chính hiện chỉ đọc catalog qua hai RPC allowlist và đọc nội dung đề qua GET PostgREST; nó không tạo attempt/progress hay đăng ký thiết bị trên tài khoản nguồn.

## Kiểm tra và export

```bash
npm run typecheck
npm test
npm run validate
npm run export -- --format json --output data/exports/toeic.json
npm run export-tests -- --output-dir data/exports/tests
```

`export-tests` tạo một file JSON lồng sẵn cho mỗi đề và `manifest.json` để tra danh sách. Schema export v3 giữ cả các cột normalized lẫn object `sourcePayload` nguyên bản cho test, passage và question. Trong mỗi file, dữ liệu đi theo cấu trúc `parts[].groups[].questions[]`; câu không thuộc passage nằm trong `parts[].standaloneQuestions[]`.

`validate` kiểm tra thêm độ hoàn chỉnh của đề 200 câu, passage không được tham chiếu, URL media chưa resolve, source payload bị thiếu, media chưa gắn entity và media chưa tải xong. Lệnh trả exit code khác 0 nếu bất kỳ nhóm kiểm tra nào còn lỗi.

## Quy tắc an toàn

- Không gửi mật khẩu Google, OTP hoặc recovery code vào terminal/chat.
- Không sử dụng Supabase `service_role` key.
- Không quét table/RPC ngoài traffic hợp lệ hoặc mapping được cấp.
- Source mutation bị tắt mặc định và cần cả config lẫn CLI flag để bật.
- Khi nhận `401`, `403`, CAPTCHA hoặc schema thay đổi diện rộng, tool dừng thay vì thử vượt qua.

Thiết kế chi tiết nằm trong [plan.md](./plan.md).
