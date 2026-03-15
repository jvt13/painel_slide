# Painel Slide

Sistema de painel de midias com campanhas, capas por grupo, upload de imagens e player web.

## Banco SQLite

O sistema usa SQLite e foi ajustado para funcionar bem em atualizacoes via `.exe`.

Comportamento atual:

- se o banco **nao existir**, ele e criado automaticamente
- se o banco **ja existir**, os dados atuais **nao sao apagados**
- se a versao nova precisar de colunas, tabelas ou ajustes de estrutura, o sistema aplica **migracoes incrementais**
- antes de migrar um banco ja existente, o sistema cria um **backup automatico** no mesmo diretorio do banco

Arquivos importantes:

- banco padrao: `src/data/painel.sqlite`
- backups automaticos: `src/data/painel.backup-vX-to-vY-*.sqlite`

## Atualizando em outro computador

Para levar uma nova versao do `.exe` para outra maquina:

1. copie apenas o executavel novo
2. mantenha a pasta `src/data` da maquina destino
3. ao iniciar, o sistema detecta o banco existente e adapta somente a estrutura necessaria
4. os dados ja cadastrados continuam no banco da maquina

Em outras palavras: **nao e necessario enviar um banco novo para atualizar o sistema**.

## Migracoes automaticas

O controle de versao do schema fica no proprio banco, na tabela:

- `schema_migrations`

O sistema hoje aplica migracoes para:

- criacao da estrutura base
- ordenacao de grupos
- protecao e autoria de slides
- relacao de slides com campanhas
- compatibilidade de usuarios com papel `admin`
- identificacao de campanhas da automacao da API

## Observacoes

- campanhas criadas pela rota da API de automacao ficam marcadas como automacao
- campanhas antigas com nome iniciando em `fluxo` tambem sao reconhecidas como automacao
- o banco continua podendo ser definido por `DB_PATH`, se necessario
