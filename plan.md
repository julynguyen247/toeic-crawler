# Kế hoạch xây dựng tool crawl đề TOEIC từ dautoeic.com

## 1. Mục tiêu

Xây dựng một CLI có khả năng đăng nhập vào `dautoeic.com`, lấy dữ liệu các bộ đề TOEIC mà tài khoản được phép truy cập, chuẩn hóa dữ liệu và xuất ra định dạng có thể dùng lại trong ứng dụng khác.

Tool cần thu thập được:

- Danh sách bộ đề và từng test.
- Cấu trúc Part 1 đến Part 7.
- Passage, đoạn hội thoại hoặc nhóm câu hỏi.
- Nội dung câu hỏi và các lựa chọn.
- Đáp án đúng, giải thích và dẫn chứng nếu tài khoản có quyền xem.
- Transcript và bản dịch nếu có.
- Audio, hình ảnh và các media liên quan.
- Metadata: ID nguồn, thứ tự, độ khó và URL nguồn.

Đầu ra chính:

- Một file SQLite chứa dữ liệu đã chuẩn hóa.
- Các file JSON để trao đổi hoặc import sang hệ thống khác.
- Thư mục media chứa audio và hình ảnh.
- Báo cáo kết quả của mỗi lần crawl.

## 2. Giả định và phạm vi quyền hạn

Kế hoạch này giả định chủ sở hữu website đã cấp quyền crawl và cho phép lưu trữ nội dung trong phạm vi dự án.

Tài khoản được cung cấp sau phải có quyền truy cập hợp lệ vào các đề cần lấy. Tool không thực hiện:

- Vượt CAPTCHA, anti-bot, paywall hoặc giới hạn quyền của tài khoản.
- Khai thác lỗ hổng hay gọi các API mà tài khoản không được phép dùng.
- Tự động mua gói, thay đổi tài khoản hoặc đăng nội dung lên website.
- Phát tán dữ liệu ra ngoài phạm vi đã được cấp phép.

## 3. Quan sát ban đầu về website

Tại thời điểm khảo sát:

- Website là ứng dụng React/PWA và dữ liệu được tải động.
- Trang danh sách đề nằm tại `/mock-test`.
- Danh sách public đang hiển thị bộ `Pass TOEIC` với 6 test.
- Khi chọn `Luyện tập`, website yêu cầu đăng nhập.
- Route làm bài có thể nằm dưới `/mock-test-practice` hoặc một route động tương đương.
- Nội dung chi tiết nhiều khả năng được tải qua API sau khi người dùng đăng nhập.

Các thông tin trên chỉ phục vụ discovery; tool không được phụ thuộc cứng vào tên bộ đề, số lượng test hoặc URL động hiện tại.

## 4. Chiến lược kỹ thuật

Áp dụng mô hình **API-first, Playwright fallback**:

1. Playwright đảm nhiệm đăng nhập và tạo session hợp lệ.
2. Trong giai đoạn discovery, ghi lại các request mà giao diện thực hiện khi mở một đề.
3. Nếu có API ổn định và được phép sử dụng, crawler gọi API bằng chính session của tài khoản.
4. Nếu dữ liệu chỉ tồn tại sau khi render hoặc API không ổn định, dùng Playwright đọc DOM.
5. Media được tải bằng URL mà ứng dụng trả về, kèm session/header cần thiết.

### 4.1. Adapter dành riêng cho Supabase

Vì frontend sử dụng Supabase, API adapter ưu tiên tái hiện đúng các request Supabase mà giao diện đang gọi:

- `SUPABASE_URL` và `SUPABASE_ANON_KEY` được lấy từ cấu hình public của frontend hoặc do chủ website cung cấp.
- `anon key` là key public dùng để xác định project/role `anon`; bản thân key này không cấp quyền đọc toàn bộ database.
- Khi đã đăng nhập, request cần gửi thêm access token của user qua `Authorization: Bearer <access_token>`.
- Quyền đọc thực tế phải tiếp tục tuân theo Row Level Security (RLS), policy và quyền của tài khoản crawl.
- Dùng PostgREST cho table/view, RPC endpoint cho database function, Storage API cho media và Edge Function nếu luồng gốc sử dụng các thành phần này.
- Chỉ gọi table/view/RPC quan sát được từ traffic hợp lệ của ứng dụng hoặc được chủ website cung cấp; không quét schema hay thử tên bảng hàng loạt.
- Không sử dụng `service_role` key. Nếu chủ website muốn cấp quyền rộng hơn, họ nên tạo policy, view, RPC hoặc export endpoint riêng cho tài khoản crawler.

Header dự kiến cho request đã đăng nhập:

```http
apikey: <SUPABASE_ANON_KEY>
Authorization: Bearer <USER_ACCESS_TOKEN>
Content-Type: application/json
```

Chốt cách triển khai:

- Dùng `@supabase/supabase-js` để bootstrap Auth, kiểm tra user và refresh session.
- Dùng một HTTP adapter mỏng dựa trên `fetch` để tái hiện các request PostgREST/RPC/Storage đã quan sát, qua đó kiểm soát pagination, retry, rate limit và redaction log.
- Mọi endpoint, HTTP method và RPC được khai báo trong allowlist. Adapter mặc định từ chối write operation ngoài allowlist.

Không dựa hoàn toàn vào CSS class vì class của frontend build có thể thay đổi. Với DOM crawler, ưu tiên:

- URL và ID ổn định.
- ARIA role, label và heading.
- Thuộc tính `data-*` nếu có.
- Quan hệ cấu trúc giữa Part, passage và question.
- CSS selector chỉ là phương án cuối.

## 5. Công nghệ đề xuất

- Node.js 22+.
- TypeScript.
- Playwright cho browser automation và session.
- `@supabase/supabase-js` cho Auth và refresh session.
- Zod để kiểm tra dữ liệu đầu vào từ API/DOM.
- Drizzle ORM + `better-sqlite3`, quản lý schema bằng migration.
- Pino cho structured logging.
- Vitest cho unit/integration test.
- ESLint và Prettier cho chất lượng code.

## 6. Cấu trúc project dự kiến

```text
.
├── src/
│   ├── cli.ts
│   ├── config.ts
│   ├── auth/
│   │   ├── login.ts
│   │   ├── session-provider.ts
│   │   └── session-store.ts
│   ├── discovery/
│   │   ├── capture-network.ts
│   │   └── inspect-test.ts
│   ├── crawler/
│   │   ├── catalog.ts
│   │   ├── test.ts
│   │   ├── supabase-adapter.ts
│   │   ├── source-policy.ts
│   │   ├── dom-adapter.ts
│   │   └── media.ts
│   ├── parsers/
│   │   ├── question.ts
│   │   ├── passage.ts
│   │   └── explanation.ts
│   ├── storage/
│   │   ├── database.ts
│   │   ├── schema.ts
│   │   ├── repositories.ts
│   │   └── export-json.ts
│   ├── validation/
│   │   └── validate-test.ts
│   └── shared/
│       ├── retry.ts
│       ├── rate-limit.ts
│       └── checksum.ts
├── tests/
│   ├── fixtures/
│   ├── unit/
│   └── integration/
├── data/
│   ├── toeic.sqlite
│   ├── exports/
│   ├── media/
│   ├── raw/
│   └── reports/
├── .auth/
│   ├── session.json
│   └── storage-state.json
├── drizzle/
├── .env.example
├── package.json
└── README.md
```

`.auth/`, `.env`, database, raw snapshots và media phải được thêm vào `.gitignore` mặc định.

## 7. Mô hình dữ liệu

Mọi entity lấy từ nguồn có các trường provenance chung khi phù hợp:

- `source_system`: mặc định `dautoeic`.
- `source_id` và/hoặc locator ổn định từ nguồn.
- `source_url` không chứa token hoặc chữ ký tạm thời.
- `source_updated_at`, nếu API nguồn cung cấp.
- `first_seen_run_id`, `last_seen_run_id`.
- `first_seen_at`, `last_seen_at`.
- `content_hash` tính trên nội dung đã chuẩn hóa, không tính signed query string hay timestamp crawl.

### `collections`

- `id`: ID nội bộ.
- `source_id`: ID của bộ đề trên website.
- `title`.
- `description`.
- `source_url`.

### `tests`

- `id`.
- `collection_id`.
- `source_id`.
- `title`.
- `difficulty`.
- `question_count`.
- `source_url`.
- `content_hash`.
- `crawl_status`.
- `crawled_at`.

### `parts`

- `id`.
- `test_id`.
- `part_number` từ 1 đến 7.
- `title`.
- `instructions`.
- `position`.

### `question_groups`

Dùng cho passage, đoạn hội thoại, chuỗi hình ảnh hoặc một context chung của nhiều câu.

- `id`.
- `part_id`.
- `source_id`.
- `content_html`.
- `content_text`.
- `transcript`.
- `translation`.
- `position`.

### `questions`

- `id`.
- `part_id`.
- `group_id`, nullable.
- `source_id`.
- `question_number`.
- `prompt_html`.
- `prompt_text`.
- `correct_choice_key`.
- `explanation_html`.
- `explanation_text`.
- `evidence`.
- `position`.
- `content_hash`.

### `choices`

- `id`.
- `question_id`.
- `choice_key`: `A`, `B`, `C`, `D`.
- `content_html`.
- `content_text`.
- `position`.

### `media`

- `id`.
- `provider`: `supabase-storage` hoặc `external`.
- `bucket`, nullable.
- `object_path`, nullable.
- `canonical_url`, nullable; phải loại bỏ query chứa token/chữ ký.
- `local_path`.
- `media_type`: audio, image hoặc video.
- `mime_type`.
- `sha256`.
- `byte_size`.
- `download_status`.
- `last_downloaded_at`.

Signed URL chỉ được giữ trong bộ nhớ trong lúc download. Database và log không lưu chữ ký, access token hoặc toàn bộ signed URL. Khi retry, crawler tạo/lấy lại URL mới từ luồng được cấp quyền dựa trên `bucket` + `object_path` hoặc canonical locator.

### `entity_media`

Bảng liên kết media với test, part, group hoặc question.

- `media_id`.
- `entity_type`.
- `entity_id`.
- `purpose`: listening audio, prompt image, explanation image, v.v.

### `crawl_runs`

- `id`.
- `started_at`, `finished_at`.
- `mode`.
- `status`.
- `tests_discovered`.
- `tests_succeeded`.
- `tests_failed`.
- `questions_saved`.
- `media_saved`.
- `error_summary`.

### `source_snapshots`

Lưu dấu vết dữ liệu thô để có thể debug parser và xem lịch sử thay đổi mà không ghi đè mất bản cũ.

- `id`.
- `crawl_run_id`.
- `entity_type`.
- `entity_source_id`.
- `payload_path`: đường dẫn tới JSON gzip trong `data/raw/<run-id>/`.
- `payload_sha256`.
- `captured_at`.
- `redaction_version`.

Raw snapshot phải được redaction trước khi ghi: bỏ `Authorization`, `apikey`, cookie, refresh token, signed query string và dữ liệu tài khoản không cần thiết.

Unique constraint được scope theo quan hệ, không unique `source_id` toàn cục:

- Collection: `(source_system, source_id)`.
- Test: `(collection_id, source_id)`.
- Part: `(test_id, part_number)`.
- Group: `(part_id, source_id)`; nếu nguồn không có ID thì dùng `(part_id, position, content_hash)`.
- Question: `(test_id, source_id)`; fallback `(test_id, question_number)`.
- Choice: `(question_id, choice_key)`.
- Media locator: `(provider, bucket, object_path)` hoặc canonical URL; nội dung media chống trùng thêm bằng `sha256`.

Upsert chỉ cập nhật bản hiện tại sau khi đã lưu snapshot mới. Migration Drizzle phải có version và chạy tự động trước lệnh crawl/export.

## 8. Luồng đăng nhập

### Cách mặc định: đăng nhập thủ công

1. Chạy `npm run auth`.
2. Tool mở Chromium ở chế độ headed.
3. Người dùng tự nhập tài khoản, mật khẩu và OTP nếu có.
4. Sau khi login thành công, tool xác minh browser đã có request Supabase mang JWT user và gọi được `auth.getUser()`.
5. Tool lưu Playwright `storageState` vào `.auth/storage-state.json`, bao gồm localStorage và IndexedDB nếu phiên bản Playwright/site cần dùng IndexedDB.
6. `SessionProvider` tìm đúng Supabase auth storage key theo project ref, parse `access_token`, `refresh_token`, `expires_at` và `user`, rồi ghi bản tối thiểu vào `.auth/session.json`.
7. Khi khởi động crawler, `SessionProvider` nạp `.auth/session.json`, gọi `supabase.auth.setSession()` và kiểm tra lại `supabase.auth.getUser()` trước request đầu tiên.
8. Nếu token còn dưới 60 giây, gọi `refreshSession()` trước khi crawl. Session mới được ghi atomically vào `.auth/session.json` bằng temporary file + rename.
9. Nếu refresh thất bại hoặc user không hợp lệ, tool dừng và yêu cầu chạy lại `npm run auth`; không fallback sang anonymous crawl ngoài phạm vi catalog public.

Đây là cách an toàn hơn việc lưu username/password trong `.env` và tương thích với OTP/CAPTCHA.

Yêu cầu bảo mật:

- Thư mục `.auth/` có permission `0700`; các file session có permission `0600`.
- Không commit session, cookie, token hoặc mật khẩu.
- Không in token/cookie ra log.
- `.auth/session.json` là nguồn session chính của CLI; `storage-state.json` chỉ phục vụ browser fallback và discovery.
- Refresh token chỉ tồn tại trong các file session local được bảo vệ; không chép sang report, raw snapshot hoặc fixture.
- Không coi `anon key` là credential thay thế cho đăng nhập. Các query authenticated luôn cần JWT của user.
- Redactor phải che các header `Authorization`, `apikey`, `Cookie`, token trong JSON và query string có chữ ký trước khi ghi log/fixture.
- Khi session hết hạn, dừng với thông báo yêu cầu chạy lại `npm run auth`.
- Có lệnh `npm run auth:clear` để xóa session cục bộ.

## 9. Pipeline crawl

### Bước 1: discovery catalog

- Mở trang `/mock-test` bằng session đã đăng nhập.
- Thu thập danh sách collection và test.
- Lưu ID, title, trạng thái truy cập và URL.
- Không crawl chi tiết ở chế độ `catalog-only`.

### Bước 2: discovery một test mẫu

- Chọn một test mà tài khoản có quyền truy cập.
- Bật network capture trước khi mở test.
- Ghi nhận request/response PostgREST, RPC, Storage hoặc Edge Function liên quan đến cấu trúc đề, câu hỏi, đáp án và media.
- Lập mapping endpoint → table/view/RPC → entity trong schema nội bộ.
- Xác định pagination (`Range`, `limit`/`offset` hoặc cursor), filter, select và quan hệ embed mà frontend sử dụng.
- Phân loại từng request thành read-only, read RPC dùng `POST`, hoặc source mutation.
- Tạo fixture đã loại bỏ cookie/token để dùng trong test parser.
- Quyết định Supabase adapter là luồng chính; DOM chỉ là fallback cho field không có trong response được cấp quyền.

### Bước 3: lấy cấu trúc đề

- Lấy Part theo đúng thứ tự.
- Lấy group/passage trước, sau đó liên kết câu hỏi.
- Giữ cả HTML đã làm sạch và plain text nếu nội dung có định dạng.
- Chuẩn hóa khoảng trắng nhưng không làm mất xuống dòng có ý nghĩa.

### Bước 4: lấy đáp án và giải thích

Một số website chỉ trả đáp án sau khi submit hoặc khi mở chế độ review. Crawler chỉ dùng luồng được cấp quyền và phải tránh tạo lịch sử học không cần thiết.

Crawler mặc định chạy với source policy **read-only**:

- Cho phép `GET`/`HEAD` trên endpoint nằm trong allowlist.
- Cho phép `POST` chỉ với RPC/Edge Function đã được xác nhận là read-only và khai báo rõ trong allowlist.
- Chặn insert, update, upsert, delete và request làm thay đổi tiến độ/lịch sử tài khoản.
- Nếu một test chỉ trả đáp án sau mutation, test đó được đánh dấu `blocked_by_source_mutation` thay vì tự submit.
- Chỉ cho phép mutation khi đồng thời có tài khoản crawl riêng, cấu hình `allowSourceMutations: true` và flag CLI `--allow-source-mutations`. Report phải liệt kê từng mutation đã thực hiện.

Thứ tự ưu tiên:

1. Endpoint review/answer chính thức mà tài khoản có quyền gọi.
2. Chế độ luyện tập có hiển thị đáp án mà không cần submit bài giả.
3. DOM extraction từ trang review.

Nếu việc lấy đáp án bắt buộc phải làm thay đổi tiến độ tài khoản, adapter phải hỗ trợ tài khoản crawl riêng và ghi rõ side effect trong report.

### Bước 5: tải media

- Tải theo streaming, không giữ toàn bộ file trong RAM.
- Giữ extension dựa trên MIME type, không tin tuyệt đối vào URL.
- Tính SHA-256 để chống trùng.
- Tên file đề xuất: `media/<sha256>.<ext>`.
- Retry riêng cho lỗi mạng tạm thời.
- Nếu URL ký có thời hạn, tải ngay trong cùng session crawl.
- Không ghi signed URL vào database/log; chỉ lưu canonical locator và xin URL mới khi retry.
- Media hỏng không làm mất dữ liệu text; đánh dấu lỗi để chạy lại.

### Bước 6: validate và commit

- Fetch, ghi raw snapshot, parse và validate toàn bộ dữ liệu bên ngoài transaction.
- Download media vào file `.partial`, kiểm tra MIME/checksum rồi rename atomically; không giữ database transaction trong lúc có network I/O.
- Mở một transaction ngắn để upsert entity của test, liên kết snapshot/run và cập nhật trạng thái.
- Cập nhật trạng thái media trong transaction ngắn riêng để `retry-media` có thể tiếp tục độc lập.
- Chỉ đánh dấu test `complete` khi dữ liệu bắt buộc đã hợp lệ.
- Tạo report JSON sau mỗi test.

## 10. Rate limit và độ ổn định

Giá trị mặc định thận trọng:

- Một test được xử lý tại một thời điểm.
- Tối đa một request dữ liệu mỗi giây nếu phải gọi API tuần tự.
- Media concurrency tối đa 2.
- Thêm jitter 200–500 ms giữa các lần điều hướng.
- Retry tối đa 3 lần cho `408`, `429` và lỗi `5xx`.
- Exponential backoff: 2 giây, 5 giây, 15 giây.
- Tôn trọng `Retry-After` nếu server trả về.

Tool phải dừng thay vì retry liên tục khi gặp:

- `401`: session hết hạn.
- `403`: không có quyền hoặc server từ chối.
- CAPTCHA/anti-bot challenge.
- Response schema thay đổi trên diện rộng.
- Tỷ lệ lỗi vượt ngưỡng cấu hình, mặc định 20%.

## 11. Resume, chống trùng và phát hiện thay đổi

- Mỗi test có trạng thái `pending`, `running`, `complete`, `partial` hoặc `failed`.
- Ghi checkpoint sau từng test và từng batch media.
- Chạy `--resume` bỏ qua test đã hoàn thành và tiếp tục test lỗi.
- `--force` crawl lại test được chỉ định.
- Tính `content_hash` trên dữ liệu đã chuẩn hóa để phát hiện nội dung thay đổi.
- Nếu source thay đổi, cập nhật record hiện tại và lưu thời điểm phát hiện.
- Không xóa dữ liệu cũ chỉ vì một lần crawl không nhìn thấy nó; đánh dấu `missing_from_source` để kiểm tra thủ công.

## 12. Giao diện CLI dự kiến

```bash
# Mở browser để đăng nhập và lưu session
npm run auth

# Chỉ lấy danh sách bộ đề/test
npm run crawl -- catalog

# Khảo sát network của một test
npm run crawl -- inspect --test-id <source-test-id>

# Crawl thử một test, không ghi database
npm run crawl -- test --test-id <source-test-id> --dry-run

# Crawl và lưu một test
npm run crawl -- test --test-id <source-test-id>

# Chỉ dùng với tài khoản crawl riêng và config đã cho phép source mutation
npm run crawl -- test --test-id <source-test-id> --allow-source-mutations

# Crawl toàn bộ phạm vi được cấu hình
npm run crawl -- all

# Tiếp tục lần chạy bị gián đoạn
npm run crawl -- all --resume

# Tải lại các media lỗi
npm run crawl -- retry-media

# Validate database và media
npm run validate

# Xuất JSON
npm run export -- --format json --output data/exports
```

## 13. Cấu hình

File `.env` chỉ chứa cấu hình không nhạy cảm và đường dẫn local:

```dotenv
SOURCE_BASE_URL=https://dautoeic.com
SUPABASE_URL=
SUPABASE_ANON_KEY=
AUTH_STATE_PATH=.auth/storage-state.json
AUTH_SESSION_PATH=.auth/session.json
DATABASE_PATH=data/toeic.sqlite
MEDIA_DIR=data/media
RAW_SNAPSHOT_DIR=data/raw
REPORT_DIR=data/reports
REQUEST_DELAY_MS=1000
MEDIA_CONCURRENCY=2
HEADLESS=true
LOG_LEVEL=info
```

`SUPABASE_ANON_KEY` là giá trị public xuất hiện ở frontend nhưng vẫn để trong cấu hình thay vì hard-code nhằm dễ đổi project/key. `service_role` tuyệt đối không nằm trong cấu hình crawler.

Các collection/test cần crawl đặt trong `crawler.config.json`, hỗ trợ allowlist và denylist. File này cũng khai báo endpoint/RPC allowlist và mặc định `allowSourceMutations: false`. Không mặc định crawl toàn bộ nội dung mới xuất hiện nếu chưa nằm trong phạm vi được duyệt.

## 14. Kiểm thử

### Unit test

- Parse collection/test metadata.
- Parse từng loại câu hỏi Part 1–7.
- Parse choice, đáp án và giải thích.
- Chuẩn hóa HTML/text.
- Tính hash và chống trùng media.
- Retry/backoff và rate limiter.
- Parse/bootstrap/refresh Supabase session.
- Source policy chặn write và chỉ cho phép read RPC trong allowlist.
- Loại signed query/token khỏi canonical media locator.
- Redaction header, token, cookie và signed URL.

### Integration test

- Dùng response fixture đã loại bỏ thông tin nhạy cảm.
- Crawl một test vào database tạm.
- Chạy lại cùng fixture và xác nhận không tạo bản ghi trùng.
- Giả lập media lỗi và kiểm tra resume.
- Giả lập session hết hạn và kiểm tra tool dừng an toàn.
- Kiểm tra token refresh được ghi atomically và không xuất hiện trong log/fixture/raw snapshot.
- Kiểm tra cùng `source_id` ở hai scope khác nhau không bị ghi đè.
- Kiểm tra raw snapshot được lưu trước khi upsert nội dung thay đổi.
- Kiểm tra không có database transaction nào được giữ mở trong lúc mock network/media đang chờ.

### Smoke test trên website

- Đăng nhập bằng tài khoản crawl.
- Chạy catalog.
- Dry-run một test.
- Crawl một test hoàn chỉnh.
- Xác nhận lần chạy mặc định không tạo submission/progress mới trên tài khoản nguồn.
- Đối chiếu thủ công ít nhất 10 câu thuộc nhiều Part.

## 15. Tiêu chí kiểm tra dữ liệu

Với mỗi test hoàn thành:

- Không trùng số câu trong cùng test.
- Các câu được gắn đúng Part và đúng group.
- Choice key không trùng trong cùng câu.
- Đáp án đúng phải tham chiếu tới một choice tồn tại.
- Media local tồn tại và checksum khớp database.
- Tổng số câu khớp với thông tin hiển thị trên website, nếu website cung cấp.
- TOEIC full test thông thường được cảnh báo nếu không có đủ Part 1–7 hoặc lệch đáng kể khỏi cấu trúc 100 câu Listening và 100 câu Reading; cảnh báo này không tự động xóa dữ liệu.
- Random sample được đối chiếu với giao diện nguồn.

## 16. Logging và báo cáo

Log console cần ngắn gọn, không chứa nội dung đề đầy đủ hoặc thông tin đăng nhập. Mỗi crawl run tạo một report như sau:

```json
{
  "runId": "2026-08-23T12-00-00Z",
  "status": "partial",
  "collectionsDiscovered": 1,
  "testsDiscovered": 6,
  "testsCompleted": 5,
  "testsFailed": 1,
  "questionsSaved": 1000,
  "mediaSaved": 124,
  "readOnly": true,
  "sourceMutations": [],
  "errors": [
    {
      "testId": "example-id",
      "stage": "media",
      "code": "DOWNLOAD_TIMEOUT"
    }
  ]
}
```

## 17. Các giai đoạn triển khai

### Giai đoạn 0 — Chuẩn bị

- Xác nhận phạm vi đã được cấp phép.
- Nhận tài khoản crawl riêng.
- Xác nhận Supabase project URL và anon key đang được frontend sử dụng.
- Chốt output cần dùng: SQLite, JSON và media.
- Khởi tạo project TypeScript, Drizzle migrations và bảo vệ secrets.

**Kết quả:** project chạy được, có login flow và session local.

### Giai đoạn 1 — Discovery

- Crawl catalog.
- Inspect network của một test mẫu.
- Xác định table/view/RPC/Storage bucket hoặc Edge Function, pagination và cách lấy đáp án/media.
- Kiểm tra query bằng anon key đơn lẻ và bằng anon key + user JWT để ghi nhận rõ quyền RLS, không tìm cách mở rộng quyền.
- Phân loại và lập allowlist read-only cho endpoint/RPC; xác định trước luồng nào có source mutation.
- Lưu fixture an toàn.
- Chốt Supabase adapter và các điểm phải fallback sang DOM.

**Kết quả:** tài liệu mapping source → schema và fixture của một test.

### Giai đoạn 2 — Prototype một test

- Implement parser và storage.
- Crawl đầy đủ một test.
- Tải media và export JSON.
- Đối chiếu thủ công dữ liệu.

**Kết quả:** một test hoàn chỉnh, có report và không trùng khi chạy lại.

### Giai đoạn 3 — Crawler hoàn chỉnh

- Crawl nhiều collection/test.
- Thêm retry, rate limit, checkpoint và resume.
- Xử lý session expiry và lỗi từng test.
- Hoàn thiện snapshot/revision và signed-media retry.
- Hoàn thiện CLI.

**Kết quả:** chạy batch ổn định mà không mất tiến độ.

### Giai đoạn 4 — Validation và bàn giao

- Unit/integration/smoke test.
- Chạy thử toàn bộ phạm vi nhỏ.
- Viết README vận hành và xử lý sự cố.
- Chốt báo cáo dữ liệu thiếu/lỗi.

**Kết quả:** tool, database mẫu, JSON export, test suite và tài liệu sử dụng.

## 18. Ước lượng

Ước lượng sau khi có tài khoản và quyền truy cập:

- Setup, Drizzle migrations và auth flow: 0,5–1 ngày.
- Discovery API/DOM và source-policy mapping: 1–1,5 ngày.
- Prototype một test: 1–1,5 ngày.
- Batch crawler, media, snapshot và resume: 1,5–2 ngày.
- Validation, test và tài liệu: 1 ngày.

Tổng: khoảng **5–7 ngày làm việc**. Thời gian có thể tăng nếu đáp án chỉ xuất hiện qua workflow có mutation, media dùng URL ký ngắn hạn hoặc cấu trúc từng Part khác nhau đáng kể.

## 19. Definition of Done

Tool được xem là hoàn thành khi:

- Đăng nhập và tái sử dụng session mà không lưu mật khẩu trong source code.
- Bootstrap/refresh Supabase session an toàn và không làm rò token vào log, fixture hoặc snapshot.
- Phát hiện đúng các collection/test trong phạm vi cấu hình.
- Crawl đầy đủ text, lựa chọn, đáp án, giải thích và media mà tài khoản được phép xem.
- Dữ liệu được chuẩn hóa, có source ID/URL và không trùng khi chạy lại.
- Composite unique key không làm đè entity trùng ID ở scope khác.
- Signed media được lưu bằng canonical locator và có thể xin URL mới để retry.
- Raw snapshot/revision cho phép kiểm tra nội dung trước và sau khi nguồn thay đổi.
- Có retry, rate limit, checkpoint và resume.
- Read-only là mặc định; mọi source mutation cần cấu hình và flag rõ ràng.
- Không giữ database transaction trong lúc chờ network hoặc download media.
- Không ghi cookie/token vào log hoặc Git.
- Validate được cấu trúc đề và phát hiện dữ liệu thiếu.
- Export được SQLite và JSON.
- Có report cho từng lần chạy.
- Có README với lệnh login, crawl, resume, validate và export.

## 20. Thông tin cần cung cấp trước khi bắt đầu code

- Tài khoản crawl riêng và cách đăng nhập/OTP.
- Supabase URL và anon key, hoặc cho phép tool lấy hai giá trị public này từ frontend.
- Nếu có tài liệu nội bộ: tên table/view/RPC/Storage bucket và policy dành cho crawler.
- Danh sách collection/test được phép lấy.
- Xác nhận crawler phải tuyệt đối read-only hay được phép tạo submission/progress bằng tài khoản crawl riêng.
- Quyền có bao gồm đáp án, giải thích, transcript, bản dịch và media hay không.
- Dữ liệu dùng cho mục đích cá nhân, nội bộ hay nhập vào sản phẩm khác.
- Định dạng đầu ra ưu tiên ngoài SQLite/JSON, nếu có.
- Có cần chạy một lần hay chạy cập nhật định kỳ.
