# Backend Entegrasyon Örnekleri ve Davranış Sözleşmeleri

Bu belge frontend geliştiricisinin mevcut backend ile entegrasyonunda kritik akışları, gerçek payload ve gözlenen backend davranışıyla açıklar. Buradaki davranışlar üretim kodu ve testlerle doğrulanmıştır; frontend kodu içermez.

Örneklerde kullanılan kimlikler:

```text
Alice:        11111111-1111-4111-8111-111111111111
Bob:          22222222-2222-4222-8222-222222222222
Conversation: 33333333-3333-4333-8333-333333333333
Message:      44444444-4444-4444-8444-444444444444
Client msg:   55555555-5555-4555-8555-555555555555
```

## Test kapsamı

Senaryolar migration uygulanmış gerçek PostgreSQL üzerinde `src/contracts/backend-contract.integration.test.ts` dosyasında doğrulanır.

| Senaryo | DB-backed sözleşme testi | Ek mevcut testler |
| --- | --- | --- |
| Reconnect ve yeniden abonelik | `requires a new conversation subscription after reconnect` | `src/realtime/server/chat.integration.test.ts` — subscribe/unsubscribe ve abone olmayan typing |
| Token expiry, refresh ve socket etkisi | `keeps an established socket connected after access-token expiry and accepts a refreshed token on a new handshake` | `src/modules/auth/tokens/access-token.service.test.ts`, `src/modules/auth/auth.routes.integration.test.ts` |
| Mesaj idempotent retry | `returns the original message with 200 and emits no second event for an idempotent retry` | `src/modules/messages/message.service.test.ts`, `src/modules/messages/message.repository.test.ts` |
| Mesaj düzenleme ve soft-delete | `edits and soft-deletes only for the sender while preserving a masked tombstone` | `src/modules/messages/message.service.test.ts`, `src/modules/messages/message.routes.integration.test.ts`, `src/modules/messages/message.repository.test.ts` |
| Cursor uç durumları | `returns null cursors for empty and final pages and a base64url JSON cursor between pages` | `src/modules/messages/message.service.test.ts`, `src/modules/conversations/conversation.service.test.ts`, `src/modules/users/users.service.test.ts` |
| Typing expiry | `does not emit typing false automatically when the five-second expiry passes` | `src/realtime/server/chat.integration.test.ts` |

DB testinin migration ve tekillik dayanakları: `prisma/migrations/20260821000000_initial_chat_schema/migration.sql`, `prisma/migrations/20260828074004_add_auth_session_user_agent/migration.sql`, `prisma/schema.prisma`.

## HTTP 429 işleme

Login, register ve refresh IP'ye; parola değiştirme, kullanıcı arama ve mesaj oluşturma ise
doğrulanmış kullanıcıya göre ayrı kotalar kullanır. Bir kotanın dolması diğer
endpoint'in kotasını tüketmez. Limit aşıldığında frontend yeni isteği
`Retry-After` başlığındaki saniye dolmadan otomatik tekrar etmemelidir.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
Content-Type: application/json
```

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests",
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

Kesin kotalar OpenAPI belgesindeki ilgili operasyonlarda yazılıdır. Kaynaklar:
`src/http/middleware/rate-limit.ts`, `src/http/middleware/error-handler.ts`,
`src/modules/auth/http/auth.routes.ts`, `src/modules/users/users.routes.ts`,
`src/modules/messages/message.routes.ts`; testler:
`src/modules/auth/auth.routes.integration.test.ts`,
`src/modules/users/users.routes.integration.test.ts`,
`src/modules/messages/message.routes.integration.test.ts`.

## A. Reconnect sonrası konuşmaya yeniden abone olma

### Kesin davranış

Konuşma odası üyeliği kullanıcıya/session'a değil, tek bir Socket.IO bağlantısına aittir. Bağlantı kapandığında o socket'in odaları da gider. Yeni socket yalnızca `user:<userId>` odasına otomatik katılır; önceki `conversation:<conversationId>` odaları geri yüklenmez. Backend hangi konuşmaların önceki socket'te açık olduğunu kalıcı olarak saklamaz. Bu yüzden her reconnect sonrasında frontend gerekli konuşmaları yeniden `conversation:subscribe` ile göndermelidir. Kaynaklar: `src/realtime/server/configure-chat-namespace.ts`, `src/realtime/rooms/room-names.ts`; test: `src/contracts/backend-contract.integration.test.ts`.

### Örnek akış

1. Access token ile `/chat` bağlantısını kur:

   ```ts
   const socket = io(`${apiBaseUrl}/chat`, {
     auth: { token: accessToken },
   });
   ```

2. Sunucu hazır event'ini gönderir:

   ```json
   {
     "userId": "11111111-1111-4111-8111-111111111111",
     "socketId": "2ZyV4gJ3n7c8AbCdAAAB",
     "serverTime": "2030-01-01T00:00:00.000Z"
   }
   ```

3. Frontend açık konuşmayı subscribe eder:

   ```ts
   socket.emit(
     "conversation:subscribe",
     { conversationId: "33333333-3333-4333-8333-333333333333" },
     (ack) => {
       // Başarı: { ok: true }
     },
   );
   ```

4. Bağlantı koptuktan sonra Socket.IO yeni bir socket oluşturur. Yeni socket `session:ready` alsa bile henüz konuşma odasında değildir. Bu aşamada gönderilen `typing:set` sessizce yok sayılır; odaya yayınlanan `message:created` ve `read:updated` event'leri de bu socket'e ulaşmaz.

5. Yeni bağlantıda tekrar subscribe et:

   ```json
   {
     "conversationId": "33333333-3333-4333-8333-333333333333"
   }
   ```

6. `{ "ok": true }` ack'inden sonra konuşma event'leri yeniden alınır. `FORBIDDEN` gelirse kullanıcı aktif üye değildir; `VALIDATION_ERROR` gelirse payload/UUID geçersizdir.

Kaynaklar: `src/realtime/server/chat-events.ts`, `src/realtime/server/configure-chat-namespace.ts`, `src/contracts/backend-contract.integration.test.ts`.

## B. Access token süresi dolduğunda refresh ve socket davranışı

### Kesin davranış

Access token TTL'i `ACCESS_TOKEN_TTL_MINUTES` ile belirlenir; ortam şeması varsayılanı 15 dakika, izin verilen aralık 1–60 dakikadır. JWT `exp` yalnızca doğrulama yapıldığı anda kontrol edilir. HTTP Bearer isteğinde her seferinde, Socket.IO'da ise yalnızca handshake sırasında doğrulama yapılır. Bağlı socket üzerinde expiry timer yoktur; token expire olduğunda aktif socket otomatik disconnect edilmez. Eski token ile yapılacak yeni handshake ise `connect_error` ile reddedilir. Kaynaklar: `src/config/env.ts`, `src/modules/auth/tokens/access-token.service.ts`, `src/realtime/auth/socket-auth.middleware.ts`, `src/realtime/server/configure-chat-namespace.ts`.

Register/login/refresh HTTP gövdeleri access token'ın sona erme zamanını dönmez; yalnızca `accessToken` döner. Frontend süreyi JWT `exp` claim'inden okuyabilir veya korumalı HTTP isteğinin `401` cevabında refresh akışını başlatabilir. Kaynak: `src/modules/auth/http/auth.controller.ts`.

### Örnek refresh akışı

1. Korumalı HTTP isteği geçersiz/expire token nedeniyle cevap verir:

   ```http
   HTTP/1.1 401 Unauthorized
   WWW-Authenticate: Bearer realm="chat-api"
   Content-Type: application/json
   ```

   ```json
   {
     "error": {
       "code": "INVALID_TOKEN",
       "message": "The token is invalid",
       "requestId": "77777777-7777-4777-8777-777777777777"
     }
   }
   ```

2. Browser'da refresh cookie'nin gönderilebilmesi için credentials ile refresh çağrısı yap:

   ```ts
   const response = await fetch(`${apiBaseUrl}/api/v1/auth/refresh`, {
     method: "POST",
     credentials: "include",
   });
   ```

   Production'da browser'ın `Origin` başlığı `FRONTEND_ORIGIN` ile eşleşmelidir. Cookie adı `chat_refresh_token`; `HttpOnly` olduğu için frontend JavaScript token değerini okuyamaz. Kaynaklar: `src/modules/auth/http/auth.middleware.ts`, `src/modules/auth/http/refresh-cookie.ts`, `src/modules/auth/http/auth.routes.ts`.

3. Başarılı cevap yeni access token'ı gövdede, döndürülmüş refresh token'ı yeni `Set-Cookie` başlığında verir:

   ```json
   {
     "accessToken": "example-rotated-access-token"
   }
   ```

4. Bekleyen HTTP isteğini yeni Bearer token ile bir kez tekrar et.

5. Zaten bağlı socket eski kimlikle bağlı kalır; sunucu ona yeni token enjekte etmez ve otomatik disconnect/reconnect yapmaz. Frontend socket kimliğini güncel access token ile hizalamak istiyorsa kontrollü yeniden bağlantı yapmalıdır:

   ```ts
   socket.auth = { token: newAccessToken };
   socket.disconnect().connect();
   ```

6. Yeni handshake'ten sonra `session:ready` bekle ve A senaryosundaki gibi konuşmaları yeniden subscribe et.

Refresh token geçersizse cevap `401 INVALID_REFRESH_TOKEN`'dır. Aynı refresh token ile eşzamanlı iki rotasyondan yalnızca biri başarılı olur; diğeri `401` alır. Kaynaklar: `src/modules/auth/sessions/auth-session.service.ts`, `src/modules/auth/sessions/auth-session.repository.ts`; testler: `src/modules/auth/sessions/auth-session.service.test.ts`, `src/contracts/backend-contract.integration.test.ts`.

## B.1. Profil, parola ve session yönetimi

Profil güncelleme `PATCH /api/v1/users/me` ile yapılır. Gövdede `username` ve/veya `displayName` bulunmalıdır; boş gövde `400 VALIDATION_ERROR`, kullanılan bir username ise `409 USERNAME_ALREADY_IN_USE` döndürür.

```http
PATCH /api/v1/users/me HTTP/1.1
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "username": "alice-new",
  "displayName": "Alice New"
}
```

Aktif session'lar `GET /api/v1/auth/sessions` ile listelenir. Her öğede `id`, nullable `userAgent`, `createdAt`, `lastUsedAt`, `expiresAt` ve `isCurrent` vardır. IP tutulmaz. `userAgent` ham ve istemci tarafından bildirilen bir değerdir; güvenilir cihaz kimliği değildir. Session oluşturulurken `User-Agent` yoksa veya session migration öncesinden geliyorsa null olabilir. `lastUsedAt` şu anda session oluşturma ve başarılı refresh rotasyonunda güncellenir; her HTTP isteğinin son görülme zamanı değildir.

Parola değiştirme:

```http
PATCH /api/v1/auth/password HTTP/1.1
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "currentPassword": "old-password-value",
  "newPassword": "new-password-value"
}
```

Yeni parola register ile aynı `12..128` karakter kuralını kullanır ve mevcut paroladan farklı olmalıdır. Başarı `204` döndürür; mevcut session açık kalır, diğer session'lar iptal edilir. Endpoint kullanıcı başına `10/15 dakika` sınırındadır.

Belirli bir session `DELETE /api/v1/auth/sessions/{sessionId}`, mevcut dışındaki tüm session'lar `DELETE /api/v1/auth/sessions` ile iptal edilir. Hedef mevcut session ise refresh cookie de temizlenir. İptal edilen session için davranış üç katmanlı ve anlıktır:

- Refresh token artık kullanılamaz.
- Açık socket önce payload'sız `auth:revoked` alır, sonra sunucu tarafından kapanır.
- Access JWT'nin imza/`exp` süresi henüz geçerli olsa bile her korumalı HTTP isteği token'daki `sid` + `sub` çiftini aktif DB session'ına karşı kontrol ettiği için sonraki istek `401 INVALID_TOKEN` döner.

Dolayısıyla frontend "JWT doğal süresi dolana kadar HTTP çalışır" varsayımını kullanmamalıdır. `auth:revoked` alındığında yerel access token temizlenmeli ve yeniden giriş akışı başlatılmalıdır. Kaynaklar: `src/modules/auth/application/auth.service.ts`, `src/modules/auth/sessions/auth-session.repository.ts`, `src/realtime/auth/session-revocation-publisher.ts`; gerçek PostgreSQL testi: `src/modules/auth/persistence/auth.postgres.integration.test.ts`; socket testi: `src/realtime/server/chat.integration.test.ts`.

## B.2. Avatar yükleme

Avatar, API'ye multipart/base64 olarak gönderilmez. Akış üç adımdır: backend'den private upload adresi al, dosyayı doğrudan object storage'a `PUT` et, backend'e complete çağrısı yap. Upload intent ve complete çağrıları kullanıcı başına ortak `20/15 dakika` kotasını tüketir.

1. Dosyanın MIME türü ve byte boyutuyla upload intent oluştur:

   ```http
   POST /api/v1/users/me/avatar/uploads HTTP/1.1
   Authorization: Bearer <access-token>
   Content-Type: application/json

   {
     "contentType": "image/jpeg",
     "contentLength": 245760
   }
   ```

2. Cevaptaki `upload.url`, `upload.method` ve `upload.headers` değerlerini aynen kullan. Özellikle `Content-Type` imzaya dahildir; intent'te `image/jpeg` denmişse PUT sırasında başka bir değer göndermek imzayı geçersiz kılar.

   ```ts
   const intent = await createAvatarUploadIntent(file.type, file.size);

   await fetch(intent.upload.url, {
     method: intent.upload.method,
     headers: intent.upload.headers,
     body: file,
   });
   ```

   İmzalı adres 10 dakika geçerlidir. `incoming/` nesnesi public okunamaz; yalnızca tamamlanmış `public/` WebP nesnesi anonim okunabilir.

3. PUT başarılı olduktan sonra aynı `uploadId` ile complete çağır:

   ```http
   POST /api/v1/users/me/avatar/uploads/22222222-2222-4222-8222-222222222222/complete HTTP/1.1
   Authorization: Bearer <access-token>
   ```

Backend gerçek nesne boyutunu, MIME türünü ve çözümlenen görseli yeniden doğrular. Kaynak en fazla 5 MiB ve 4096×4096 olabilir. Başarılı görsel metadata'sı çıkarılarak merkezden kırpılmış sabit 512×512 WebP'ye dönüştürülür; cevap güncel `user.avatarUrl` değerini içerir. Aynı güncel upload'ın complete retry'ı idempotenttir.

Desteklenen kaynaklar yalnızca JPEG, PNG ve WebP'dir. HEIC/HEIF özellikle Faz 14a MVP'sinde desteklenmez. iPhone galerisinden seçilen dosya HEIC ise frontend dosyayı istemci tarafında JPEG/WebP'ye dönüştürmeli veya kullanıcıya açık bir hata göstermelidir. Dönüştürmeden `image/heic` intent'i istenirse backend şu cevabı verir:

```json
{
  "error": {
    "code": "UNSUPPORTED_AVATAR_FORMAT",
    "message": "Avatar format is not supported; use JPEG, PNG, or WebP",
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

SVG, GIF ve video da reddedilir.

### Avatar hata sözleşmesi

Faz 14a'daki gerçek hata adları aşağıdaki gibidir; `410 UPLOAD_EXPIRED`, `413 UPLOAD_TOO_LARGE` veya `422 UNSUPPORTED_IMAGE` kullanılmaz.

| Durum | HTTP | `error.code` | Frontend davranışı |
| --- | ---: | --- | --- |
| Upload süresi doldu | 409 | `AVATAR_UPLOAD_EXPIRED` | Yeni upload intent oluştur |
| Upload iptal edildi, başka durumda veya artık tamamlanamaz | 409 | `AVATAR_UPLOAD_CONFLICT` | Eski `uploadId`'yi bırakıp yeni intent oluştur |
| PUT nesnesi henüz storage'da yok | 409 | `AVATAR_UPLOAD_INCOMPLETE` | PUT sonucunu kontrol et; kısa/geçici yarışta complete'i aynı ID ile tekrar deneyebilirsin |
| HEAD/GET sırasında gerçek nesne 5 MiB üstünde, bildirilen boyut/MIME ile farklı veya decode edilemiyor | 422 | `INVALID_AVATAR_FILE` | Dosyayı düzelt/dönüştür ve yeni intent oluştur |
| Intent sırasında desteklenmeyen MIME (`image/heic`, SVG, GIF vb.) | 400 | `UNSUPPORTED_AVATAR_FORMAT` | JPEG/PNG/WebP seç veya istemcide dönüştür |
| Backend imzalı URL üretemedi ya da storage okuma/yazma geçici olarak başarısız | 503 | `AVATAR_STORAGE_UNAVAILABLE` | Gecikmeli retry göster |

Süresi dolmuş upload:

```json
{
  "error": {
    "code": "AVATAR_UPLOAD_EXPIRED",
    "message": "The avatar upload has expired",
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

İptal edilmiş veya geçersiz durumdaki upload:

```json
{
  "error": {
    "code": "AVATAR_UPLOAD_CONFLICT",
    "message": "The avatar upload cannot be completed",
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

PUT nesnesi bulunamadığında:

```json
{
  "error": {
    "code": "AVATAR_UPLOAD_INCOMPLETE",
    "message": "The avatar upload has not completed",
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

Boyut/MIME uyuşmazlığı, 5 MiB üstü gerçek nesne veya decode hatası:

```json
{
  "error": {
    "code": "INVALID_AVATAR_FILE",
    "message": "The uploaded file is not a valid supported avatar image",
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

Backend storage'a erişemediğinde:

```json
{
  "error": {
    "code": "AVATAR_STORAGE_UNAVAILABLE",
    "message": "Avatar storage is temporarily unavailable",
    "requestId": "77777777-7777-4777-8777-777777777777"
  }
}
```

İmzalı PUT sırasında yanlış `Content-Type`, süresi geçmiş URL veya bozuk imza kullanılırsa cevap backend API'den değil doğrudan MinIO/S3/R2'den gelir. Bu durumda genel HTTP sonucu `403`'tür; provider'a göre JSON/XML gövdesi değişebildiğinden taşınabilir bir backend `error.code` değeri yoktur. Frontend PUT `2xx` dönmeden complete çağırmamalıdır. Başarısız PUT'tan sonra yine de complete çağrılır ve nesne oluşmamışsa backend `409 AVATAR_UPLOAD_INCOMPLETE` döndürür.

Avatarı kaldırmak için `DELETE /api/v1/users/me/avatar` kullanılır. Profil referansı hemen temizlenir; eski avatar ve yarım upload nesneleri request sırasında senkron silinmez. Sunucudaki 15 dakikalık periyodik temizlik, bir saatten eski pending/rejected/cancelled kayıtları ve artık hiçbir kullanıcı tarafından referans verilmeyen avatarları kaldırır. Bu nedenle değiştirme/silme cevabından kısa bir süre sonra eski public URL geçici olarak çalışabilir. Public avatar çıktısının cache politikası `public, max-age=86400` olduğundan frontend eski URL'nin anında erişilemez olmasına güvenmemelidir; her yeni avatar benzersiz bir URL alır.

Swagger ilk ve üçüncü API çağrılarını çalıştırabilir. Aradaki imzalı object-storage PUT isteği dinamik ve harici bir URL olduğu için Swagger operasyonu değildir; cevaptaki URL/header'lar kopyalanarak Thunder Client/curl ile veya frontend kodundan gönderilir. Yerelde MinIO ve iki bucket `npm run setup:local` ile hazırlanır; yalnızca storage'ı yeniden hazırlamak için `npm run setup:storage` kullanılabilir.

Kaynaklar: `src/modules/media/avatar.service.ts`, `src/modules/media/avatar-image.processor.ts`, `src/modules/media/avatar-cleanup.service.ts`, `src/infrastructure/storage/`; gerçek PostgreSQL testi: `src/modules/media/avatar.postgres.integration.test.ts`.

## B2. Mesaj görseli upload, bağlama, erişim ve retention

Mesaj görseli ve PDF API'ye base64/multipart taşınmaz. Aktif conversation üyesi önce
private upload intent alır, dönen başlıklarla object storage'a PUT yapar ve
complete çağırır:

```http
POST /api/v1/conversations/33333333-3333-4333-8333-333333333333/attachments/uploads
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "contentType": "image/png",
  "contentLength": 245760,
  "originalFileName": "holiday.png"
}
```

```json
{
  "attachmentId": "66666666-6666-4666-8666-666666666666",
  "upload": {
    "url": "<private-presigned-put>",
    "method": "PUT",
    "headers": { "Content-Type": "image/png" },
    "expiresAt": "2030-01-01T00:10:00.000Z"
  }
}
```

PUT başarılı olduktan sonra
`POST .../attachments/66666666-6666-4666-8666-666666666666/complete`
çağrılır. Backend JPEG/PNG/WebP kaynağı, 10 MiB, 8192×8192 ve Sharp toplam-piksel
sınırlarıyla doğrular; metadata'yı temizleyip crop yapmadan private WebP asıl
(uzun kenar en fazla 4096) ve thumbnail (uzun kenar en fazla 480) üretir.

PDF intent'i aynı endpoint'e `contentType: "application/pdf"` ile gönderilir ve
dosya başına sınır 25 MiB'dir. Complete sırası magic-byte doğrulaması, PDF.js ile
parse/şifre kontrolü ve ClamAV `INSTREAM` taramasıdır. Temiz PDF byte'ları
değiştirilmeden private ready object'e alınır; thumbnail üretilmez. Şifreli,
bozuk veya malware bulunan PDF kalıcı `REJECTED` olur. Scanner timeout veya
ulaşılamama hatası `503 ATTACHMENT_SCAN_UNAVAILABLE` döndürür, asset `PENDING`
durumuna alınır ve upload süresi geçerliyse complete yeniden denenebilir.

Hazır attachment, aynı conversation için MEDIA mesaja atomik bağlanır:

```http
POST /api/v1/conversations/33333333-3333-4333-8333-333333333333/messages
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "clientMessageId": "55555555-5555-4555-8555-555555555555",
  "content": {
    "type": "media",
    "text": "Tatil",
    "attachmentIds": ["66666666-6666-4666-8666-666666666666"]
  }
}
```

Bir MEDIA mesajı 1-4 tekrarsız IMAGE/PDF attachment ister; türler aynı mesajda
karıştırılabilir. Binding transaction'ı doğrulanmış `actualSize` toplamını kontrol
eder ve 50 MiB üstünü `MESSAGE_ATTACHMENTS_TOTAL_SIZE_EXCEEDED` ile reddeder.
Caption opsiyoneldir; varsa
1-4000 karakterdir. Sonradan yalnızca caption değiştirilebilir:

```json
{ "content": { "type": "media", "text": null } }
```

`attachmentIds` PATCH gövdesinde kabul edilmez ve `400 VALIDATION_ERROR` döner.
Görseli değiştirmek için mesaj silinip yeniden gönderilir.

Message içindeki `url` / IMAGE için `thumbnailUrl` backend yollarıdır. İstemci bunları Bearer
token ile çağırır; backend üyeliği ve canlı mesajı doğrulayıp `307` ile 60-120
saniyelik private GET'e yönlendirir. Presigned URL cache'e veya kalıcı state'e
yazılmamalıdır. PDF yalnızca `original` variant ile `Content-Disposition:
attachment` olarak indirilir; dosya adı GET anında sanitize edilip ASCII
`filename` ve RFC 5987 `filename*` parametreleriyle imzalanır. Silinen MEDIA
mesajı `attachments: []` olur ve GET anında 404
döner; nesneler request sırasında silinmez. Soft-delete eki 30 gün, READY ama
bağlanmamış ek 24 saat, süresi dolmuş PENDING/REJECTED/CANCELLED ek ise bir
saatlik güvenlik aralığından sonra mevcut media cleanup worker'ında temizlenir.
Süreler env ile değiştirilebilir.

Format ve lifecycle hata kodları: `UNSUPPORTED_ATTACHMENT_FORMAT`,
`ATTACHMENT_UPLOAD_NOT_FOUND`, `ATTACHMENT_UPLOAD_EXPIRED`,
`ATTACHMENT_UPLOAD_INCOMPLETE`, `ATTACHMENT_UPLOAD_CONFLICT`,
`INVALID_ATTACHMENT_FILE`, `KIND_MISMATCH`, `ATTACHMENT_STORAGE_UNAVAILABLE`,
`ATTACHMENT_SCAN_UNAVAILABLE`, `ATTACHMENT_BINDING_CONFLICT`,
`MESSAGE_ATTACHMENTS_TOTAL_SIZE_EXCEEDED` ve erişimde `ATTACHMENT_NOT_FOUND`.

Upload intent'ten sonra kullanıcı gruptan çıkarılırsa PUT imzası tekil olarak
geri alınamadığı için süresi dolana kadar storage'a yazabilir. Complete ve binding
404 ile reddedilir; artık incoming nesnesi cleanup worker'a bırakılır.

## C. `POST .../messages` idempotent retry

### Kesin davranış

Mesaj tekillik anahtarı `(senderId, clientMessageId)` çiftidir. `conversationId` bu anahtarın parçası değildir; aynı kullanıcı bir `clientMessageId` değerini başka bir konuşmada da yeniden kullanmamalıdır. Repository önce var olan mesajı arar, eşzamanlı insert yarışında PostgreSQL `P2002` çakışmasından sonra aynı mesajı tekrar yükler. Kaynaklar: `prisma/schema.prisma`, `prisma/migrations/20260821000000_initial_chat_schema/migration.sql`, `src/modules/messages/message.repository.ts`.

İlk create `201` ve yeni Message gövdesi döndürür; commit'ten sonra bir kez `message:created` yayınlanır. Retry aynı Message gövdesini `200` ile döndürür; yeni satır ve ikinci event üretilmez. HTTP gövdesinde `created` alanı bulunmaz; yeni/tekrar ayrımı status code ile yapılır. Kaynaklar: `src/modules/messages/message.controller.ts`, `src/modules/messages/message.service.ts`; DB-backed test: `src/contracts/backend-contract.integration.test.ts`.

### Örnek akış

1. Frontend gönder düğmesine basıldığında UUID üretir ve retry boyunca aynı değeri korur:

   ```http
   POST /api/v1/conversations/33333333-3333-4333-8333-333333333333/messages
   Authorization: Bearer <access-token>
   Content-Type: application/json
   ```

   ```json
   {
     "clientMessageId": "55555555-5555-4555-8555-555555555555",
     "content": {
       "type": "text",
       "text": "Merhaba"
     }
   }
   ```

2. İlk başarı:

   ```http
   HTTP/1.1 201 Created
   ```

   ```json
   {
     "id": "44444444-4444-4444-8444-444444444444",
     "conversationId": "33333333-3333-4333-8333-333333333333",
     "senderId": "11111111-1111-4111-8111-111111111111",
     "clientMessageId": "55555555-5555-4555-8555-555555555555",
     "kind": "TEXT",
     "body": "Merhaba",
     "createdAt": "2030-01-01T00:00:00.000Z",
    "editedAt": null,
    "deletedAt": null
   }
   ```

3. Ağ hatası yüzünden frontend cevabı göremezse aynı URL, aynı kullanıcı ve aynı `clientMessageId` ile isteği tekrarlar.

4. Retry cevabı:

   ```http
   HTTP/1.1 200 OK
   ```

   Gövde ilk mesajın aynı `id`, `body` ve zaman değerlerini taşır. Retry payload'ında aynı idempotency anahtarıyla farklı text gönderilse bile repository var olan mesajı döndürür; `clientMessageId` farklı bir mantıksal mesaj için yeniden kullanılmamalıdır. Kaynak: `src/modules/messages/message.repository.ts`.

Silinmiş mesaj için aynı `clientMessageId` ile create retry yapılırsa mesaj yeniden oluşturulmaz veya diriltilmez. `200` ile mevcut tombstone (`body: null`, dolu `deletedAt`) döner ve `message:created` yayınlanmaz. Kaynaklar: `src/modules/messages/message.service.ts`, `src/modules/messages/message.repository.ts`; DB-backed test: `src/contracts/backend-contract.integration.test.ts`.

## C2. Mesaj düzenleme ve soft-delete

### Kesin davranış

- Yalnızca mesajı gönderen kullanıcı düzenleyebilir veya silebilir; süre sınırı yoktur.
- Aktif conversation üyesi olmayan kullanıcı `404 CONVERSATION_NOT_FOUND`; üye olup gönderen olmayan kullanıcı `404 MESSAGE_NOT_FOUND` alır. Böylece mutation cevabı varlık/yetki ayrıntısı sızdırmaz.
- Düzenleme body’si create ile aynı şekilde trim edilir ve 1–4000 karakter olmalıdır. Normalize edilmiş içerik aynıysa `200` no-op döner; `editedAt` ve socket event'i değişmez.
- Soft-delete fiziksel satırı ve DB body’sini korur. HTTP/history/socket DTO’sunda `body: null`, `deletedAt: <ISO timestamp>` görünür.
- Silinen mesaj history ve cursor sırasında kalır. Conversation sırası, `lastMessageAt`, read watermark ve unread sırası geriye gitmez.
- Conversation listesindeki silinmiş `lastMessage` de listede kalır; `body: null` ve dolu `deletedAt` döner.
- Tekrarlanan silme `200` ile aynı tombstone'u döndürür; `deletedAt` değişmez ve ikinci `message:deleted` yayınlanmaz.

Kaynaklar: `prisma/schema.prisma`, `src/modules/messages/message.schema.ts`, `src/modules/messages/message.repository.ts`, `src/modules/messages/message.service.ts`, `src/modules/messages/message.errors.ts`, `src/modules/conversations/conversation.repository.ts`; DB-backed test: `src/contracts/backend-contract.integration.test.ts`.

### Düzenleme akışı

```http
PATCH /api/v1/conversations/33333333-3333-4333-8333-333333333333/messages/44444444-4444-4444-8444-444444444444
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "content": {
    "type": "text",
    "text": "Düzenlenmiş mesaj"
  }
}
```

Başarılı cevap `200 OK`:

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "conversationId": "33333333-3333-4333-8333-333333333333",
  "senderId": "11111111-1111-4111-8111-111111111111",
  "clientMessageId": "55555555-5555-4555-8555-555555555555",
  "kind": "TEXT",
  "body": "Düzenlenmiş mesaj",
  "createdAt": "2030-01-01T00:00:00.000Z",
  "editedAt": "2030-01-01T00:03:00.000Z",
  "deletedAt": null
}
```

İçerik gerçekten değiştiyse commit sonrasında odadaki gönderen dahil tüm socket'ler aynı Message nesnesini `{ "message": ... }` zarfında `message:updated` ile alır. Frontend mesajı `id` üzerinden yerinde güncellemelidir. Kaynaklar: `src/realtime/messages/message-publisher.ts`, `src/realtime/server/chat-events.ts`.

### Silme akışı

```http
DELETE /api/v1/conversations/33333333-3333-4333-8333-333333333333/messages/44444444-4444-4444-8444-444444444444
Authorization: Bearer <access-token>
```

Başarılı ve tekrarlanan idempotent cevap `200 OK`:

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "conversationId": "33333333-3333-4333-8333-333333333333",
  "senderId": "11111111-1111-4111-8111-111111111111",
  "clientMessageId": "55555555-5555-4555-8555-555555555555",
  "kind": "TEXT",
  "body": null,
  "createdAt": "2030-01-01T00:00:00.000Z",
  "editedAt": "2030-01-01T00:03:00.000Z",
  "deletedAt": "2030-01-01T00:05:00.000Z"
}
```

İlk silmede aynı tombstone `{ "message": ... }` zarfıyla `message:deleted` olarak gelir. Frontend mesajı diziden çıkarmamalı; içeriği yerel bir “silindi” sunumuyla değiştirmeli ve cursor'ı yeniden üretmemelidir. Kaynaklar: `src/modules/messages/message.service.ts`, `src/realtime/messages/message-publisher.ts`, `src/contracts/backend-contract.integration.test.ts`.

## D. Cursor pagination uç durumları

### Ortak sözleşme

Üç liste endpoint'i cursor kullanır:

| Endpoint | Cursor parametresi | Varsayılan / maksimum limit | Sıralama ve cursor içeriği |
| --- | --- | --- | --- |
| `GET /api/v1/users` | `cursor` | 20 / 50 | `username ASC, id ASC`; `{v:1, username, id}` |
| `GET /api/v1/conversations` | `cursor` | 20 / 50 | `lastMessageAt DESC NULLS LAST, createdAt DESC, id DESC`; `{v:1, lastMessageAt, createdAt, id}` |
| `GET /api/v1/conversations/:id/messages` | `before` | 50 / 100 | DB'de `createdAt DESC, id DESC`, cevap sayfasında kronolojik; `{v:1, createdAt, id}` |

Kaynaklar: `src/modules/users/users.schema.ts`, `src/modules/users/users.repository.ts`, `src/modules/users/users.service.ts`, `src/modules/conversations/conversation.schema.ts`, `src/modules/conversations/conversation.repository.ts`, `src/modules/conversations/conversation.service.ts`, `src/modules/messages/message.schema.ts`, `src/modules/messages/message.repository.ts`, `src/modules/messages/message.service.ts`.

Cursor `Buffer.from(JSON.stringify(payload)).toString("base64url")` ile üretilir. Yani teknik olarak decode edilebilir sürümlü JSON'dur; fakat imzalı/şifreli değildir ve public sözleşmede opak kabul edilmelidir. Frontend cursor içeriğine iş kuralı bağlamamalı, değiştirmemeli ve üretmemelidir. Kaynak: `src/shared/pagination/cursor.ts`.

### Mesaj geçmişi örneği

1. İlk sayfa:

   ```http
   GET /api/v1/conversations/33333333-3333-4333-8333-333333333333/messages?limit=2
   Authorization: Bearer <access-token>
   ```

2. Daha eski kayıt varsa cevapta string cursor gelir:

   ```json
   {
     "items": [
       {
         "id": "44444444-4444-4444-8444-444444444443",
         "conversationId": "33333333-3333-4333-8333-333333333333",
         "senderId": "11111111-1111-4111-8111-111111111111",
         "clientMessageId": "55555555-5555-4555-8555-555555555553",
         "kind": "TEXT",
         "body": "Önceki mesaj",
         "createdAt": "2029-12-31T23:59:59.000Z",
         "editedAt": null,
         "deletedAt": null
       },
       {
         "id": "44444444-4444-4444-8444-444444444444",
         "conversationId": "33333333-3333-4333-8333-333333333333",
         "senderId": "11111111-1111-4111-8111-111111111111",
         "clientMessageId": "55555555-5555-4555-8555-555555555555",
         "kind": "TEXT",
         "body": "Son mesaj",
         "createdAt": "2030-01-01T00:00:00.000Z",
         "editedAt": null,
         "deletedAt": null
       }
     ],
    "nextCursor": "eyJ2IjoxLCJjcmVhdGVkQXQiOiIyMDI5LTEyLTMxVDIzOjU5OjU5LjAwMFoiLCJpZCI6IjQ0NDQ0NDQ0LTQ0NDQtNDQ0NC04NDQ0LTQ0NDQ0NDQ0NDQ0MyJ9"
   }
   ```

   Cursor sayfadaki en eski kayıt olan `...4443` mesajının `createdAt` + `id` değerlerinden üretilmiştir. Frontend her zaman backend'in döndürdüğü değeri aynen kullanmalıdır.

3. Sonraki sayfa:

   ```http
   GET /api/v1/conversations/33333333-3333-4333-8333-333333333333/messages?limit=2&before=<nextCursor>
   ```

4. Son sayfada `nextCursor` null'dır:

   ```json
   {
     "items": [
       {
         "id": "44444444-4444-4444-8444-444444444442",
         "conversationId": "33333333-3333-4333-8333-333333333333",
         "senderId": "22222222-2222-4222-8222-222222222222",
         "clientMessageId": "55555555-5555-4555-8555-555555555552",
         "kind": "TEXT",
         "body": "İlk mesaj",
         "createdAt": "2029-12-31T23:59:58.000Z",
         "editedAt": null,
         "deletedAt": null
       }
     ],
     "nextCursor": null
   }
   ```

5. Boş konuşma veya cursor ötesinde kayıt olmayan sayfa:

   ```json
   {
     "items": [],
     "nextCursor": null
   }
   ```

`nextCursor: null` tekrar query parametresi olarak gönderilmemelidir; parametre tamamen çıkarılmalıdır. Geçersiz base64url, JSON, cursor sürümü veya alanları `400 VALIDATION_ERROR` üretir ve issue yolu mesaj geçmişinde `query.before`, kullanıcı/konuşma listesinde `query.cursor` olur. Kaynaklar: ilgili `*.schema.ts` dosyaları ve `src/http/validation/request-validation.ts`; DB-backed test: `src/contracts/backend-contract.integration.test.ts`.

## E. `typing:set` expiry

### Kesin davranış

Sunucu, abone bir socket'ten geçerli `typing:set` alınca diğer abonelere tek bir volatile `typing:updated` gönderir. `expiresAt`, event'in işlendiği sunucu saatine tam 5.000 ms eklenerek hesaplanır. Sunucu timer saklamaz; beş saniye sonra otomatik `isTyping:false` yayınlamaz. Kaynak: `src/realtime/server/configure-chat-namespace.ts`; testler: `src/realtime/server/chat.integration.test.ts`, `src/contracts/backend-contract.integration.test.ts`.

Ek flood-control sözleşmesi: aynı socket'ten kayan 5 saniyelik pencerede ilk
20 `typing:set` kabul edilir; sınırı aşan event'ler ack/hata/disconnect olmadan
sessizce düşürülür. Geçersiz veya konuşma odasına abone olmayan event'ler de
kontrol payload doğrulamasından önce yapıldığı için kotayı tüketir. Frontend bu
event'i her tuş vuruşunda değil, `expiresAt` süresini yenilemeye yetecek aralıkla
göndermelidir. Kaynaklar:
`src/realtime/rate-limit/socket-event-rate-limiter.ts`,
`src/realtime/server/configure-chat-namespace.ts`; test:
`src/realtime/server/chat.integration.test.ts`.

### Örnek akış

1. Alice konuşmaya subscribe olduktan sonra yazmaya başlar:

   ```json
   {
     "conversationId": "33333333-3333-4333-8333-333333333333",
     "isTyping": true
   }
   ```

2. Bob aşağıdaki event'i alır; Alice'e echo edilmez:

   ```json
   {
     "conversationId": "33333333-3333-4333-8333-333333333333",
     "userId": "11111111-1111-4111-8111-111111111111",
     "isTyping": true,
     "expiresAt": "2030-01-01T00:00:05.000Z"
   }
   ```

3. Bob'un frontend'i `expiresAt` için yerel timer kurar. Alice'ten yeni typing event'i gelirse timer yeni `expiresAt` ile değiştirilir.

4. Beş saniye boyunca yeni event gelmezse Bob göstergeyi yerel olarak kapatır. Backend'den otomatik false beklenmez.

5. Alice yazmayı daha erken bitirirse açıkça false gönderir:

   ```json
   {
     "conversationId": "33333333-3333-4333-8333-333333333333",
     "isTyping": false
   }
   ```

6. Bob bu kez yine beş saniyelik `expiresAt` alanı taşıyan, fakat `isTyping:false` olan anlık `typing:updated` alır. Kod her iki boolean değeri aynı event şemasıyla iletir. Kaynak: `src/realtime/server/configure-chat-namespace.ts`.

## GROUP akışı: oluşturma → üye ekleme → rol → sahiplik → ayrılma

Alice, Bob ve Carol ile grup oluşturur. `userIds` oluşturan Alice'i içermez:

```http
POST /api/v1/conversations/group
Authorization: Bearer <alice-access-token>
Content-Type: application/json

{
  "title": "Ürün ekibi",
  "userIds": [
    "22222222-2222-4222-8222-222222222222",
    "66666666-6666-4666-8666-666666666666"
  ]
}
```

`201` cevabında Alice `OWNER`, diğer iki kullanıcı `MEMBER` olur:

```json
{
  "id": "33333333-3333-4333-8333-333333333333",
  "type": "GROUP",
  "title": "Ürün ekibi",
  "createdAt": "2030-01-01T00:00:00.000Z",
  "members": [
    {
      "userId": "11111111-1111-4111-8111-111111111111",
      "role": "OWNER",
      "joinedAt": "2030-01-01T00:00:00.000Z",
      "user": { "id": "11111111-1111-4111-8111-111111111111", "username": "alice", "displayName": "Alice", "avatarUrl": null }
    }
  ]
}
```

Alice veya bir ADMIN yeni üyeyi ekler. Ayrılmış bir kullanıcıysa mevcut composite-PK satırının `leftAt` alanı temizlenir:

```http
POST /api/v1/conversations/33333333-3333-4333-8333-333333333333/members
Authorization: Bearer <alice-access-token>
Content-Type: application/json

{ "userId": "77777777-7777-4777-8777-777777777777" }
```

Zaten aktif üyede veya 100 aktif üye sınırında `409 CONFLICT` döner. Grup/aktif aktör üyeliği yoksa `404 CONVERSATION_NOT_FOUND`; aktif MEMBER yönetim işlemi denerse `403 INSUFFICIENT_ROLE` döner.

Yalnız OWNER, hedef MEMBER'ı ADMIN yapar:

```http
PATCH /api/v1/conversations/33333333-3333-4333-8333-333333333333/members/22222222-2222-4222-8222-222222222222
Authorization: Bearer <alice-access-token>
Content-Type: application/json

{ "role": "ADMIN" }
```

OWNER sahipliği Bob'a devreder:

```http
PUT /api/v1/conversations/33333333-3333-4333-8333-333333333333/owner
Authorization: Bearer <alice-access-token>
Content-Type: application/json

{ "userId": "22222222-2222-4222-8222-222222222222" }
```

`200` cevabında Bob `OWNER`, Alice otomatik `ADMIN` olur. OWNER doğrudan rol değiştirme veya çıkarma endpoint'inin hedefi olamaz; önce bu devir yapılmalıdır, aksi halde `409 CONFLICT` ve `Ownership must be transferred first` mesajı alınır.

Alice daha sonra kendi üyeliğini sonlandırır:

```http
DELETE /api/v1/conversations/33333333-3333-4333-8333-333333333333/members/me
Authorization: Bearer <alice-access-token>
```

Cevap `204` olur; Alice'in tüm socket'leri conversation odasından sunucu tarafında çıkarılır. `DELETE .../members/{userId}` üzerinde çağıranın kendi kimliğini kullanmak `400 INVALID_OPERATION` üretir ve `/members/me` yolunu işaret eder.

Mesaj ve okundu endpoint'leri GROUP için değişmez. Aktif grup üyesi aynı `/messages` ve `/read` yollarını kullanır; mesaj düzenleme/soft-delete yine yalnızca mesajın göndericisine açıktır, ADMIN veya OWNER başka bir kullanıcının mesajını değiştiremez.

## Bildirim realtime senkronizasyonu

Bob'un bütün açık socket'leri bağlantı kurulurken otomatik olarak `user:<bobUserId>` odasına katılır. Alice'in mesajı ve Bob için oluşturulan notification aynı DB transaction'ında commit edildikten sonra Bob'un cihazları şu event'i alır:

```json
{
  "id": "88888888-8888-4888-8888-888888888888",
  "type": "MESSAGE_CREATED",
  "conversationId": "33333333-3333-4333-8333-333333333333",
  "messageId": "44444444-4444-4444-8444-444444444444",
  "createdAt": "2030-01-01T00:00:00.000Z"
}
```

Event adı `notification:created`'dır. Payload önizleme metni taşımaz; istemci bildirim merkezini HTTP listesinden güncelleyebilir.

Bob bir cihazda `PATCH /api/v1/notifications/{id}/read` çağırdığında diğer cihazları `notification:read` alır:

```json
{
  "id": "88888888-8888-4888-8888-888888888888",
  "readAt": "2030-01-01T00:01:00.000Z"
}
```

`PATCH /api/v1/conversations/{conversationId}/notifications/read` sonrasında `notifications:read` yayınlanır:

```json
{
  "conversationId": "33333333-3333-4333-8333-333333333333",
  "markedCount": 4
}
```

Tekil ve toplu okuma event'leri yalnızca bildirim yaşam döngüsünü senkronize eder; mesaj read watermark'ını ilerletmez. Socket yayını başarısız olsa bile HTTP işlemi başarılı kalır ve doğruluk kaynağı bildirim API'sidir. Notification event'leri user-room üzerinden geldiğinden reconnect sonrasında ayrıca notification subscribe çağrısı gerekmez.

## Kod-esaslı önemli sonuçlar

- Başarısız Socket.IO auth bir `disconnect` reason üretmez; bağlantı hiç kurulmadığı için istemci `connect_error` alır. Hata `message = "Authentication failed"`, `data.code = "INVALID_TOKEN"` biçimindedir. Kaynak: `src/realtime/auth/socket-auth.middleware.ts`.
- Access token expire olduğunda mevcut socket otomatik düşmez. Kaynak: `src/realtime/server/configure-chat-namespace.ts` içinde expiry/re-auth timer bulunmaması ve DB-backed sözleşme testi.
- Typing expiry sunucunun otomatik false yayınlaması değil, frontend'in uygulayacağı son kullanma zamanıdır. Kaynak: `src/realtime/server/configure-chat-namespace.ts`.
- Mesaj retry başarısı `201` değil `200` döner ve gövdede `created` bayrağı yoktur. Kaynak: `src/modules/messages/message.controller.ts`.
- Cursor kodlanmıştır ama şifreli veya imzalı değildir; yine de istemci için opak tutulmalıdır. Kaynak: `src/shared/pagination/cursor.ts`.
