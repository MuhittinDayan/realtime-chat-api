# Realtime Chat API

Express, Socket.IO, Prisma, PostgreSQL ve S3 uyumlu object storage kullanan sohbet backend'i.

## Yerel Kurulum

Gereksinimler:

- Node.js `>=22.12.0`
- npm `11.6.2`
- `docker compose` komutunu destekleyen Docker

Temiz bir makinede:

1. Depoyu klonlayın ve bağımlılıkları kilit dosyasından kurun:

   ```sh
   npm ci
   ```

2. Ortam dosyasını oluşturun:

   Windows PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   macOS/Linux:

   ```sh
   cp .env.example .env
   ```

3. `.env` içindeki `JWT_ACCESS_SECRET=change-me` değerini en az 32 byte
   uzunluğunda rastgele bir secret ile değiştirin. Diğer varsayılan veritabanı
   değerleri Compose ile doğrudan uyumludur.

4. PostgreSQL ile MinIO'yu başlatın, healthcheck'leri bekleyin, avatar ve
   attachment bucket'larını hazırlayın, Prisma Client'ı üretin,
   geliştirme ve test veritabanlarına migration uygulayın ve geliştirme
   verisini yükleyin:

   ```sh
   npm run setup:local
   ```

   Bu komut `postgres:17-alpine` ile pinlenmiş MinIO container'larını başlatır. Ana veritabanı
   `.env.example` ile aynı `postgresql://postgres:postgres@localhost:5432/chat`
   adresindedir. Vitest'in mevcut yapılandırmasına uygun `chat_test`
   veritabanı da hazırlanır. MinIO API `http://localhost:9000`, yönetim konsolu
   `http://localhost:9001` adresindedir. `chat-avatars` bucket'ında yalnızca
   `public/*` anonim okunabilir; `incoming/*` ve `chat-attachments` private kalır.

   Yalnızca bucket/policy kurulumunu yeniden çalıştırmak için:

   ```sh
   npm run setup:storage
   ```

5. API'yi başlatın:

   ```sh
   npm run dev
   ```

Varsayılan adres: `http://api.chat.test:4000`

Development ve test ortamlarında Swagger UI:

```text
http://api.chat.test:4000/api-docs/
```

Ham OpenAPI 3.1 sözleşmesi:

```text
http://api.chat.test:4000/api-docs/openapi.yaml
```

Swagger UI'da önce `POST /api/v1/auth/login` çalıştırılır. Cevaptaki
`accessToken`, sağ üstteki **Authorize** penceresindeki Bearer alanına
yalnızca token değeri olarak girilir. Yetkilendirme sayfa yenilemelerinde
korunur. Swagger route'ları production ortamında varsayılan olarak kapalıdır.

Seed kullanıcıları `alice@example.com` ve `bob@example.com`, geliştirme
parolası `ChatMvp123!` olarak oluşturulur. Kaynak: `prisma/seed.ts`.

PostgreSQL ve MinIO'yu durdurmak için:

```sh
docker compose down
```

`postgres_data` ve `minio_data` named volume'leri bu komutta korunur. Tamamen
temiz bir veritabanı ve object storage ile yeniden başlamak için
`docker compose down -v` kullanılabilir; bu komut her iki yerel volume'ü de
kalıcı olarak siler.

## Kontroller

```sh
npm run typecheck
npm test
npm test -- --coverage
npm run build
```

Coverage çalışması line, function, branch ve statement alanlarında `%70`
başlangıç eşiğini uygular; eşik altı sonuç başarısız olur. Lint/format script'i
bu depoda henüz tanımlı olmadığı için CI hattında lint/format adımı yoktur.

GitHub Actions hattı bağımlılık kurulumunu, tek Prisma Client üretimini,
typecheck'i, PostgreSQL 17 üzerinde migration'ı, coverage'lı tüm testleri ve
production build'i seri olarak çalıştırır. Workflow:
`.github/workflows/ci.yml`.
