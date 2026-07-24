# CORREÇÃO PARA VERCEL

Esta versão exporta o Express app com `module.exports = app`, permitindo que a Vercel reconheça `server.js` como backend.

## Depois de subir no GitHub

1. Substitua os arquivos atuais pelos arquivos desta pasta.
2. Faça commit.
3. A Vercel deve criar um deployment automaticamente.
4. Teste no navegador:
   - `/health`
   - `/webhook/hotmart`
5. Depois reenvie o teste na Hotmart para:
   - `https://rankingdevendas-grupo-pestana.vercel.app/webhook/hotmart`

## Atenção

Na Vercel esta versão usa `/tmp` para não falhar ao receber o webhook.
Esse armazenamento é temporário e NÃO deve ser usado como banco definitivo de vendas.
A próxima etapa, depois de confirmar HTTP 200 na Hotmart, é ligar um banco persistente.
