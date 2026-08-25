# Realtime Chat API

Express, Socket.IO, Prisma ve PostgreSQL kullanan sohbet backend'i.

## Kurulum

1. `.env.example` dosyasını `.env` olarak kopyalayın ve değerleri düzenleyin.
2. `npm install` çalıştırın.
3. `npm run prisma:generate` çalıştırın.
4. Gerekirse `npm run prisma:migrate:deploy` ile migration'ları uygulayın.
5. `npm run dev` ile API'yi başlatın.

Varsayılan adres: `http://api.chat.test:4000`

## Kontroller

```sh
npm run typecheck
npm test
npm run build
```
