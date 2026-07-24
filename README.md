# Ranking de Vendas Hotmart

Dashboard em tempo real para 3 vendedores, conectado à Hotmart via Webhook.

## O que já está pronto

- Ranking dos 3 colaboradores.
- Faturamento em tempo real.
- Quantidade de vendas aprovadas.
- Produto vendido.
- Comissão recebida informada pela Hotmart.
- Últimas vendas.
- Filtros Hoje / Semana / Mês.
- Atualização instantânea com Socket.IO.
- Validação do header `X-HOTMART-HOTTOK`.
- Evita duplicação pelo código da transação.
- Remove do total vendas reembolsadas, canceladas e chargebacks.
- Endpoint para simular vendas durante a implantação.

## 1. Editar os vendedores

Abra `sellers.json`:

```json
[
  { "id": "vendedor-1", "name": "João", "code": "JOAO" },
  { "id": "vendedor-2", "name": "Maria", "code": "MARIA" },
  { "id": "vendedor-3", "name": "Pedro", "code": "PEDRO" }
]
```

O `code` precisa ser único.

## 2. Como atribuir cada venda ao vendedor

A forma recomendada neste projeto é usar um código único no `xcod` do link enviado por cada vendedor.

Exemplo conceitual:

- João usa `JOAO`
- Maria usa `MARIA`
- Pedro usa `PEDRO`

O webhook da Hotmart v2.0.0 pode trazer esse valor em `data.purchase.origin.xcod`.

O projeto também tenta reconhecer afiliado por `affiliate_code` ou nome quando esse dado estiver presente.

## 3. Configuração local

```bash
cp .env.example .env
npm install
npm start
```

Abra:

`http://localhost:3000`

## 4. Webhook da Hotmart

Depois que o app estiver publicado com HTTPS, cadastre na Hotmart:

`https://SEU-DOMINIO.com/webhook/hotmart`

Evento principal:

`PURCHASE_APPROVED`

Também é recomendado cadastrar:

- `PURCHASE_REFUNDED`
- `PURCHASE_CHARGEBACK`
- `PURCHASE_CANCELED`

Assim o painel retira vendas estornadas do faturamento/ranking.

Use Webhook versão `2.0.0`.

## 5. HOTTOK

No `.env`:

```env
HOTMART_HOTTOK=SEU_TOKEN
```

A aplicação compara esse valor com o header `X-HOTMART-HOTTOK` enviado pela Hotmart.

## 6. Testar sem venda real

Com o servidor aberto:

```bash
curl -X POST http://localhost:3000/api/simulate-sale \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: troque-este-token" \
  -d '{
    "sellerId":"vendedor-1",
    "productName":"Programador do Futuro",
    "revenue":147,
    "commission":120.50
  }'
```

A venda aparece instantaneamente na tela.

## Hospedagem

Esse projeto roda em qualquer host Node.js que exponha HTTPS e permita conexões WebSocket.

Para uso operacional contínuo, recomenda-se trocar o armazenamento JSON por PostgreSQL antes de escalar para muitas transações simultâneas.


## Comissão dos 4 produtos

Edite `products.json`.

Exemplo de comissão fixa de R$ 20,00 por venda:

```json
{
  "productId": "123456",
  "name": "Produto X",
  "sellerCommissionType": "fixed",
  "sellerCommissionValue": 20
}
```

Exemplo de comissão percentual de 10%:

```json
{
  "productId": "123456",
  "name": "Produto X",
  "sellerCommissionType": "percent",
  "sellerCommissionValue": 10
}
```

O dashboard separa:

- Faturamento do Comercial Atual: valor total pago pelo comprador.
- Comissão da Empresa: linha `PRODUCER` enviada pela Hotmart.
- Comissão do Vendedor: regra interna de `products.json`.
- Resultado da Empresa: Comissão da Empresa menos Comissão do Vendedor.
