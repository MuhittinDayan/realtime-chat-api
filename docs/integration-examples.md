# Backend Entegrasyon Örnekleri ve Davranış Sözleşmeleri

Bu belge frontend geliştiricisinin mevcut backend ile entegrasyonunda kritik olan beş akışı, gerçek payload ve gözlenen backend davranışıyla açıklar. Buradaki davranışlar üretim kodu ve testlerle doğrulanmıştır; frontend özelliği tanımlamaz.

Örneklerde kullanılan kimlikler:

```text
Alice:        11111111-1111-4111-8111-111111111111
Bob:          22222222-2222-4222-8222-222222222222
Conversation: 33333333-3333-4333-8333-333333333333
Message:      44444444-4444-4444-8444-444444444444
Client msg:   55555555-5555-4555-8555-555555555555
```

## Test kapsamı

Beş senaryonun tamamı migration uygulanmış gerçek PostgreSQL üzerinde `src/contracts/backend-contract.integration.test.ts` dosyasında doğrulanır.

| Senaryo | DB-backed sözleşme testi | Ek mevcut testler |
| --- | --- | --- |
| Reconnect ve yeniden abonelik | `requires a new conversation subscription after reconnect` | `src/realtime/server/chat.integration.test.ts` — subscribe/unsubscribe ve abone olmayan typing |
| Token expiry, refresh ve socket etkisi | `keeps an established socket connected after access-token expiry and accepts a refreshed token on a new handshake` | `src/modules/auth/tokens/access-token.service.test.ts`, `src/modules/auth/auth.routes.integration.test.ts` |
| Mesaj idempotent retry | `returns the original message with 200 and emits no second event for an idempotent retry` | `src/modules/messages/message.service.test.ts`, `src/modules/messages/message.repository.test.ts` |
| Cursor uç durumları | `returns null cursors for empty and final pages and a base64url JSON cursor between pages` | `src/modules/messages/message.service.test.ts`, `src/modules/conversations/conversation.service.test.ts`, `src/modules/users/users.service.test.ts` |
| Typing expiry | `does not emit typing false automatically when the five-second expiry passes` | `src/realtime/server/chat.integration.test.ts` |

DB testinin migration ve tekillik dayanakları: `prisma/migrations/20260821000000_initial_chat_schema/migration.sql`, `prisma/schema.prisma`.

## HTTP 429 işleme

Login, register ve refresh IP'ye; kullanıcı arama ve mesaj oluşturma ise
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
`src/modules/auth/auth.routes.ts`, `src/modules/users/users.routes.ts`,
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

Register/login/refresh HTTP gövdeleri access token'ın sona erme zamanını dönmez; yalnızca `accessToken` döner. Frontend süreyi JWT `exp` claim'inden okuyabilir veya korumalı HTTP isteğinin `401` cevabında refresh akışını başlatabilir. Kaynak: `src/modules/auth/auth.controller.ts`.

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

   Production'da browser'ın `Origin` başlığı `FRONTEND_ORIGIN` ile eşleşmelidir. Cookie adı `chat_refresh_token`; `HttpOnly` olduğu için frontend JavaScript token değerini okuyamaz. Kaynaklar: `src/modules/auth/auth.middleware.ts`, `src/modules/auth/refresh-cookie.ts`, `src/modules/auth/auth.routes.ts`.

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
     "editedAt": null
   }
   ```

3. Ağ hatası yüzünden frontend cevabı göremezse aynı URL, aynı kullanıcı ve aynı `clientMessageId` ile isteği tekrarlar.

4. Retry cevabı:

   ```http
   HTTP/1.1 200 OK
   ```

   Gövde ilk mesajın aynı `id`, `body` ve zaman değerlerini taşır. Retry payload'ında aynı idempotency anahtarıyla farklı text gönderilse bile repository var olan mesajı döndürür; `clientMessageId` farklı bir mantıksal mesaj için yeniden kullanılmamalıdır. Kaynak: `src/modules/messages/message.repository.ts`.

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
         "editedAt": null
       },
       {
         "id": "44444444-4444-4444-8444-444444444444",
         "conversationId": "33333333-3333-4333-8333-333333333333",
         "senderId": "11111111-1111-4111-8111-111111111111",
         "clientMessageId": "55555555-5555-4555-8555-555555555555",
         "kind": "TEXT",
         "body": "Son mesaj",
         "createdAt": "2030-01-01T00:00:00.000Z",
         "editedAt": null
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
         "editedAt": null
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

## Kod-esaslı önemli sonuçlar

- Başarısız Socket.IO auth bir `disconnect` reason üretmez; bağlantı hiç kurulmadığı için istemci `connect_error` alır. Hata `message = "Authentication failed"`, `data.code = "INVALID_TOKEN"` biçimindedir. Kaynak: `src/realtime/auth/socket-auth.middleware.ts`.
- Access token expire olduğunda mevcut socket otomatik düşmez. Kaynak: `src/realtime/server/configure-chat-namespace.ts` içinde expiry/re-auth timer bulunmaması ve DB-backed sözleşme testi.
- Typing expiry sunucunun otomatik false yayınlaması değil, frontend'in uygulayacağı son kullanma zamanıdır. Kaynak: `src/realtime/server/configure-chat-namespace.ts`.
- Mesaj retry başarısı `201` değil `200` döner ve gövdede `created` bayrağı yoktur. Kaynak: `src/modules/messages/message.controller.ts`.
- Cursor kodlanmıştır ama şifreli veya imzalı değildir; yine de istemci için opak tutulmalıdır. Kaynak: `src/shared/pagination/cursor.ts`.
