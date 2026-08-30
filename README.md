# StreamTube — Plataforma de Compartilhamento de Vídeos

Projeto da disciplina **Desenvolvimento de Aplicações de IA** do MBA de Engenharia de Software com IA da [Full Cycle](https://fullcycle.com.br).

Este é um projeto greenfield desenvolvido para demonstrar como construir uma aplicação do zero utilizando IA de forma adequada no processo de desenvolvimento.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>

---

## Quadro Branco

- [Quadro Branco](./whiteboard.png)

---

## 🎨 Design System (Figma)

- [FC Tube.fig](./FC%20Tube.fig) — arquivo-fonte do **design system** do projeto no Figma.
- [FC Tube sem padrão.fig](./FC%20Tube%20sem%20padrao.fig) — arquivo-fonte puro, sem tokens, cores, tipografia e espaçamento.

Contém os fundamentos visuais do StreamTube — tokens (cores, tipografia, espaçamento, raios), componentes e as telas da plataforma. É a referência de design para a implementação do frontend: os componentes em `next-frontend/components/ui` (shadcn) e os tokens em `next-frontend/app/globals.css` derivam deste arquivo. Abra-o no Figma (`Arquivo → Importar`) para consultar especificações e estados visuais.

---

## 📋 Pré-requisitos

- Docker e Docker Compose
- Node.js v25+ (para rodar os testes E2E do Playwright no host)
- npm

## 🏗️ Arquitetura

O projeto é um monorepo baseado em containers Docker. Cada subprojeto sobe sua própria stack via `docker compose`.

- **Frontend** (Next.js 16, App Router + React Server Components) — interface da plataforma. Segue o **modelo BFF**: o navegador nunca chama a API NestJS diretamente; todo tráfego passa por Route Handlers same-origin em `app/api/**`, que fazem proxy server-side para a API. Arquivos grandes de vídeo utilizam upload direto browser-to-storage via URLs pré-assinadas pelo MinIO (TD-02).
- **API** (NestJS 11) — regras de negócio, autenticação (JWT + refresh token rotation), controle de upload multipart, outbox transacional e entrega de mídia autorizada.
- **Database** (PostgreSQL 17) — usuários, canais, tokens, vídeos, sessões de upload e eventos de outbox.
- **Email Service** (Mailpit) — captura os e-mails transacionais (confirmação de conta e recuperação de senha) em uma UI local.
- **Transactional Outbox Relay** — worker standalone que faz polling com lock pessimista (`SKIP LOCKED`) e despacha eventos para a fila BullMQ.
- **Video Worker** (FFmpeg + BullMQ) — worker standalone que processa vídeos de forma assíncrona: extração de duração/metadados, transcodificação HLS adaptativa (360p, 480p, 720p, 1080p), geração de master playlist e extração de thumbnail.
- **Object Storage** (MinIO S3) — armazenamento de arquivos de vídeo originais, playlists HLS, segmentos `.ts` e thumbnails com políticas de ciclo de vida e CORS.
- **Message Queue** (Redis 7 + BullMQ) — fila de processamento de vídeos com retry exponencial e idempotência determinística.

O diagrama de arquitetura completo (C4) está em `docs/diagrams/software-arch.mermaid`.

## 🚀 Como rodar

Os dois subprojetos têm stacks Docker **separadas**. Suba primeiro o backend, rode as migrations e depois o frontend.

### 1. Backend (NestJS + PostgreSQL + Redis + MinIO + Workers + Mailpit)

```bash
cd nestjs-project

# Sobe API, workers (video-worker, outbox-relay), banco, redis, minio e mailpit
docker compose up -d

# Instala dependências (apenas na primeira vez)
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run
```

Serviços disponíveis:

| Serviço | URL / Porta | Descrição |
|---------|-------------|-----------|
| **API NestJS** | http://localhost:3000 | Endpoints REST da aplicação |
| **Swagger UI** | http://localhost:3000/api/docs | Documentação OpenAPI interativa |
| **PostgreSQL** | `localhost:5432` | Credenciais: `streamtube` / `streamtube` (DB: `streamtube`) |
| **MinIO Console** | http://localhost:9001 | Console Web (`minioadmin` / `minioadmin`) |
| **MinIO S3 API** | http://localhost:9000 | Endpoint S3 para uploads e presigned URLs |
| **Mailpit (UI de e-mails)** | http://localhost:8025 | Webmail para conferência de e-mails |
| **Redis** | `localhost:6379` | Broker de mensagens do BullMQ |

### 2. Frontend (Next.js)

```bash
cd next-frontend

# Garanta que o .env.local existe (veja .env.example)
# API_URL aponta para o backend; SESSION_PASSWORD protege a sessão (iron-session)

docker compose up -d
docker compose exec next-frontend npm install        # apenas na primeira vez
```

A aplicação ficará disponível em **http://localhost:3001** e o workspace de upload em **http://localhost:3001/studio/upload**.

> As stacks são separadas, então o frontend acessa o backend via `host.docker.internal:3000` (configurado em `next-frontend/.env.local` e no `extra_hosts` do compose).

## 🧪 Testes

### Backend (Jest)

```bash
cd nestjs-project
docker compose exec nestjs-api npm test -- --runInBand   # unitários + integração
docker compose exec nestjs-api npm run test:e2e         # end-to-end (HTTP via supertest)
docker compose exec nestjs-api npm run test:cov         # cobertura
```

Sufixos: `*.spec.ts` (unitário), `*.integration-spec.ts` (integração com banco real/MinIO/Redis), `*.e2e-spec.ts` (end-to-end). Testes de integração/e2e rodam com `--runInBand`.

### Frontend (Vitest + Playwright)

```bash
cd next-frontend
docker compose exec next-frontend npm test              # unitários + integração (Vitest + MSW)
npx playwright test                                     # end-to-end (no host, com dev server em MSW_ENABLED=true)
```

Sufixos: `*.test.ts(x)` (unitário), `*.integration.test.ts(x)` (Route Handlers com MSW), `*.e2e-spec.ts` (Playwright). MSW intercepta as chamadas à API NestJS — os testes nunca batem no backend real.

## ✅ Funcionalidades implementadas

### Autenticação (Fase 02)

Fluxo completo de **cadastro → confirmação por e-mail → login → recuperação de senha**, com canal criado automaticamente para cada usuário (a partir do prefixo do e-mail).

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /auth/register` | Cadastro de usuário (cria usuário + canal) |
| `GET /auth/confirm-email?token=` | Confirmação de conta via link do e-mail |
| `POST /auth/resend-confirmation` | Reenvio do e-mail de confirmação |
| `POST /auth/login` | Login (retorna access + refresh token) |
| `POST /auth/refresh` | Rotação de refresh token (com family + grace period) |
| `POST /auth/logout` | Revoga os refresh tokens da sessão |
| `POST /auth/forgot-password` | Solicita e-mail de recuperação de senha |
| `GET /auth/reset-password?token=` | Validação de token de reset de senha |
| `POST /auth/reset-password` | Redefinição de senha |
| `GET /auth/me` | Dados do usuário autenticado (protegido por JWT) |

Telas e Route Handlers BFF (`next-frontend`):

- `/(auth)/signup`, `/(auth)/login`, `/(auth)/forgot-password` — formulários com React Hook Form + Zod e validação inline.
- `app/api/auth/{signup,login,logout,forgot-password}` — proxy same-origin para a API.

Segurança: senhas com **Argon2**, **JWT** com `JwtAuthGuard` global (opt-out via `@Public()`), **rotação de refresh token** com detecção de reuso, **rate limiting** (`ThrottlerGuard`) nos endpoints de auth, e sessão no navegador via **iron-session** (cookies HTTP-only).

---

### Upload e Processamento de Vídeos (Fase 03)

Fluxo completo de **upload multipart direto ao S3/MinIO**, **transcodificação assíncrona com FFmpeg**, **geração de playlists HLS adaptativas (360p-1080p)**, **extração de thumbnails** e **entrega de mídia autorizada**.

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /videos/uploads` | Inicia sessão multipart, gera `publicId` (128 bits URL-safe) e pré-cadastra vídeo |
| `GET /videos/uploads/:sessionId` | Consulta estado da sessão e partes confirmadas no storage |
| `POST /videos/uploads/:sessionId/part-urls` | Emite lote de URLs pré-assinadas para envio direto ao MinIO |
| `POST /videos/uploads/:sessionId/complete` | Finaliza multipart e agenda processamento atomicamente via Outbox |
| `DELETE /videos/uploads/:sessionId` | Cancela upload, remove partes pendentes e cancela vídeo |
| `GET /videos/:publicId/upload-status` | Polling de estado de processamento (`uploading`, `processing`, `ready`, `failed`) |
| `GET /videos/:publicId/playback/master` | Master playlist HLS (`application/vnd.apple.mpegurl`) |
| `GET /videos/:publicId/playback/:rendition` | Playlist variante com URLs dos segmentos `.ts` pré-assinadas dinamicamente |
| `GET /videos/:publicId/thumbnail` | Redirecionamento 302 para URL pré-assinada da thumbnail |
| `GET /videos/:publicId/download` | Redirecionamento 302 com `Content-Disposition: attachment` para o vídeo original |

Telas e Route Handlers BFF (`next-frontend`):

- `/studio/upload` — Workspace de upload com drag & drop, progresso em tempo real, detecção de upload interrompido e link de reprodução.
- `lib/uploads/` — Coordenador multipart cliente com persistência de progresso em **IndexedDB (`idb`)**, fatiamento em chunks de 5MB, concorrência limitada (máx. 3 partes simultâneas) e coleta de ETags.
- `app/api/videos/**` — Route Handlers BFF same-origin com `authenticatedFetch` e renovação transparente de tokens.

---

## 🛠️ Estrutura do Projeto

```
green-field-ia-project/
├── docs/
│   ├── project-plan.md                  # Planejamento geral do projeto
│   ├── phases/                          # Planos e implementação por fase
│   │   ├── phase-01-configuracao-base/
│   │   ├── phase-02-auth/               # Auth (backend)
│   │   ├── phase-02-auth-frontend/      # Auth (frontend)
│   │   └── phase-03-upload-processing/  # Upload e Transcodificação de Vídeos
│   └── diagrams/
│       └── software-arch.mermaid        # Diagrama de arquitetura (C4)
├── nestjs-project/                      # Backend API (NestJS 11)
│   ├── src/
│   │   ├── auth/                        # Cadastro, login, JWT, refresh, reset de senha
│   │   ├── users/                       # Entidade e serviço de usuários
│   │   ├── channels/                    # Canal 1:1 por usuário (nickname do e-mail)
│   │   ├── videos/                      # Entidades Video/UploadSession, controllers e delivery
│   │   ├── storage/                     # Adaptador S3MediaStorageService (multipart e presign)
│   │   ├── outbox/                      # OutboxEvent entity e OutboxRelayService (BullMQ dispatch)
│   │   ├── video-worker/                # FFmpegService e VideoProcessorService
│   │   ├── mail/                        # Envio de e-mails (templates Handlebars)
│   │   ├── common/                      # Filtros de exceção, pipes e exceptions de domínio
│   │   ├── config/                      # Configs namespaced com Joi (db, auth, storage, queue)
│   │   ├── database/                    # Data-source, migrations e seeds
│   │   ├── relay/                       # Bootstrap standalone do Outbox Relay
│   │   └── worker/                      # Bootstrap standalone do Video Worker
│   ├── test/                            # Testes e2e (auth, video-uploads, video-media, swagger)
│   ├── compose.yaml                     # Docker Compose (API + PostgreSQL + Redis + MinIO + Workers + Mailpit)
│   └── Dockerfile.dev
├── next-frontend/                       # Frontend (Next.js 16, App Router)
│   ├── app/                             # Rotas, layouts, páginas e Route Handlers BFF
│   │   ├── (auth)/                      # Telas de login, signup, forgot-password, reset-password
│   │   ├── (studio)/                    # Studio upload workspace (/studio/upload)
│   │   └── api/                         # Route handlers (/api/auth/**, /api/videos/**)
│   ├── components/                      # Componentes de auth, vídeos (VideoUploader) e UI (shadcn)
│   ├── lib/                             # env, api (openapi-fetch), auth/session, uploads (coordinator + idb)
│   ├── mocks/                           # MSW (handlers de auth, vídeos + server)
│   ├── tests/                           # E2E (Playwright)
│   ├── compose.yaml                     # Docker Compose (dev server)
│   └── Dockerfile.dev
├── CLAUDE.md                            # Instruções para IA
├── FC Tube.fig                          # Design system do projeto (Figma)
├── whiteboard.png                       # Quadro branco do projeto
└── README.md
```

## 📚 Fases do Projeto

| Fase | Descrição | Status |
|------|-----------|--------|
| **01** | Configuração Base do Projeto | ✅ Concluída |
| **02** | Cadastro, Login e Gerenciamento de Conta | ✅ Concluída |
| **03** | Upload e Processamento de Vídeos | ✅ Concluída |
| **04** | Gerenciamento de Vídeos e Canal | ⏳ Planejada |
| **05** | Página de Visualização do Vídeo | ⏳ Planejada |
| **06** | Interações Sociais (Likes, Comentários, Inscrições) | ⏳ Planejada |
| **07** | Página Inicial, Busca e Finalização | ⏳ Planejada |

Detalhes completos em `docs/project-plan.md`.

## 📖 Stack Tecnológica

| Camada | Tecnologia |
|--------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, React Hook Form + Zod, iron-session, openapi-fetch, IndexedDB (`idb`) |
| Backend | NestJS 11, TypeScript, TypeORM, JWT, Argon2, Mailer (Handlebars), AWS SDK S3 |
| Processamento & Filas | FFmpeg, BullMQ, Redis 7 |
| Object Storage | MinIO (S3-compatible) |
| Banco de Dados | PostgreSQL 17 |
| E-mail (dev) | Mailpit |
| Containerização | Docker, Docker Compose |
| Testes | Jest, Supertest (backend); Vitest, MSW, Playwright (frontend) |
| Qualidade | ESLint, Prettier |
</content>
