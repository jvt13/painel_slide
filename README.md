# Painel Slide (VisualLoop)

Sistema de gerenciamento de midia para painel de slides com grupos, campanhas e controle de acesso.

## Funcionalidades

- Upload e gerenciamento de campanhas por grupo
- Controle de usuarios com papeis `master`, `admin` e `group_user`
- Ordenacao de grupos no player
- Preview do player no painel admin
- Efeito de transicao global no player:
  - `fade`
  - `slide-left`
  - `zoom`
  - `flip`
- Escopo da transicao configuravel:
  - `all` (capas e campanhas)
  - `campaign` (somente campanhas)
  - `cover` (somente capas)

## Instalacao

1. Instale dependencias:
```bash
npm install
```

2. Inicie o servidor:
```bash
npm start
```

3. Acesse:
- Admin: `http://localhost:3000/admin`
- Player: `http://localhost:3000/player`

## Usuarios

### Tipos

- `master`: acesso total, incluindo console SQL
- `admin`: gestao administrativa sem console SQL
- `group_user`: acesso restrito ao proprio grupo

### Usuario padrao

- Usuario: `master`
- Senha: `admin123`

## Configuracao de transicao

No painel admin (master/admin), use a secao **Efeito de Transicao Global** para:

1. Escolher o efeito
2. Escolher o escopo de aplicacao
3. Visualizar o preview
4. Salvar

A configuracao e global e aplicada automaticamente no player, sem alterar a duracao individual dos slides.

## Desenvolvimento

Para ambiente de desenvolvimento:
```bash
npm run dev
```
