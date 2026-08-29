---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-08-26
scope_description: "Infraestrutura S3/MinIO, upload resiliente de vídeos grandes, processamento assíncrono e entrega de mídia para a Fase 03."
---

# Decisões Técnicas — Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — cria e mantém o estado do vídeo, assina operações S3/MinIO, publica e consome jobs, e processa mídia com FFmpeg em um worker separado.
- `next-frontend/` — negocia o upload pelo BFF e envia as partes diretamente ao object storage; consome os contratos de progresso, estado e reprodução sem chamar o NestJS pelo navegador.

---

## TD-01: Identificador público imutável para URL de vídeo

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** O vídeo precisa ganhar uma URL já no pré-cadastro, antes de haver título definitivo. A Fase 04 permitirá editar título e visibilidade; portanto, a URL não pode depender de título, nome de arquivo nem da chave interna do object storage.

**Options:**

### Option A: ID numérico sequencial do banco na URL
- A rota pública usaria diretamente a chave primária do vídeo, por exemplo `/v/4812`.
- **Pros:** nenhuma geração adicional e índice já existente.
- **Cons:** URLs enumeráveis, acoplamento do contrato público ao banco e nenhuma proteção contra inferência de volume ou conteúdo ainda não publicado.

### Option B: `publicId` opaco, aleatório e imutável
- O pré-cadastro gera um identificador URL-safe criptograficamente aleatório, com índice `UNIQUE`, e a URL canônica passa a ser `/v/{publicId}`.
- **Pros:** não depende de título, não expõe a chave interna, preserva a URL após edições e permite usar o mesmo identificador no prefixo de mídia e nos jobs.
- **Cons:** exige uma coluna adicional, tratamento extremamente raro de colisão e uma URL menos descritiva sem um slug opcional futuro.

### Option C: Slug derivado do título com sufixo de colisão
- A URL usaria o título normalizado, acrescentando `-2`, `-3` e assim por diante quando necessário.
- **Pros:** URL legível e potencialmente favorável a SEO.
- **Cons:** o título ainda não existe no início do upload, renomes quebram ou complicam a URL e a regra de colisão é concorrente e mutável.

**Recommendation:** **Option B (`publicId` opaco e imutável)** — satisfaz unicidade desde o rascunho, mantém a URL estável quando o vídeo for editado e evita que o contrato público dependa de detalhes internos ou do título.

**Decision:** _Option B_

---

## TD-02: Contrato de upload resiliente para S3/MinIO

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Fazer o corpo de até 10GB atravessar Next.js ou NestJS consumiria conexões, memória e banda dos serviços de aplicação. Ao mesmo tempo, a retomada após queda de conexão precisa preservar o rascunho e as partes já transferidas. O BFF estrito existente continua sendo o único caminho navegador → NestJS; o acesso direto permitido aqui é somente às URLs temporárias do object storage, caso já antecipado em `next-frontend-config-base/TD-03`.

**Options:**

### Option A: Multipart S3 direto do navegador com URLs pré-assinadas
- O upload usa o multipart nativo do S3, mas o navegador não recebe credenciais S3/MinIO. A aplicação mantém o papel de **control plane** e o object storage mantém o papel de **data plane**:
  1. O Client Component chama um Route Handler same-origin para criar a sessão. O BFF chama o NestJS, que autoriza o usuário, cria o vídeo como rascunho, escolhe uma chave de objeto que não muda durante a sessão e inicia o multipart, obtendo o `uploadId` interno do storage.
  2. Para cada lote de partes, o BFF pede ao NestJS URLs pré-assinadas. O NestJS verifica que a sessão pertence ao usuário e assina somente as partes solicitadas, com expiração curta e para uma operação/objeto específicos. O lote evita assinar antecipadamente milhares de URLs para um arquivo de 10GB.
  3. O navegador divide o `File` em partes e faz `PUT` diretamente para o endpoint S3/MinIO usando essas URLs. Os bytes não passam pelo Next.js nem pelo NestJS. As partes podem ser enviadas em paralelo; uma falha retransmite apenas a parte afetada.
  4. Cada `PUT` bem-sucedido devolve um `ETag`. O cliente associa esse valor ao `partNumber` e o persiste no IndexedDB junto ao identificador da sessão e à impressão do arquivo. O BFF/NestJS também pode consultar `ListParts` para reconciliar o estado, portanto a retomada não depende exclusivamente da memória da aba.
  5. Ao terminar, o navegador envia ao Route Handler a lista ordenada de pares `partNumber`/`ETag`. O BFF encaminha a solicitação ao NestJS, que valida a sessão, chama `CompleteMultipartUpload`, confirma que o objeto final existe e só então avança o rascunho para o estado de upload concluído. Cancelamento explícito chama `AbortMultipartUpload`.
- Se a conexão cair, o vídeo continua sendo um rascunho e o multipart continua retendo as partes aceitas pelo storage. Ao retomar, o cliente consulta o estado da sessão, reaproveita as partes confirmadas, solicita novas assinaturas para as partes pendentes ou expiradas e envia apenas o que falta. Se uma sessão for perdida ou ficar abandonada, o lifecycle do bucket deve abortá-la após o prazo definido.
- O tamanho da parte é um parâmetro de implementação (respeitando o mínimo de 5 MiB para partes não finais e o limite de 10.000 partes). A concorrência e o tamanho devem ser limitados no cliente para não saturar a rede; eles não alteram o fato de que a aplicação não transporta o conteúdo do vídeo.
- **Pros:** remove os bytes grandes da aplicação, usa o protocolo nativo e portável de S3/MinIO, permite paralelismo e retransmissão por parte, e preserva o modelo BFF para a API de negócio.
- **Cons:** exige CORS preciso no bucket, persistência do estado da sessão e dos ETags, reconciliação entre cliente e storage e limpeza de multipart abandonado.

#### CORS no fluxo da Option A

CORS é necessário porque o upload tem dois origins diferentes:

- **Navegador → Next.js BFF:** é same-origin (`/api/...`), portanto não exige CORS.
- **Navegador → S3/MinIO:** é cross-origin, porque a URL pré-assinada aponta para o endpoint do storage. Esse salto exige uma regra CORS no bucket ou no endpoint que efetivamente recebe o `PUT`.

A URL pré-assinada resolve **autorização** do request no storage; ela não desativa a política de segurança do navegador. CORS resolve apenas se um origin web específico pode realizar a chamada cross-origin e ler sua resposta. Assim, um request pode ser aceito pelo S3/MinIO e ainda assim o JavaScript não conseguir ler o `ETag` se a resposta não contiver os cabeçalhos CORS corretos — e sem o `ETag` o multipart não pode ser completado.

A regra deve ser uma allowlist dos origins reais do frontend, com esquema e porta exatos (por exemplo, o origin local e o origin de produção), e não `*`. Ela deve:

- permitir `PUT` para as partes — e somente `POST` se a implementação também usar POST direto;
- permitir os headers que o cliente realmente envia ou que foram incluídos na assinatura, como `Content-Type`, `Content-MD5` e/ou headers `x-amz-*` de checksum;
- expor `ETag` para que o código do navegador consiga lê-lo; se checksums forem usados, expor também os headers de checksum correspondentes;
- responder corretamente ao preflight `OPTIONS` e definir um `MaxAgeSeconds` razoável para evitar preflights repetidos durante a sessão.

Um exemplo conceitual (os origins e headers devem ser derivados dos ambientes e da implementação) é:

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:<next-port>",
      "https://app.example.com"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "Content-MD5", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Essa configuração não torna o bucket público e não concede permissão a quem não possui uma URL pré-assinada válida. Também não substitui autenticação/autorização: CORS não deve ser tratado como mecanismo de segurança. Em produção, os origins permitidos devem ser específicos; em desenvolvimento, `localhost` e `127.0.0.1` são origins diferentes e precisam ser listados separadamente se ambos forem usados.

### Option B: Protocolo tus com serviço dedicado (`tusd`) e backend S3
- O navegador usa um cliente tus para enviar e retomar o arquivo contra um servidor tus, que persiste o resultado no object storage.
- **Pros:** protocolo de retomada pronto, inclusive entre sessões do navegador, e cliente maduro para progresso e retries.
- **Cons:** adiciona e opera outro serviço permanente, cria um segundo contrato de autenticação/autorização e exige integração extra para reconciliar criação do rascunho, término do tus e disparo do processamento.

### Option C: Proxy de streaming/multipart pelo BFF ou NestJS
- O navegador envia o arquivo para uma Route Handler ou controller e a aplicação encaminha o fluxo ao storage.
- **Pros:** um único origin para o navegador e menor configuração de CORS no storage.
- **Cons:** os 10GB atravessam a camada de aplicação, elevando custo e risco de timeout/esgotamento de conexões; contradiz o requisito de não impactar a performance do sistema.

**Recommendation:** **Option A (multipart S3 direto, orquestrado pelo BFF/NestJS)** — é a opção que usa o object storage como data plane, conserva a aplicação como control plane e recupera somente as partes faltantes após falhas. As credenciais de storage nunca chegam ao navegador; as URLs pré-assinadas têm escopo e expiração curtos. O CORS é uma configuração de integração do endpoint de upload, restrita aos origins do frontend, e não uma abertura pública do bucket. Configurar uma regra de lifecycle para abortar multiparts incompletos é parte obrigatória da infraestrutura.

**Decision:** _Option A_

---

## TD-03: Broker de fila e isolamento do worker de vídeo

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** FFmpeg é CPU e I/O intensivo e não deve dividir o processo HTTP do NestJS. A fila deve transportar referências pequenas (`videoId`, chave do objeto e versão), nunca o arquivo, e permitir limite de concorrência, retry e escala independente do worker.

**Options:**

### Option A: BullMQ + Redis, com `video-worker` em container/processo separado
- O backend usa `@nestjs/bullmq` e BullMQ sobre Redis; a imagem da aplicação executa um comando de worker separado para consumir a fila de processamento.
- **Pros:** integração oficial com NestJS 11, retries/backoff/concurrency prontos, operação simples em Docker Compose e possibilidade de escalar workers sem escalar a API.
- **Cons:** introduz Redis e requer persistência/monitoramento adequados; a semântica é ao menos uma vez, portanto o handler precisa ser idempotente.

### Option B: RabbitMQ com consumidores AMQP dedicados
- Um broker AMQP recebe o evento de upload concluído e workers consomem mensagens com acknowledgements manuais.
- **Pros:** broker generalista, roteamento rico e boa base para consumidores poliglotas ou integrações futuras.
- **Cons:** maior custo operacional e de integração no NestJS para um único pipeline; retry, DLQ e limites de processamento exigem mais convenções da aplicação.

### Option C: pg-boss sobre o PostgreSQL existente
- Os jobs e locks ficam no PostgreSQL, evitando um serviço Redis separado.
- **Pros:** menos infraestrutura e transações próximas do estado do vídeo.
- **Cons:** mistura a carga de controle de jobs com o banco transacional; workers de vídeo longos e retries competem com usuários, vídeos e catálogo no mesmo serviço que já é crítico.

**Recommendation:** **Option A (BullMQ + Redis + worker separado)** — o projeto ganha um mecanismo de fila e controle de concorrência apropriado ao processamento pesado sem expor a API HTTP a contenção de FFmpeg. O `video-worker` deve ser escalável e limitado pelo recurso mais restritivo do host, não pelo número de requisições da API.

**Decision:** _Option A_

---

## TD-04: Garantia de despacho e idempotência do processamento

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** PostgreSQL e Redis não participam de uma transação distribuída. Publicar um job após mudar o vídeo para `uploaded` pode perder o processamento em uma falha entre as duas operações; publicar antes do commit pode fazer o worker encontrar um vídeo ainda inexistente. Reentregas também são esperadas após falha do worker.

**Options:**

### Option A: Outbox transacional no PostgreSQL + relay para a fila
- A mesma transação que confirma o upload atualiza o estado do vídeo e grava um evento de outbox. Um relay entrega o evento ao BullMQ e registra o despacho; o worker usa transições idempotentes por `videoId`.
- **Pros:** não perde o evento no intervalo entre banco e broker, fornece auditoria/reprocessamento e torna o fluxo explicitamente ao menos uma vez com efeitos finais idempotentes.
- **Cons:** cria tabela, relay e observabilidade adicionais; duplicatas são possíveis e precisam ser tratadas pelo estado do vídeo.

### Option B: Publicar após o commit e reconciliar periodicamente
- A API enfileira logo após confirmar o upload e um job agendado procura vídeos `uploaded` sem processamento para corrigir falhas.
- **Pros:** implementação inicial menor e ainda oferece recuperação eventual.
- **Cons:** há uma janela real em que o vídeo fica parado até a reconciliação, e dois mecanismos independentes precisam manter o mesmo critério de elegibilidade.

### Option C: Tratar o job BullMQ como fonte de verdade
- O estado do vídeo seria inferido apenas da presença ou do resultado do job no Redis.
- **Pros:** menos tabelas no PostgreSQL.
- **Cons:** o catálogo perde sua fonte durável e consultável de estado; expiração, limpeza ou indisponibilidade do broker podem tornar vídeos órfãos.

**Recommendation:** **Option A (outbox transacional e worker idempotente)** — o processamento de um upload concluído é parte central do produto e merece a garantia de não perder o gatilho. A fila continua sendo mecanismo de execução; PostgreSQL permanece fonte de verdade do estado do vídeo.

**Decision:** _Option A_

---

## TD-05: Derivados de mídia e protocolo de entrega

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Geração automática de thumbnail a partir de um frame do vídeo", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** O objeto enviado é a fonte de processamento, não necessariamente o melhor formato para reprodução. A escolha precisa separar o original destinado a download dos derivados destinados a streaming, thumbnails e futuras regras de visibilidade, sem transformar a API em proxy dos bytes de mídia.

**Options:**

### Option A: Servir apenas o arquivo original por HTTP Range
- O worker extrai metadados e thumbnail, mas mantém o mesmo arquivo como única fonte de reprodução e download.
- **Pros:** pipeline e armazenamento mínimos; browsers podem buscar faixas de um MP4 compatível.
- **Cons:** sem adaptação de bitrate, qualidade e compatibilidade dependentes do upload do usuário e maior chance de buffering em redes variáveis.

### Option B: Gerar HLS VOD, thumbnail e preservar o original para download
- O worker produz manifestos e segmentos HLS para reprodução, uma thumbnail derivada e conserva o original em prefixo privado para download. A camada de entrega emite URLs temporárias ou redirects assinados ao object storage, sem retransmitir os bytes pela API.
- **Pros:** streaming HTTP segmentado e adaptável, separa download do formato de playback e mantém S3/MinIO como servidor de mídia escalável.
- **Cons:** mais CPU, armazenamento e estados de processamento; o player posterior precisará suportar HLS fora dos ambientes com suporte nativo.

### Option C: Terceirizar transcodificação e entrega a uma plataforma de vídeo
- O upload, as rendições e o player seriam delegados a um fornecedor de vídeo gerenciado.
- **Pros:** reduz trabalho operacional de codecs, rendições e distribuição.
- **Cons:** contradiz o object storage S3/MinIO como base escolhida, aumenta custo recorrente e cria dependência de fornecedor antes de existir necessidade de escala global.

**Recommendation:** **Option B (HLS VOD + thumbnail + original preservado)** — entrega streaming sem download completo sobre HTTP/object storage, permite adaptação a redes variáveis e preserva o arquivo original para a capacidade explícita de download. A definição de resoluções, codecs e player é parâmetro de implementação, não uma decisão desta pesquisa.

**Decision:** _Option B_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Cross-layer | Identificador público e URL canônica | `publicId` opaco e imutável | _Option B_ |
| TD-02 | Cross-layer | Upload resiliente | Multipart S3 direto com URLs pré-assinadas | _Option A_ |
| TD-03 | Backend | Broker e worker de vídeo | BullMQ + Redis + worker separado | _Option A_ |
| TD-04 | Backend | Garantia de despacho | Outbox transacional + worker idempotente | _Option A_ |
| TD-05 | Cross-layer | Derivados e entrega de mídia | HLS VOD + thumbnail + original | _Option B_ |

## Fontes consultadas

- [AWS S3 — multipart upload overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) — partes paralelas, reenvio de parte falha e ETags necessários para completar o objeto.
- [AWS S3 — limites de multipart](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) — partes de 5 MiB a 5 GiB e até 10.000 partes, compatível com arquivos de 10GB.
- [AWS S3 — limpeza de multiparts incompletos](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html) — lifecycle para abortar e remover partes abandonadas.
- [NestJS BullMQ integration](https://github.com/nestjs/bull/blob/master/README.md) — integração oficial de `@nestjs/bullmq` com NestJS.
- [BullMQ — idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs) e [retries/backoff](https://docs.bullmq.io/guide/retrying-failing-jobs) — retries exigem handlers idempotentes e podem usar backoff.
- [tus-js-client — retomada entre sessões](https://github.com/tus/tus-js-client/blob/main/docs/usage.md) — alternativa baseada em protocolo especializado de upload retomável.
- [RabbitMQ — work queues](https://www.rabbitmq.com/tutorials/tutorial-two-javascript) — acknowledgements e redelivery de tarefas após queda do consumidor.
- [pg-boss — filas](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md) — alternativa baseada em PostgreSQL, com retries, heartbeat e dead letter queue.
- [Apple — HTTP Live Streaming](https://developer.apple.com/documentation/http-live-streaming) — streaming VOD sobre HTTP e adaptação de bitrate.
