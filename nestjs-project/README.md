# StreamTube — Backend API (NestJS)

API RESTful do StreamTube, desenvolvida com **NestJS 11**, **TypeScript**, **TypeORM** e **PostgreSQL**, com processamento assíncrono de mídia via **BullMQ**, **Redis**, **FFmpeg** e **MinIO (S3-compatible Object Storage)**.

---

## 🏗️ Arquitetura e Componentes

- **`nestjs-api`**: Servidor HTTP principal com rotas de autenticação, controle de uploads, gerenciamento de canais e entrega de mídia autorizada.
- **`outbox-relay`**: Worker standalone que realiza polling com pessimistic locking (`FOR UPDATE SKIP LOCKED`) na tabela de eventos da Outbox transacional e despacha jobs para o BullMQ com idempotência determinística.
- **`video-worker`**: Worker standalone de transcodificação que consome jobs do BullMQ, faz download do arquivo original via S3, executa `ffprobe` e `ffmpeg` para gerar resoluções adaptativas (HLS 360p, 480p, 720p, 1080p), master playlist e thumbnail, gravando os artefatos de volta no MinIO e atualizando o status do vídeo para `READY`.
- **`db`** (PostgreSQL 17): Persistência de usuários, canais, tokens, vídeos, sessões de upload e eventos da outbox.
- **`redis`** (Redis 7): Fila de mensagens e controle de concorrência com BullMQ.
- **`minio`** (MinIO S3): Armazenamento de arquivos de vídeo originais, playlists HLS, segmentos `.ts` e thumbnails.
- **`mailpit`**: Servidor SMTP local para captura de e-mails transacionais (confirmação de conta e recuperação de senha).

---

## 🚀 Como Executar

### 1. Subir os containers no Docker

```bash
cd nestjs-project

# Sobe API, workers, banco, redis, minio e mailpit
docker compose up -d

# Executa as migrations no PostgreSQL
docker compose exec nestjs-api npm run migration:run
```

### 2. Comandos úteis

```bash
# Servidor de desenvolvimento com hot-reload (já ativo no compose por padrão)
docker compose exec nestjs-api npm run start:dev

# Execução avulsa do outbox relay
docker compose exec nestjs-api npm run start:outbox-relay

# Execução avulsa do worker de vídeo
docker compose exec nestjs-api npm run start:video-worker

# Exportar schema OpenAPI / Swagger
docker compose exec nestjs-api npm run openapi:export
```

### 3. URLs e Portas dos Serviços

| Serviço | URL / Porta | Descrição |
|---------|-------------|-----------|
| **API NestJS** | `http://localhost:3000` | Endpoints REST da aplicação |
| **Swagger UI** | `http://localhost:3000/api/docs` | Documentação interativa da API |
| **PostgreSQL** | `localhost:5432` | Credenciais: `streamtube` / `streamtube` (DB: `streamtube`) |
| **MinIO Console** | `http://localhost:9001` | Console Web (`minioadmin` / `minioadmin`) |
| **MinIO S3 API** | `http://localhost:9000` | Endpoint de Object Storage e URLs pré-assinadas |
| **Mailpit UI** | `http://localhost:8025` | Webmail para conferência de e-mails |
| **Redis** | `localhost:6379` | Broker do BullMQ |

---

## 📡 Endpoints da API

### 🔐 Autenticação (`/auth`)

| Método | Rota | Descrição | Auth |
|---|---|---|---|
| `POST` | `/auth/register` | Cadastro de usuário e criação automática de canal | Pública |
| `GET` | `/auth/confirm-email?token=` | Ativação de conta via token de e-mail | Pública |
| `POST` | `/auth/resend-confirmation` | Reenvio do e-mail de confirmação | Pública |
| `POST` | `/auth/login` | Autenticação com e-mail e senha (emite tokens) | Pública |
| `POST` | `/auth/refresh` | Rotação de refresh token (com proteção contra reuso) | Pública |
| `POST` | `/auth/logout` | Invalidação dos refresh tokens do usuário | JWT |
| `POST` | `/auth/forgot-password` | Solicitação de recuperação de senha | Pública |
| `GET` | `/auth/reset-password?token=` | Validação de token de reset de senha | Pública |
| `POST` | `/auth/reset-password` | Redefinição de senha | Pública |
| `GET` | `/auth/me` | Retorna o perfil do usuário e seu canal | JWT |

### 📹 Upload e Mídia (`/videos`)

| Método | Rota | Descrição | Auth |
|---|---|---|---|
| `POST` | `/videos/uploads` | Inicia sessão multipart, gera `publicId` e pre-cadastra vídeo | JWT |
| `GET` | `/videos/uploads/:sessionId` | Consulta status da sessão de upload e partes confirmadas | JWT (Dono) |
| `POST` | `/videos/uploads/:sessionId/part-urls` | Gera lote de URLs pré-assinadas para envio direto ao MinIO | JWT (Dono) |
| `POST` | `/videos/uploads/:sessionId/complete` | Conclui sessão multipart e agenda transcodificação via Outbox | JWT (Dono) |
| `DELETE` | `/videos/uploads/:sessionId` | Cancela upload, remove partes no S3 e atualiza status | JWT (Dono) |
| `GET` | `/videos/:publicId/upload-status` | Polling do status de processamento e diagnóstico do vídeo | JWT (Dono) |
| `GET` | `/videos/:publicId/playback/master` | Master playlist HLS (`application/vnd.apple.mpegurl`) | JWT (Dono) |
| `GET` | `/videos/:publicId/playback/:rendition` | Playlist variante com URLs dos segmentos pré-assinadas dinamicamente | JWT (Dono) |
| `GET` | `/videos/:publicId/thumbnail` | Redirecionamento 302 para URL pré-assinada da thumbnail | JWT (Dono) |
| `GET` | `/videos/:publicId/download` | Redirecionamento 302 com `Content-Disposition: attachment` | JWT (Dono) |

---

## 🧪 Testes

A suíte de testes cobre unidades, integrações com serviços reais e testes ponta a ponta (E2E):

```bash
# Executa todos os testes unitários e de integração
docker compose exec nestjs-api npm test -- --runInBand

# Executa testes end-to-end (HTTP completo com supertest)
docker compose exec nestjs-api npm run test:e2e

# Executa testes com relatório de cobertura
docker compose exec nestjs-api npm run test:cov

# Verificação estática de tipos e lint
docker compose exec nestjs-api npx tsc --noEmit
docker compose exec nestjs-api npm run lint
```

---

## 📁 Estrutura de Módulos

```
src/
├── auth/                 # Módulo de autenticação, guards, estratégias JWT e tokens
├── users/                # Módulo e entidade de usuários
├── channels/             # Módulo e entidade de canais (relação 1:1 com usuário)
├── videos/               # Módulo de vídeos, upload sessions e entrega de mídia
├── storage/              # Adaptador S3/MinIO para multipart e presigned URLs
├── outbox/               # Entidade de Outbox, repositório e OutboxRelayService
├── video-worker/         # FFmpegService e VideoProcessorService (BullMQ consumer)
├── mail/                 # Serviço de envio de e-mails com templates Handlebars
├── common/               # Filtros de exceção globais, decorators e pipes
├── config/               # Configurações validadas com Joi (db, auth, storage, queue)
├── database/             # Data-source TypeORM, migrations e seeds
├── relay/                # Bootstrap standalone do Outbox Relay
└── worker/               # Bootstrap standalone do Video Worker
```
