# Realtime Chat API — Mevcut Durum ve Yol Haritası

> Son inceleme: 28 Ağustos 2026
>
> Proje sürümü: `0.1.0`
>
> Kapsam: `realtime-chat-api` backend deposu

> **Sahiplik notu:** Bu dokümandaki geliştirme planı backend kapsamındadır. Frontend uygulamasının geliştirilmesi ayrı bir ekip arkadaşı tarafından yapılacaktır. Backend tarafının sorumluluğu; kararlı HTTP/Socket.IO sözleşmeleri sunmak, bu sözleşmeleri belgelemek ve entegrasyon sırasında gerekli backend desteğini sağlamaktır.

## 1. Yönetici özeti

Proje, bire bir ve grup mesajlaşmasına yönelik backend MVP'sinin ana akışlarını tamamlamış durumda. Kullanıcı kaydı, profil/parola/session yönetimi, kullanıcı arama, DIRECT/GROUP konuşma yönetimi, mesaj gönderme, düzenleme, soft-delete ve geçmişi alma, okundu bilgisini ilerletme, Socket.IO üzerinden mesaj/okundu/typing/presence, grup yaşam döngüsü ve session iptali yayınları kodda mevcut. Kod tabanı modüler, TypeScript strict kuralları açık ve servis–repository ayrımı genel olarak temiz.

Faz 14a sonrasında 41 test dosyasındaki 240 testin tamamı geçti. Typecheck ve production build başarılı; auth/mesaj/grup senaryolarına ek olarak avatar media ilişkisinin PostgreSQL davranışı ve private MinIO kaynağının doğrulanıp public 512×512 WebP'ye dönüştürülmesi gerçek servislerle doğrulandı. Docker Compose tabanlı tek-komut PostgreSQL + MinIO kurulumu, OpenAPI/Socket.IO sözleşmeleri, development/test ortamında Swagger UI, coverage eşikleri, güvenlik sertleştirmesi ve seri GitHub Actions hattı mevcuttur. Mevcut seviye **“sözleşmesi belgelenmiş, güvenlik temelleri sertleştirilmiş, gerçek veritabanı ve object storage ile doğrulanmış, tekrarlanabilir geliştirme/CI tabanı bulunan backend MVP”** olarak değerlendirilebilir.

Faz 14a ile S3/R2 uyumlu object-storage temeli ve avatar yaşam döngüsü tamamlandı. Bir sonraki backend adımı ürün önceliğine göre private mesaj görseli/belge ekleri (Faz 14b/14c), e-posta doğrulama/parola sıfırlama veya çoklu instance güvenilirliği arasından seçilmelidir.

## 2. Teknoloji ve mimari özeti

| Alan | Kullanılan teknoloji / yaklaşım |
| --- | --- |
| Çalışma zamanı | Node.js `>=22.12.0`, ESM |
| Dil | TypeScript, strict derleyici ayarları |
| HTTP API | Express 5, `/api/v1` sürümlü rotalar |
| Gerçek zamanlı iletişim | Socket.IO, `/chat` namespace'i |
| Veritabanı | PostgreSQL |
| ORM / migration | Prisma 7.9.1 ve PostgreSQL adapter'ı |
| Nesne depolama | S3/R2 uyumlu katman; yerelde MinIO ve ayrı public-avatar/private-attachment bucket'ları |
| Görsel işleme | Sharp ile doğrulama, metadata temizleme ve sabit 512×512 WebP üretimi |
| Kimlik doğrulama | Kısa ömürlü JWT access token + döndürülen opaque refresh token |
| Parola güvenliği | Argon2id |
| Girdi doğrulama | Zod |
| Loglama | Pino / pino-http, hassas alan redaksiyonu |
| Test | Vitest, Supertest ve Socket.IO client |

Temel istek akışı şöyledir:

```text
HTTP isteği
  -> ortak middleware'ler
  -> route + Zod doğrulama
  -> controller
  -> service (iş kuralları)
  -> repository
  -> Prisma
  -> PostgreSQL

Mesaj / okundu değişikliği
  -> veritabanı işlemi
  -> publisher
  -> Socket.IO konuşma odası
  -> bağlı istemciler
```

## 3. Şu anda çalışan kapsam

### 3.1 HTTP API

| Metot ve yol | Durum | Amaç |
| --- | --- | --- |
| `GET /api/v1/healthz` | Hazır | Süreç canlılık kontrolü |
| `GET /api/v1/readyz` | Hazır | PostgreSQL erişilebilirlik kontrolü |
| `POST /api/v1/auth/register` | Hazır | Kullanıcı kaydı, access token ve refresh cookie oluşturma |
| `POST /api/v1/auth/login` | Hazır | Oturum açma |
| `POST /api/v1/auth/refresh` | Hazır | Refresh token rotasyonu |
| `POST /api/v1/auth/logout` | Hazır | Aktif oturumu iptal etme |
| `GET /api/v1/auth/me` | Hazır | Giriş yapmış kullanıcıyı alma |
| `PATCH /api/v1/auth/password` | Hazır | Parola değiştirme ve diğer session'ları iptal etme |
| `GET /api/v1/auth/sessions` | Hazır | Aktif session/cihaz listesini alma |
| `DELETE /api/v1/auth/sessions` | Hazır | Mevcut dışındaki tüm session'ları iptal etme |
| `DELETE /api/v1/auth/sessions/:sessionId` | Hazır | Belirli bir session'ı iptal etme |
| `PATCH /api/v1/users/me` | Hazır | Username/görünen ad profilini güncelleme |
| `POST /api/v1/users/me/avatar/uploads` | Hazır | Private incoming prefix'i için 10 dakikalık imzalı PUT adresi oluşturma |
| `POST /api/v1/users/me/avatar/uploads/:uploadId/complete` | Hazır | Kaynağı doğrulama, 512×512 WebP üretme ve profile bağlama |
| `DELETE /api/v1/users/me/avatar` | Hazır | Avatar referansını kaldırma; nesneyi periyodik temizliğe bırakma |
| `GET /api/v1/users` | Hazır | Kullanıcı adı / görünen ad ile cursor tabanlı arama |
| `POST /api/v1/conversations/direct` | Hazır | Tekrarlı ve yarışan isteklerde aynı doğrudan konuşmayı döndürme |
| `POST /api/v1/conversations/group` | Hazır | En az üç üyeli grup oluşturma; oluşturanı OWNER yapma |
| `GET /api/v1/conversations` | Hazır | Son mesaj, okunmamış sayısı ve cursor ile konuşma listesi |
| `GET /api/v1/conversations/:conversationId` | Hazır | Üyenin konuşma detayını alma |
| `PATCH /api/v1/conversations/:conversationId` | Hazır | OWNER/ADMIN için grup başlığını güncelleme |
| `POST /api/v1/conversations/:conversationId/members` | Hazır | Üye ekleme veya ayrılmış üyeyi reaktive etme |
| `DELETE /api/v1/conversations/:conversationId/members/me` | Hazır | Gruptan ayrılma |
| `DELETE /api/v1/conversations/:conversationId/members/:userId` | Hazır | OWNER dışındaki üyeyi çıkarma |
| `PATCH /api/v1/conversations/:conversationId/members/:userId` | Hazır | OWNER için MEMBER/ADMIN rol değişimi |
| `PUT /api/v1/conversations/:conversationId/owner` | Hazır | Sahipliği atomik olarak devretme |
| `POST /api/v1/conversations/:conversationId/messages` | Hazır | Idempotent metin mesajı gönderme |
| `GET /api/v1/conversations/:conversationId/messages` | Hazır | Cursor tabanlı mesaj geçmişi |
| `PATCH /api/v1/conversations/:conversationId/messages/:messageId` | Hazır | Yalnızca gönderen için mesaj düzenleme |
| `DELETE /api/v1/conversations/:conversationId/messages/:messageId` | Hazır | İdempotent soft-delete ve tombstone döndürme |
| `PUT /api/v1/conversations/:conversationId/read` | Hazır | Geri gitmeyen okundu watermark'ı güncelleme |

Korunan HTTP uçları Bearer access token ister. Refresh token JavaScript'e açılmayan `HttpOnly`, `SameSite=Lax` cookie içinde tutulur; production ortamında `Secure` kullanılır. Production refresh/logout isteklerinde `Origin`, `FRONTEND_ORIGIN` ile bire bir doğrulanır.

### 3.2 Socket.IO olayları

Namespace: `/chat`. Bağlantı sırasında access token `handshake.auth.token` alanından alınır ve aktif veritabanı oturumuna karşı doğrulanır.

İstemciden sunucuya:

- `conversation:subscribe` / `conversation:unsubscribe`
- `typing:set`
- `presence:subscribe`

Sunucudan istemciye:

- `session:ready`
- `auth:revoked`
- `message:created`
- `message:updated`
- `message:deleted`
- `read:updated`
- `typing:updated`
- `presence:updated`
- `group:created` / `group:updated`
- `member:added` / `member:removed` / `member:left`
- `member:role-updated`
- `ownership:transferred`

Konuşma odasına girişte aktif üyelik kontrol edilir. Typing olayı yalnızca katılınmış odadan yayınlanır ve beş saniyelik son kullanma zamanı taşır. Presence görünürlüğü doğrudan konuşma eşleriyle sınırlandırılmıştır. Aynı kullanıcının bir süreç içindeki birden fazla socket bağlantısı dikkate alınır.

### 3.3 Veri modeli

Mevcut ana tablolar:

- `users`: profil, durum, son görülme ve soft-delete alanları
- `conversations`: `DIRECT` / `GROUP` tipi, başlık ve son mesaj zamanı
- `conversation_members`: üyelik ve `MEMBER` / `ADMIN` / `OWNER` rolleri
- `messages`: metin mesajı, istemci mesaj kimliği, düzenlenme/silinme alanları
- `message_reads`: kullanıcı başına monoton ilerleyen okundu watermark'ı
- `auth_sessions`: hash'lenmiş refresh token, nullable user-agent, süre ve iptal bilgisi
- `media_assets`: avatar upload amacı/durumu, private incoming ve public-ready object anahtarları, doğrulanan boyut/MIME/ölçüler ve kullanıcı ilişkisi

Doğrudan konuşma anahtarı ile konuşma tekilleştirilmiş; mesajlarda `(senderId, clientMessageId)` tekilliği ile istemci retry'ları idempotent hale getirilmiştir. Listeleme sorgularında offset yerine keyset/cursor sayfalama kullanılmıştır.

## 4. Kalite doğrulama sonucu

28 Ağustos 2026 tarihinde aşağıdaki kontroller çalıştırıldı:

| Kontrol | Sonuç |
| --- | --- |
| `npm audit --omit=dev` | Başarılı — 0 production açığı |
| `prisma generate` + `prisma validate` | Başarılı |
| `npm test` | Başarılı — 41 dosya, 240/240 test |
| `npm run typecheck` | Başarılı |
| `npm run build` | Başarılı |
| `npm test -- --coverage` | Başarılı — statement %84,79; branch %73,67; function %87,41; line %86,86 |
| `npm run setup:local` | Başarılı — PostgreSQL 17, MinIO, iki bucket/policy, `chat` + `chat_test`, migration ve seed |

Not: Typecheck ve build komutlarının ikisi de `prisma generate` çalıştırıyor. Bunlar aynı çalışma dizininde paralel başlatıldığında Windows üzerinde üretilen klasöre eşzamanlı erişim nedeniyle geçici `EPERM` oluşabiliyor. Seri çalıştırıldıklarında ikisi de başarılıdır. CI hattı ya kontrolleri seri çalıştırmalı ya da Prisma Client'ı tek bir hazırlık adımında üretmelidir.

Test kapsamının güçlü tarafları auth/session yarış koşulları, doğrudan konuşma tekilleştirme, mesaj idempotency ve yaşam döngüsü, avatar boyut/MIME/görsel doğrulaması ile artık-nesne temizliği, keyset pagination, monoton okundu bilgisi, yetki kontrolleri ve Socket.IO yayın davranışlarıdır. Kritik sözleşme senaryoları `src/contracts/backend-contract.integration.test.ts`, avatar ilişkisi `src/modules/media/avatar.postgres.integration.test.ts`, gerçek MinIO akışı ise `src/modules/media/avatar.storage.integration.test.ts` içinde doğrulanır. Vitest line, function, branch ve statement alanlarının her biri için %70 coverage eşiği uygular.

## 5. Klasör yapısı

```text
realtime-chat-api/
├─ .github/workflows/
│  └─ ci.yml                            # Seri kalite, PostgreSQL ve MinIO CI hattı
├─ docs/
│  ├─ auth-security.md                 # Cookie, origin ve CSRF varsayımları
│  ├─ integration-examples.md          # Frontend için doğrulanmış akışlar
│  ├─ openapi.yaml                     # OpenAPI 3.1 HTTP sözleşmesi
│  ├─ socket-contract.md               # Socket.IO event sözleşmesi
│  └─ MEVCUT-DURUM-VE-YOL-HARITASI.md # Bu durum ve plan dokümanı
├─ prisma/
│  ├─ migrations/                      # Sürümlenmiş PostgreSQL migration'ları
│  ├─ schema.prisma                    # Veri modeli ve indeksler
│  └─ seed.ts                          # Alice/Bob geliştirme verisi
├─ src/
│  ├─ config/
│  │  └─ env.ts                        # Zod ile ortam değişkeni doğrulama
│  ├─ generated/prisma/                # Üretilen ve git tarafından izlenmeyen client
│  ├─ http/
│  │  ├─ middleware/                   # CORS, hata, JSON, request-id ve loglama
│  │  ├─ routes/                       # API v1 bileşimi ve health/readiness
│  │  ├─ types/                        # Express tip genişletmeleri
│  │  └─ validation/                   # Ortak request doğrulama yardımcıları
│  ├─ infrastructure/
│  │  ├─ database/                     # Prisma client yaşam döngüsü
│  │  └─ storage/                      # S3/R2 adapter, imzalı PUT ve bucket hazırlığı
│  ├─ modules/
│  │  ├─ auth/                         # JWT, parola, cookie ve session yönetimi
│  │  ├─ conversations/                # Doğrudan konuşma iş kuralları
│  │  ├─ media/                        # Avatar upload, işleme ve periyodik temizlik
│  │  ├─ messages/                     # Mesaj oluşturma, düzenleme, soft-delete ve geçmiş
│  │  ├─ reads/                        # Okundu watermark'ı
│  │  └─ users/                        # Kullanıcı arama
│  ├─ realtime/
│  │  ├─ auth/                         # Socket kimlik doğrulama
│  │  ├─ messages/                     # Mesaj event publisher'ı
│  │  ├─ presence/                     # Bağlantı kaydı, last-seen ve presence
│  │  ├─ reads/                        # Okundu event publisher'ı
│  │  ├─ rooms/                        # Oda adı üretimi
│  │  └─ server/                       # Socket server, event tipleri ve namespace
│  ├─ shared/                          # Hata, log, cursor, saat ve doğrulama araçları
│  ├─ contracts/                       # Gerçek DB-backed davranış testleri
│  ├─ app.ts                           # Express uygulama bileşimi
│  └─ server.ts                        # HTTP + Socket başlangıcı ve graceful shutdown
├─ scripts/
│  └─ setup-local.mjs                  # Tek-komut Compose/migration/seed kurulumu
├─ .env.example                        # Örnek ortam değişkenleri
├─ docker-compose.yml                  # PostgreSQL 17 + MinIO yerel altyapısı
├─ package.json                        # Script ve bağımlılıklar
├─ prisma.config.ts                    # Prisma yapılandırması
├─ tsconfig*.json                      # Typecheck/build ayarları
└─ vitest.config.ts                    # Test ortamı
```

Testler ayrı bir üst klasör yerine ilgili modülün yanında `*.test.ts` olarak tutuluyor. `node_modules/`, `dist/`, coverage çıktıları, `.env` dosyaları ve üretilmiş Prisma Client git dışında bırakılmıştır.

## 6. Eksik veya kısmi alanlar

### Ürün kapsamı

- Mesaj düzenleme ve soft-delete DIRECT ve GROUP konuşmalarında gönderen yetkisiyle desteklenir; grup yöneticisinin başka kullanıcının mesajını silmesi kapsam dışıdır.
- Username/görünen ad profil güncellemesi, avatar yükleme/silme, parola değiştirme, aktif session listesi, belirli session'ı ve mevcut dışındaki tüm session'ları iptal etme hazırdır. Parola sıfırlama ve e-posta doğrulama kapsam dışıdır.
- Mesaj görseli/belge eki için private attachment bucket altyapısı hazırdır; attachment veri modeli ve konuşma üyeliğine bağlı indirme sözleşmesi Faz 14b/14c kapsamındadır. Mesaj arama, bildirim, engelleme/raporlama ve moderasyon kapsam dışındadır.

### Ölçek ve güvenilirlik

- Presence kayıtları süreç içindeki `Map` üzerinde tutuluyor. Birden fazla API instance'ında global online/offline durumu doğru çalışmaz.
- Socket.IO için Redis adapter veya başka bir çapraz-instance yayın katmanı yok; odalar ve event'ler tek süreçle sınırlı.
- Veritabanı commit'inden sonra Socket.IO'ya doğrudan yayın yapılıyor. Süreç çökmesi veya publisher hatasında kayıt kalıcı olup event kaybolabilir; outbox/retry mekanizması yok.
- HTTP mesaj oluşturma ve Socket.IO `typing:set` için süreç içi rate limit vardır; dağıtık kota, genel backpressure ve yük testi henüz yoktur.

### Faz 14a storage kararları ve bilinen sınırlamalar

- R2 uyumlu presigned PUT akışında `Content-Type` imzaya bağlanır; ancak 5 MiB sınırı ingress sırasında `content-length-range` politikasıyla zorlanamaz. Bu nedenle kötü/bozuk bir istemci daha büyük private `incoming/` nesnesini storage'a göndermiş olabilir. Backend complete aşamasında önce HEAD ile gerçek boyutu kontrol eder, ardından indirmeyi 5 MiB + 1 byte ile sınırlar ve aşımı `422 INVALID_AVATAR_FILE` olarak reddeder; stale nesne periyodik temizlikle kaldırılır. Bu yaklaşım uygulama belleğini korur fakat storage'a ulaşmış ingress trafiğini ve geçici nesne maliyetini geri alamaz. İleride ingress'te kesin sınır gerekirse upload proxy/edge kuralı veya sağlayıcıya özgü doğrulanmış bir mekanizma ayrıca tasarlanmalıdır.
- Avatar upload intent ve complete uçları kullanıcı başına ortak `20 istek / 15 dakika` kotası kullanır. Normal bir avatar değişimi iki istek tükettiği için bu değer yaklaşık 10 tam değişime izin verir; kullanıcı hatalarına tolerans bırakırken kötüye kullanımı sınırlar. Sayı Faz 14a kapsamında 28 Ağustos 2026'da bu gerekçeyle onaylanmıştır.

### Teslimat ve operasyon

- Yerel PostgreSQL ve MinIO için Compose vardır; API image'ı oluşturacak Dockerfile henüz yoktur.
- GitHub Actions CI ve coverage eşikleri vardır; lint/format standardı henüz tanımlı değildir.
- OpenAPI, Socket.IO sözleşmesi ve frontend entegrasyon örnekleri `docs/` altında mevcuttur.
- Metrik, tracing, hata takip sistemi ve alarm tanımları yok; şu an temel yapılandırılmış loglar ve health endpoint'leri var.
- Production deployment manifesti, ters proxy/WebSocket ayarı, migration çalıştırma prosedürü, yedekleme ve geri dönüş planı belgelenmemiş.

### Güvenlik sertleştirmesi

- Auth (parola değiştirme dahil), kullanıcı arama ve mesaj oluşturma uçlarında IP/kullanıcı bazlı bağımsız rate limitler; `typing:set` için socket bazlı flood-control vardır.
- Helmet güvenlik header'ları uygulanır; HSTS yalnızca production ortamında etkinleşir.
- Cross-site frontend ihtiyacı oluşursa mevcut `SameSite=Lax` yaklaşımı yeterli olmaz; `SameSite=None; Secure` ile ayrı bir CSRF token mekanizması gerekir.
- Production dependency audit CI'dadır. Gitleaks ile çalışma ağacı ve Git geçmişi taranmıştır; secret taramasının CI'da otomatik çalıştırılması henüz eklenmemiştir.

## 7. Önerilen geliştirme sırası

### P0 — Tekrarlanabilir ve güvenilir geliştirme tabanı

1. **Tamamlandı — Yerel altyapı.** PostgreSQL 17 ile MinIO, healthcheck'ler, named volume'lar, public-avatar/private-attachment bucket politikaları, migration, test DB ve seed tek komutla hazırlanıyor.
2. **Tamamlandı — Gerçek DB sözleşme testleri.** Beş kritik frontend/backend davranışı PostgreSQL üzerinde doğrulanıyor.
3. **Büyük ölçüde tamamlandı — CI kalite kapısı.** `npm ci`, tek generate, typecheck, DB migration, coverage'lı test ve build seri çalışıyor. Lint/format henüz yok.
4. **Tamamlandı — API sözleşmesi.** OpenAPI, Socket.IO sözleşmesi ve entegrasyon örnekleri yayınlandı.
5. **Tamamlandı — Temel güvenlik sertleştirmesi.** Auth, kullanıcı arama, mesaj ve typing rate limitleri; Helmet header'ları; dependency audit ve Git geçmişi secret taraması uygulandı.

P0 tamamlanma ölçütü: Yeni backend geliştiricisi tek komut setiyle veritabanını ve API'yi çalıştırabilmeli; CI temiz kurulumda geçmeli; en az bir gerçek PostgreSQL uçtan uca senaryosu bulunmalı; frontend geliştiricisi güncel sözleşmeyi kullanarak kendi istemci uygulamasını geliştirebilmeli.

### P1 — MVP ürün kapsamını tamamlama

1. **Tamamlandı — Grup konuşmaları MVP.** Oluşturma, başlık, üye yaşam döngüsü, rol matrisi, sahiplik devri, 100 aktif üye sınırı ve GROUP socket event'leri eklendi.
2. **Tamamlandı — Mesaj yaşam döngüsü.** Gönderen için düzenleme, idempotent soft-delete, tombstone gösterimi ve `message:updated` / `message:deleted` event'leri eklendi.
3. **Tamamlandı — Profil ve avatar yönetimi (Faz 14a).** Username/görünen ad güncellemesi ile private incoming upload, güvenli görsel doğrulama/dönüştürme, public avatar URL'si, kaldırma ve periyodik artık-nesne temizliği hazırdır. Mesaj ekleri ayrı Faz 14b/14c kapsamındadır.
4. **Kısmen tamamlandı — Hesap ve session yönetimi.** Parola değiştirme, aktif session listesi, belirli session'ı ve diğer session'ları iptal etme hazırdır; e-posta doğrulama ve parola sıfırlama e-posta sağlayıcısı kararıyla sonraki faza bırakılmıştır.
5. Backend sözleşme testlerinde reconnect sonrası yeniden abonelik, token refresh, idempotent retry, cursor pagination ve typing timeout davranışlarını doğrula; frontend geliştiricisine örnek istek/event akışlarını sağla. Frontend uygulama kodu bu backend planının kapsamı dışındadır.

### P2 — Çoklu instance ve güvenilir event teslimi

1. Socket.IO Redis adapter ekle; load balancer ve WebSocket bağlantı stratejisini belgeleyip test et.
2. Presence durumunu Redis gibi ortak, TTL destekli bir store'a taşı; kopan bağlantı ve süreç çökmesi senaryolarını ele al.
3. Mesaj/okundu event'leri için transactional outbox ve retry worker tasarla; event'leri idempotent tüketilebilir hale getir.
4. Metrik, tracing ve hata takibini ekle; bağlantı sayısı, event gecikmesi, hata oranı, DB latency ve queue backlog için dashboard/alarm kur.
5. REST ve WebSocket yük testlerini çalıştır; bağlantı, mesaj throughput'u ve veritabanı darboğazlarına göre kapasite hedefleri belirle.

### P3 — İleri ürün yetenekleri

- Dosya/görsel ekleri ve güvenli medya işleme
- Mesaj arama ve uygun indeksleme
- Push/e-posta bildirimleri ve kullanıcı tercihleri
- Engelleme, raporlama, spam önleme ve moderasyon
- Mesaj saklama politikası, veri dışa aktarma ve hesap silme
- Gerekirse sesli/görüntülü görüşme için ayrı sinyalleşme tasarımı

## 8. Önerilen ilk sprint

İlk sprint için kapsamı aşağıdaki sırada tutmak en yüksek getiriyi sağlar:

1. ~~PostgreSQL Compose + healthcheck + migration + seed akışı~~
2. ~~Gerçek PostgreSQL kullanan kritik akış entegrasyon testi~~
3. ~~CI pipeline ve tek seferlik Prisma generate düzeni~~
4. ~~OpenAPI başlangıç belgesi ve Socket.IO event dokümanı~~
5. ~~Rate limiting ve güvenlik header'ları~~

Bu sprint sonunda mevcut MVP, “benim makinemde çalışıyor” seviyesinden tekrarlanabilir, sözleşmesi bilinen ve güvenle genişletilebilir bir backend tabanına taşındı. Grup konuşmaları MVP de tamamlandı; sonraki sprint için profil/hesap yönetimi veya çoklu instance altyapısından biri bağımsız kapsam olarak seçilmelidir.

## 9. Karar verilmesi gereken konular

Geliştirmeye başlamadan önce aşağıdaki ürün/altyapı kararları netleştirilmelidir:

- Grup konuşmaları production kapsamına dahildir; istemci tarafında OWNER/ADMIN yönetim ekranlarının hangi sürümde açılacağı netleştirilmelidir.
- Tek instance ile başlanacaksa beklenen eşzamanlı socket ve mesaj hacmi nedir; çoklu instance hangi eşikte zorunlu olacak?
- Frontend ve API aynı site altındaki farklı subdomain'lerde mi kalacak? Bu karar cookie/CSRF tasarımını etkiler.
- Mesaj ekleri için S3/R2 uyumlu private bucket kararı hazırdır; Faz 14b/14c'de izin verilen türler, konuşma üyeliğine bağlı presigned GET ve belge virüs tarama akışı kesinleştirilmelidir.
- Soft-delete edilen mesajların DB body’si için production saklama/anonymization süresi ne olmalıdır?
- Production hedefi nedir: tek sunucu, container platformu veya yönetilen bir servis mi?

Bu kararlar P1 kapsamını ve P2 ölçekleme işlerinin ne kadar erken yapılması gerektiğini doğrudan belirler.
