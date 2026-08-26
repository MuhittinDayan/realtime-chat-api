# Realtime Chat API — Mevcut Durum ve Yol Haritası

> Son inceleme: 26 Ağustos 2026
>
> Proje sürümü: `0.1.0`
>
> Kapsam: `realtime-chat-api` backend deposu

> **Sahiplik notu:** Bu dokümandaki geliştirme planı backend kapsamındadır. Frontend uygulamasının geliştirilmesi ayrı bir ekip arkadaşı tarafından yapılacaktır. Backend tarafının sorumluluğu; kararlı HTTP/Socket.IO sözleşmeleri sunmak, bu sözleşmeleri belgelemek ve entegrasyon sırasında gerekli backend desteğini sağlamaktır.

## 1. Yönetici özeti

Proje, bire bir mesajlaşmaya yönelik backend MVP'sinin ana akışlarını tamamlamış durumda. Kullanıcı kaydı ve oturum yönetimi, kullanıcı arama, doğrudan konuşma oluşturma/listeleme, mesaj gönderme ve geçmişi alma, okundu bilgisini ilerletme, Socket.IO üzerinden mesaj/okundu/typing/presence yayınlama kodda mevcut. Kod tabanı modüler, TypeScript strict kuralları açık ve servis–repository ayrımı genel olarak temiz.

FAZ 8 ve FAZ 9 sonrasında 24 test dosyasındaki 120 testin tamamı geçti. Typecheck ve production build başarılı; beş kritik sözleşme senaryosu migration uygulanmış PostgreSQL 17 üzerinde doğrulandı. Docker Compose tabanlı tek-komut yerel kurulum, OpenAPI/Socket.IO sözleşmeleri, coverage eşikleri ve seri GitHub Actions hattı eklendi. Mevcut seviye **“sözleşmesi belgelenmiş, gerçek veritabanıyla doğrulanmış ve tekrarlanabilir geliştirme/CI tabanı bulunan backend MVP”** olarak değerlendirilebilir.

Bir sonraki backend adımı temel güvenlik sertleştirmesini tamamlamak ve ürün önceliğine göre grup konuşmaları veya mesaj düzenleme/silme gibi şemada izi olup uygulama katmanında bulunmayan özelliklere geçmektir.

## 2. Teknoloji ve mimari özeti

| Alan | Kullanılan teknoloji / yaklaşım |
| --- | --- |
| Çalışma zamanı | Node.js `>=22.12.0`, ESM |
| Dil | TypeScript, strict derleyici ayarları |
| HTTP API | Express 5, `/api/v1` sürümlü rotalar |
| Gerçek zamanlı iletişim | Socket.IO, `/chat` namespace'i |
| Veritabanı | PostgreSQL |
| ORM / migration | Prisma 7.9.1 ve PostgreSQL adapter'ı |
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
| `GET /api/v1/users` | Hazır | Kullanıcı adı / görünen ad ile cursor tabanlı arama |
| `POST /api/v1/conversations/direct` | Hazır | Tekrarlı ve yarışan isteklerde aynı doğrudan konuşmayı döndürme |
| `GET /api/v1/conversations` | Hazır | Son mesaj, okunmamış sayısı ve cursor ile konuşma listesi |
| `GET /api/v1/conversations/:conversationId` | Hazır | Üyenin konuşma detayını alma |
| `POST /api/v1/conversations/:conversationId/messages` | Hazır | Idempotent metin mesajı gönderme |
| `GET /api/v1/conversations/:conversationId/messages` | Hazır | Cursor tabanlı mesaj geçmişi |
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
- `message:created`
- `read:updated`
- `typing:updated`
- `presence:updated`

Konuşma odasına girişte aktif üyelik kontrol edilir. Typing olayı yalnızca katılınmış odadan yayınlanır ve beş saniyelik son kullanma zamanı taşır. Presence görünürlüğü doğrudan konuşma eşleriyle sınırlandırılmıştır. Aynı kullanıcının bir süreç içindeki birden fazla socket bağlantısı dikkate alınır.

### 3.3 Veri modeli

Mevcut ana tablolar:

- `users`: profil, durum, son görülme ve soft-delete alanları
- `conversations`: `DIRECT` / `GROUP` tipi, başlık ve son mesaj zamanı
- `conversation_members`: üyelik ve `MEMBER` / `ADMIN` / `OWNER` rolleri
- `messages`: metin mesajı, istemci mesaj kimliği, düzenlenme/silinme alanları
- `message_reads`: kullanıcı başına monoton ilerleyen okundu watermark'ı
- `auth_sessions`: hash'lenmiş refresh token, süre ve iptal bilgisi

Doğrudan konuşma anahtarı ile konuşma tekilleştirilmiş; mesajlarda `(senderId, clientMessageId)` tekilliği ile istemci retry'ları idempotent hale getirilmiştir. Listeleme sorgularında offset yerine keyset/cursor sayfalama kullanılmıştır.

## 4. Kalite doğrulama sonucu

26 Ağustos 2026 tarihinde aşağıdaki kontroller çalıştırıldı:

| Kontrol | Sonuç |
| --- | --- |
| `npm test` | Başarılı — 24 dosya, 120/120 test |
| `npm run typecheck` | Başarılı |
| `npm run build` | Başarılı |
| `npm test -- --coverage` | Başarılı — statement %82,21; branch %71,50; function %82,90; line %82,58 |
| `npm run setup:local` | Başarılı — PostgreSQL 17, `chat` + `chat_test`, migration ve seed |

Not: Typecheck ve build komutlarının ikisi de `prisma generate` çalıştırıyor. Bunlar aynı çalışma dizininde paralel başlatıldığında Windows üzerinde üretilen klasöre eşzamanlı erişim nedeniyle geçici `EPERM` oluşabiliyor. Seri çalıştırıldıklarında ikisi de başarılıdır. CI hattı ya kontrolleri seri çalıştırmalı ya da Prisma Client'ı tek bir hazırlık adımında üretmelidir.

Test kapsamının güçlü tarafları auth/session yarış koşulları, doğrudan konuşma tekilleştirme, mesaj idempotency, keyset pagination, monoton okundu bilgisi, yetki kontrolleri ve Socket.IO yayın davranışlarıdır. Beş kritik sözleşme senaryosu ayrıca `src/contracts/backend-contract.integration.test.ts` içinde gerçek PostgreSQL'e karşı çalışır. Vitest line, function, branch ve statement alanlarının her biri için %70 coverage eşiği uygular.

## 5. Klasör yapısı

```text
realtime-chat-api/
├─ .github/workflows/
│  └─ ci.yml                            # Seri kalite ve PostgreSQL CI hattı
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
│  │  └─ database/                     # Prisma client yaşam döngüsü
│  ├─ modules/
│  │  ├─ auth/                         # JWT, parola, cookie ve session yönetimi
│  │  ├─ conversations/                # Doğrudan konuşma iş kuralları
│  │  ├─ messages/                     # Mesaj oluşturma ve geçmiş
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
├─ docker-compose.yml                  # PostgreSQL 17 yerel altyapısı
├─ package.json                        # Script ve bağımlılıklar
├─ prisma.config.ts                    # Prisma yapılandırması
├─ tsconfig*.json                      # Typecheck/build ayarları
└─ vitest.config.ts                    # Test ortamı
```

Testler ayrı bir üst klasör yerine ilgili modülün yanında `*.test.ts` olarak tutuluyor. `node_modules/`, `dist/`, coverage çıktıları, `.env` dosyaları ve üretilmiş Prisma Client git dışında bırakılmıştır.

## 6. Eksik veya kısmi alanlar

### Ürün kapsamı

- Veri modeli `GROUP` konuşmayı destekleyecek şekilde hazırlanmış olsa da servis yalnızca `DIRECT` kabul ediyor; grup oluşturma, üye/rol yönetimi ve grup olayları yok.
- Mesaj modelinde `editedAt` ve `deletedAt` bulunuyor fakat mesaj düzenleme/silme uçları ve Socket olayları yok.
- Kullanıcı profilini güncelleme, avatar yükleme, parola sıfırlama/değiştirme, e-posta doğrulama ve “tüm cihazlardan çıkış” akışları yok.
- Dosya/görsel eki, mesaj arama, bildirim, engelleme/raporlama ve moderasyon kapsam dışında.

### Ölçek ve güvenilirlik

- Presence kayıtları süreç içindeki `Map` üzerinde tutuluyor. Birden fazla API instance'ında global online/offline durumu doğru çalışmaz.
- Socket.IO için Redis adapter veya başka bir çapraz-instance yayın katmanı yok; odalar ve event'ler tek süreçle sınırlı.
- Veritabanı commit'inden sonra Socket.IO'ya doğrudan yayın yapılıyor. Süreç çökmesi veya publisher hatasında kayıt kalıcı olup event kaybolabilir; outbox/retry mekanizması yok.
- HTTP mesaj oluşturma ve Socket.IO `typing:set` için süreç içi rate limit vardır; dağıtık kota, genel backpressure ve yük testi henüz yoktur.

### Teslimat ve operasyon

- Yerel PostgreSQL için Compose vardır; API image'ı oluşturacak Dockerfile henüz yoktur.
- GitHub Actions CI ve coverage eşikleri vardır; lint/format standardı henüz tanımlı değildir.
- OpenAPI, Socket.IO sözleşmesi ve frontend entegrasyon örnekleri `docs/` altında mevcuttur.
- Metrik, tracing, hata takip sistemi ve alarm tanımları yok; şu an temel yapılandırılmış loglar ve health endpoint'leri var.
- Production deployment manifesti, ters proxy/WebSocket ayarı, migration çalıştırma prosedürü, yedekleme ve geri dönüş planı belgelenmemiş.

### Güvenlik sertleştirmesi

- Auth, kullanıcı arama ve mesaj oluşturma uçlarında IP/kullanıcı bazlı bağımsız rate limitler; `typing:set` için socket bazlı flood-control vardır.
- Helmet güvenlik header'ları uygulanır; HSTS yalnızca production ortamında etkinleşir.
- Cross-site frontend ihtiyacı oluşursa mevcut `SameSite=Lax` yaklaşımı yeterli olmaz; `SameSite=None; Secure` ile ayrı bir CSRF token mekanizması gerekir.
- Production dependency audit CI'dadır. Gitleaks ile çalışma ağacı ve Git geçmişi taranmıştır; secret taramasının CI'da otomatik çalıştırılması henüz eklenmemiştir.

## 7. Önerilen geliştirme sırası

### P0 — Tekrarlanabilir ve güvenilir geliştirme tabanı

1. **Tamamlandı — Yerel altyapı.** PostgreSQL 17, healthcheck, named volume, migration, test DB ve seed tek komutla hazırlanıyor.
2. **Tamamlandı — Gerçek DB sözleşme testleri.** Beş kritik frontend/backend davranışı PostgreSQL üzerinde doğrulanıyor.
3. **Büyük ölçüde tamamlandı — CI kalite kapısı.** `npm ci`, tek generate, typecheck, DB migration, coverage'lı test ve build seri çalışıyor. Lint/format henüz yok.
4. **Tamamlandı — API sözleşmesi.** OpenAPI, Socket.IO sözleşmesi ve entegrasyon örnekleri yayınlandı.
5. **Tamamlandı — Temel güvenlik sertleştirmesi.** Auth, kullanıcı arama, mesaj ve typing rate limitleri; Helmet header'ları; dependency audit ve Git geçmişi secret taraması uygulandı.

P0 tamamlanma ölçütü: Yeni backend geliştiricisi tek komut setiyle veritabanını ve API'yi çalıştırabilmeli; CI temiz kurulumda geçmeli; en az bir gerçek PostgreSQL uçtan uca senaryosu bulunmalı; frontend geliştiricisi güncel sözleşmeyi kullanarak kendi istemci uygulamasını geliştirebilmeli.

### P1 — MVP ürün kapsamını tamamlama

1. Grup konuşması oluşturma, başlık değiştirme, üye ekleme/çıkarma ve rol/yetki kurallarını uygula.
2. Mesaj düzenleme ve soft-delete endpoint'leri ile `message:updated` / `message:deleted` event'lerini ekle.
3. Profil güncelleme ve avatar akışını ekle; dosya depolama kararı verilirse imzalı yükleme URL'lerini tercih et.
4. Parola değiştirme/sıfırlama, e-posta doğrulama, aktif oturumları listeleme ve tüm cihazlardan çıkış akışlarını ekle.
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

Bu sprintin sonunda mevcut MVP'nin “benim makinemde çalışıyor” seviyesinden tekrarlanabilir, sözleşmesi bilinen ve güvenle genişletilebilir bir backend tabanına taşınması hedeflenmelidir. Bundan sonraki sprintte grup konuşmaları ile mesaj düzenleme/silme birlikte ele alınabilir.

## 9. Karar verilmesi gereken konular

Geliştirmeye başlamadan önce aşağıdaki ürün/altyapı kararları netleştirilmelidir:

- İlk production sürümü yalnızca bire bir konuşma mı destekleyecek, yoksa grup konuşması MVP şartı mı?
- Tek instance ile başlanacaksa beklenen eşzamanlı socket ve mesaj hacmi nedir; çoklu instance hangi eşikte zorunlu olacak?
- Frontend ve API aynı site altındaki farklı subdomain'lerde mi kalacak? Bu karar cookie/CSRF tasarımını etkiler.
- Medya ekleri ilk sürüme dahil mi; dahilse hangi object storage ve virüs tarama akışı kullanılacak?
- Mesaj düzenleme/silme davranışı ve saklama politikası nedir?
- Production hedefi nedir: tek sunucu, container platformu veya yönetilen bir servis mi?

Bu kararlar P1 kapsamını ve P2 ölçekleme işlerinin ne kadar erken yapılması gerektiğini doğrudan belirler.
