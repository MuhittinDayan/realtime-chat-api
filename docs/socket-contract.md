# Socket.IO Event Sözleşmesi

Bu belge `/chat` namespace'inin mevcut, çalışan sözleşmesini tarif eder. Yeni bir event veya davranış tanımlamaz. Ana tip kaynağı [`src/realtime/server/chat-events.ts`](../src/realtime/server/chat-events.ts), çalışma zamanı davranışının ana kaynağı [`src/realtime/server/configure-chat-namespace.ts`](../src/realtime/server/configure-chat-namespace.ts) dosyasıdır.

## Bağlantı ve kimlik doğrulama

Namespace `/chat`'tir. İstemci access token'ı Socket.IO handshake içinde aşağıdaki şekilde gönderir:

```ts
const socket = io(`${apiBaseUrl}/chat`, {
  auth: { token: accessToken },
});
```

Sunucu `socket.handshake.auth.token` değerinin boş olmayan bir string olmasını ister. Ardından HTTP Bearer doğrulamasında kullanılan aynı `AuthService.authenticateAccessToken` akışını çağırır: JWT imzası/algoritması, issuer, audience, gerekli claim'ler ve `exp` doğrulanır; token içindeki `sid` + `sub` çifti aktif, süresi dolmamış, iptal edilmemiş ve aktif kullanıcıya ait PostgreSQL oturumuna karşı kontrol edilir. Başarılı sonuçtaki `userId` ve `sessionId`, socket data alanına yazılır. Kaynaklar: `src/realtime/auth/socket-auth.middleware.ts`, `src/modules/auth/auth.service.ts`, `src/modules/auth/tokens/access-token.service.ts`, `src/modules/auth/sessions/auth-session.repository.ts`.

Handshake başarısızsa bağlantı kurulmaz; bu bir sonradan oluşan `disconnect` değil, istemcide `connect_error` olayıdır. Hata sözleşmesi:

```ts
socket.on("connect_error", (error) => {
  error.message; // "Authentication failed"
  error.data;    // { code: "INVALID_TOKEN" }
});
```

Eksik, boş, bozuk, süresi dolmuş token ve aktif olmayan DB session ayrıntıları istemciye ayrı ayrı açıklanmaz. Hepsi aynı handshake hatasına dönüştürülür. Kaynak: `src/realtime/auth/socket-auth.middleware.ts`; doğrulama testi: `src/realtime/server/chat.integration.test.ts`; DB-backed süre sonu testi: `src/contracts/backend-contract.integration.test.ts`.

Access token yalnızca handshake sırasında kontrol edilir. Bağlı socket üzerinde token süresini izleyen bir timer veya periyodik re-auth yoktur; token sonradan expire olduğunda mevcut bağlantı otomatik düşürülmez. Yeni bağlantı/yeniden bağlantı ise güncel ve geçerli token ile handshake yapmalıdır. Kaynaklar: `src/realtime/auth/socket-auth.middleware.ts`, `src/realtime/server/configure-chat-namespace.ts`; sözleşme testi: `src/contracts/backend-contract.integration.test.ts`.

## Odalar ve bağlantı yaşam döngüsü

Sunucunun kullandığı oda adları:

```text
user:<userId>
conversation:<conversationId>
```

Her başarılı bağlantı `user:<userId>` odasına otomatik katılır. `conversation:<conversationId>` odasına katılım ise yalnızca istemcinin başarılı `conversation:subscribe` çağrısıyla gerçekleşir. Oda üyeliği socket bağlantısına aittir; bağlantı kapandığında Socket.IO bu socket'in oda üyeliklerini kaldırır. Yeni socket eski konuşma aboneliklerini sunucudan geri almaz ve tekrar `conversation:subscribe` göndermelidir. Kaynaklar: `src/realtime/rooms/room-names.ts`, `src/realtime/server/configure-chat-namespace.ts`; reconnect sözleşme testi: `src/contracts/backend-contract.integration.test.ts`.

Bağlantıda presence servisine `handleConnected(userId, socketId)`, kopuşta `handleDisconnected(userId, socketId)` bildirilir. Presence işlemi bağlantı/ayrılma event'ini bloke etmez; reddedilen promise mevcut kodda yutulur. Kaynak: `src/realtime/server/configure-chat-namespace.ts`.

## Client → Server event'leri

### `conversation:subscribe`

Aktif üyesi olunan bir doğrudan konuşmanın odasına katılır.

Payload:

```ts
{
  conversationId: string; // UUID
}
```

Örnek:

```json
{
  "conversationId": "33333333-3333-4333-8333-333333333333"
}
```

Ack zorunludur. İstemci ack callback göndermezse sunucu payload'ı işleme almaz.

```ts
type ConversationSubscriptionAck =
  | { ok: true }
  | { ok: false; error: { code: "VALIDATION_ERROR" | "FORBIDDEN" } };
```

- Payload strict Zod nesnesi değilse veya UUID geçersizse `VALIDATION_ERROR` ack döner.
- Aktif üyelik yoksa `FORBIDDEN` döner.
- Üyelik sorgusu hata verirse ayrıntı sızdırılmadan yine `FORBIDDEN` döner.
- Başarılıysa socket `conversation:<conversationId>` odasına katılır ve `{ "ok": true }` döner.

Kaynaklar: `src/realtime/server/chat-events.ts`, `src/realtime/server/configure-chat-namespace.ts`, `src/modules/conversations/conversation.repository.ts`.

### `conversation:unsubscribe`

Payload:

```ts
{
  conversationId: string; // UUID
}
```

Ack sözleşmesi `conversation:subscribe` ile aynıdır, fakat geçerli bir UUID için üyelik sorgusu yapılmaz. Socket ilgili odada olmasa bile `leave` tamamlanır ve `{ "ok": true }` döner. Geçersiz payload `VALIDATION_ERROR` üretir. Ack callback yoksa işlem yapılmaz. Kaynaklar: `src/realtime/server/chat-events.ts`, `src/realtime/server/configure-chat-namespace.ts`.

### `typing:set`

Payload:

```ts
{
  conversationId: string; // UUID
  isTyping: boolean;
}
```

Örnek:

```json
{
  "conversationId": "33333333-3333-4333-8333-333333333333",
  "isTyping": true
}
```

Ack yoktur. Payload strict şemaya uymazsa veya gönderen socket ilgili konuşma odasına abone değilse event sessizce yok sayılır. Başarılı event, gönderen hariç aynı konuşma odasındaki socket'lere volatile `typing:updated` olarak anında yayınlanır. Typing anında yeniden DB üyelik sorgusu yapılmaz; odada bulunma şartı kullanılır. Kaynak: `src/realtime/server/configure-chat-namespace.ts`.

Sunucu her gelen `typing:set` için `expiresAt = clock.now() + 5_000 ms` hesaplar. Sunucuda beş saniyelik timer kurulmaz ve süre sonunda otomatik `typing:updated { isTyping: false }` yayınlanmaz. İstemci `expiresAt` geçtiğinde göstergeyi yerel olarak kapatmalı; yazma sürüyorsa süre dolmadan yeni `typing:set { isTyping: true }`, yazma bittiyse `typing:set { isTyping: false }` göndermelidir. Kaynak: `src/realtime/server/configure-chat-namespace.ts`; 5 saniye ve otomatik-false bulunmadığını doğrulayan testler: `src/realtime/server/chat.integration.test.ts`, `src/contracts/backend-contract.integration.test.ts`.

### `presence:subscribe`

İstenen kullanıcıların yetkili presence snapshot'ını alır; kalıcı bir Socket.IO odasına katılım sağlamaz.

Payload:

```ts
{
  userIds: string[]; // Her eleman UUID; en fazla 100 eleman, boş dizi geçerli
}
```

Başarı ack'i:

```ts
{
  ok: true;
  data: Record<string, {
    status: "online" | "offline";
    lastSeenAt: string | null; // ISO 8601
  }>;
}
```

Doğrulama hatası ack'i:

```json
{
  "ok": false,
  "error": { "code": "VALIDATION_ERROR" }
}
```

Ack callback yoksa işlem yapılmaz. Tekrarlanan UUID'ler servis çağrısından önce tekilleştirilir. Sonuç yalnızca istekte bulunan kullanıcının aktif doğrudan konuşma eşlerini içerir; isteyen kullanıcının kendisi ve yetkisiz/ilişkisiz kullanıcılar hata vermeden sonuçtan çıkarılır. Kodda servis/repository hataları için tanımlı ayrı bir ack biçimi veya try/catch yoktur; belgelenmiş hata ack'i yalnızca `VALIDATION_ERROR`'dır. Kaynaklar: `src/realtime/server/chat-events.ts`, `src/realtime/server/configure-chat-namespace.ts`, `src/realtime/presence/presence.service.ts`, `src/realtime/presence/presence.repository.ts`.

## Server → Client event'leri

### `session:ready`

Başarılı handshake sonrasında, socket kendi `user:<userId>` odasına katıldıktan sonra yalnızca yeni socket'e gönderilir.

```ts
{
  userId: string;     // UUID
  socketId: string;   // Socket.IO socket kimliği
  serverTime: string; // ISO 8601
}
```

Örnek:

```json
{
  "userId": "11111111-1111-4111-8111-111111111111",
  "socketId": "2ZyV4gJ3n7c8AbCdAAAB",
  "serverTime": "2030-01-01T00:00:00.000Z"
}
```

Kaynaklar: `src/realtime/server/chat-events.ts`, `src/realtime/server/configure-chat-namespace.ts`.

### `message:created`

Yeni mesaj DB transaction'ı commit edildikten sonra `conversation:<conversationId>` odasındaki tüm socket'lere yayınlanır. Namespace üzerinden yayınlandığı için gönderen socket de odaya aboneyse event'i alır. Idempotent HTTP retry var olan mesajı döndürdüğünde ikinci event yayınlanmaz.

```ts
{
  message: {
    id: string;
    conversationId: string;
    senderId: string;
    clientMessageId: string;
    kind: "TEXT";
    body: string;
    createdAt: string;      // ISO 8601
    editedAt: string | null; // ISO 8601 veya null
  };
}
```

Örnek:

```json
{
  "message": {
    "id": "44444444-4444-4444-8444-444444444444",
    "conversationId": "33333333-3333-4333-8333-333333333333",
    "senderId": "11111111-1111-4111-8111-111111111111",
    "clientMessageId": "55555555-5555-4555-8555-555555555555",
    "kind": "TEXT",
    "body": "Merhaba",
    "createdAt": "2030-01-01T00:00:00.000Z",
    "editedAt": null
  }
}
```

Kaynaklar: `src/modules/messages/message.service.ts`, `src/realtime/messages/message-publisher.ts`, `src/realtime/server/chat-events.ts`; testler: `src/realtime/server/chat.integration.test.ts`, `src/contracts/backend-contract.integration.test.ts`.

### `read:updated`

Okundu watermark'ı ilk kez oluşturulduğunda veya ileri taşındığında `conversation:<conversationId>` odasına yayınlanır. Hedef daha eski/eşit olup servis sonucu `unchanged` olduğunda event yayınlanmaz. Namespace yayını olduğundan okuyucunun socket'i de odaya aboneyse event'i alır.

```ts
{
  conversationId: string;  // UUID
  readerId: string;        // UUID
  throughMessageId: string; // UUID
  readAt: string;          // ISO 8601
}
```

Kaynaklar: `src/modules/reads/read.service.ts`, `src/realtime/reads/read-publisher.ts`, `src/realtime/server/chat-events.ts`.

### `typing:updated`

`typing:set` gönderen hariç `conversation:<conversationId>` odasındaki diğer socket'lere volatile yayınlanır.

```ts
{
  conversationId: string; // UUID
  userId: string;         // Gönderen kullanıcı UUID'si
  isTyping: boolean;
  expiresAt: string;      // Event oluşturma anı + tam 5000 ms, ISO 8601
}
```

`volatile`, bağlantı hazır değilse event'in teslim edilmeyebileceği anlamına gelir. `expiresAt` istemci timeout sınırıdır; sunucu otomatik false event'i üretmez. Kaynak: `src/realtime/server/configure-chat-namespace.ts`.

### `presence:updated`

```ts
{
  userId: string;
  status: "online" | "offline";
  lastSeenAt: string | null; // online için null; offline için DB zamanı
}
```

Event yalnızca durum değişen kullanıcının aktif doğrudan konuşma eşlerinin `user:<peerId>` odalarına yayınlanır. İlk socket bağlantısında bir kez `online`, son socket ayrıldığında bir kez `offline` yayınlanır; aynı kullanıcının ara bağlantı/ayrılmaları geçiş üretmez. `offline` öncesinde `users.last_seen_at` güncellenir. Mevcut bağlantı registry'si süreç içi `Map` olduğu için bu davranış tek API instance'ı kapsamındadır.

Örnekler:

```json
{
  "userId": "11111111-1111-4111-8111-111111111111",
  "status": "online",
  "lastSeenAt": null
}
```

```json
{
  "userId": "11111111-1111-4111-8111-111111111111",
  "status": "offline",
  "lastSeenAt": "2030-01-01T00:00:00.000Z"
}
```

Kaynaklar: `src/realtime/presence/connection-registry.ts`, `src/realtime/presence/presence.service.ts`, `src/realtime/presence/presence.repository.ts`, `src/realtime/presence/presence-publisher.ts`; testler: `src/realtime/presence/presence.service.test.ts`, `src/realtime/server/chat.integration.test.ts`.

## Frontend için zorunlu istemci davranışları

1. Her yeni/reconnect olmuş socket'te `session:ready` beklenmeli ve ekranda açık/gerekli konuşmalar yeniden `conversation:subscribe` ile abone edilmelidir.
2. HTTP access token expire olduğunda refresh cookie ile `POST /api/v1/auth/refresh` çağrılmalı; yeni access token saklanmalı. Eski socket otomatik düşmediği için frontend isterse kontrollü kapatıp yeni token ile yeniden bağlanmalı ve konuşmalara yeniden abone olmalıdır.
3. Mesaj retry'larında aynı kullanıcı için aynı `clientMessageId` korunmalıdır; `200` var olan mesaj, `201` yeni mesaj anlamına gelir. Her iki başarı gövdesi aynı Message biçimindedir.
4. `typing:updated.expiresAt` geldiğinde yerel gösterge için timer güncellenmelidir. Yeni typing event'i gelmezse bu zamanda gösterge istemci tarafından kapatılmalıdır.
5. Presence snapshot'ında istenen her UUID'nin bulunacağı varsayılmamalıdır; yetkisiz/ilişkisiz kullanıcılar map'ten sessizce çıkarılır.

Bu maddelerin kaynak doğrulaması: `src/contracts/backend-contract.integration.test.ts` ve yukarıdaki ilgili üretim dosyaları.
