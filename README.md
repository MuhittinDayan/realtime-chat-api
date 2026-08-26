# Realtime Chat API

Express, Socket.IO, Prisma ve PostgreSQL kullanan sohbet backend'i.

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

4. PostgreSQL'i başlatın, healthcheck'i bekleyin, Prisma Client'ı üretin,
   geliştirme ve test veritabanlarına migration uygulayın ve geliştirme
   verisini yükleyin:

   ```sh
   npm run setup:local
   ```

   Bu komut `postgres:17-alpine` container'ını başlatır. Ana veritabanı
   `.env.example` ile aynı `postgresql://postgres:postgres@localhost:5432/chat`
   adresindedir. Vitest'in mevcut yapılandırmasına uygun `chat_test`
   veritabanı da hazırlanır.

5. API'yi başlatın:

   ```sh
   npm run dev
   ```

Varsayılan adres: `http://api.chat.test:4000`

Seed kullanıcıları `alice@example.com` ve `bob@example.com`, geliştirme
parolası `ChatMvp123!` olarak oluşturulur. Kaynak: `prisma/seed.ts`.

PostgreSQL'i durdurmak için:

```sh
docker compose down
```

`postgres_data` named volume'ü bu komutta korunur. Tamamen temiz bir
veritabanıyla yeniden başlamak için `docker compose down -v` kullanılabilir;
bu komut yerel veritabanı volume'ünü kalıcı olarak siler.

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
