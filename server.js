const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

// Na Vercel, o Express é exportado como uma única Function.
// Em ambiente local, continuamos criando o servidor HTTP + Socket.IO.
let io = {
  to: () => ({ emit: () => {} }),
  on: () => {}
};
let localServer = null;

if (!process.env.VERCEL) {
  localServer = http.createServer(app);
  io = new Server(localServer);
}

const PORT = Number(process.env.PORT || 3000);
const HOTMART_HOTTOK = String(process.env.HOTMART_HOTTOK || "").trim();
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();

const DATA_DIR = process.env.VERCEL
  ? path.join("/tmp", "ranking-vendas-hotmart")
  : path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "sales.json");
const SELLERS_FILE = path.join(__dirname, "sellers.json");
const PRODUCTS_FILE = path.join(__dirname, "products.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function getSellers() {
  return readJson(SELLERS_FILE, []);
}

function getProducts() {
  return readJson(PRODUCTS_FILE, []);
}

function findProductConfig(payload) {
  const productId = String(payload?.data?.product?.id || "");
  const productUcode = String(payload?.data?.product?.ucode || "");
  const productName = String(payload?.data?.product?.name || "").trim().toLowerCase();

  return getProducts().find((item) => {
    const configuredId = String(item.productId || "");
    const configuredUcode = String(item.productUcode || "");
    const configuredName = String(item.name || "").trim().toLowerCase();

    return (
      (configuredId && configuredId === productId) ||
      (configuredUcode && configuredUcode === productUcode) ||
      (configuredName && configuredName === productName)
    );
  }) || null;
}

function producerCommission(payload) {
  const commissions = Array.isArray(payload?.data?.commissions)
    ? payload.data.commissions
    : [];

  const producerRows = commissions.filter(
    (item) => String(item?.source || "").toUpperCase() === "PRODUCER"
  );

  return producerRows.reduce((sum, item) => {
    const converted = Number(item?.currency_conversion?.converted_value);
    if (Number.isFinite(converted)) return sum + converted;

    const value = Number(item?.value);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function sellerCommission(payload, revenue) {
  const config = findProductConfig(payload);
  if (!config) return 0;

  const value = Number(config.sellerCommissionValue || 0);
  if (!Number.isFinite(value)) return 0;

  if (String(config.sellerCommissionType || "fixed").toLowerCase() === "percent") {
    return revenue * (value / 100);
  }

  return value;
}

function getSales() {
  return readJson(DB_FILE, []);
}

function saveSales(sales) {
  writeJsonAtomic(DB_FILE, sales);
}

function normalizeCode(value) {
  return String(value || "").trim().toLowerCase();
}

function getOriginCode(payload) {
  const purchase = payload?.data?.purchase || {};
  const candidate =
    purchase?.origin?.xcod ||
    purchase?.origin?.sck ||
    purchase?.origin?.src ||
    payload?.data?.tracking?.source_sck ||
    payload?.data?.tracking?.source ||
    "";

  if (candidate) return String(candidate);

  const affiliate = payload?.data?.affiliates?.[0];
  return affiliate?.affiliate_code || affiliate?.name || "";
}

function findSeller(payload) {
  const sellers = getSellers();
  const incoming = normalizeCode(getOriginCode(payload));

  if (!incoming) return null;

  return (
    sellers.find((seller) => normalizeCode(seller.code) === incoming) ||
    sellers.find((seller) => normalizeCode(seller.name) === incoming) ||
    null
  );
}

function moneyValue(obj) {
  const value = Number(obj?.value);
  return Number.isFinite(value) ? value : 0;
}

function hotmartCommission(payload) {
  const commissions = Array.isArray(payload?.data?.commissions)
    ? payload.data.commissions
    : [];

  // Soma o que a própria Hotmart informa como comissão ligada à conta.
  // MARKETPLACE não é contabilizado no valor exibido.
  return commissions
    .filter((item) =>
      ["PRODUCER", "COPRODUCER", "AFFILIATE", "ADDON"].includes(
        String(item?.source || "").toUpperCase()
      )
    )
    .reduce((sum, item) => {
      const converted = Number(item?.currency_conversion?.converted_value);
      if (Number.isFinite(converted)) return sum + converted;

      const value = Number(item?.value);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
}

function parseDate(payload) {
  const purchase = payload?.data?.purchase || {};
  const ts = Number(purchase.approved_date || payload.creation_date);
  if (Number.isFinite(ts) && ts > 0) return new Date(ts).toISOString();

  const orderDate = purchase.order_date;
  const asNumber = Number(orderDate);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    const ms = asNumber < 10_000_000_000 ? asNumber * 1000 : asNumber;
    return new Date(ms).toISOString();
  }

  return new Date().toISOString();
}

function buildSale(payload) {
  const seller = findSeller(payload);
  const purchase = payload?.data?.purchase || {};
  const product = payload?.data?.product || {};
  const revenue = moneyValue(purchase.full_price) || moneyValue(purchase.price);
  const companyCommission = producerCommission(payload);
  const internalSellerCommission = sellerCommission(payload, revenue);

  return {
    eventId: String(payload?.id || ""),
    transaction: String(purchase.transaction || payload?.id || ""),
    status: String(purchase.status || payload?.event || "APPROVED"),
    productId: String(product.id || ""),
    productUcode: String(product.ucode || ""),
    productName: String(product.name || "Produto Hotmart"),
    sellerId: seller?.id || "nao-identificado",
    sellerName: seller?.name || "Não identificado",
    sellerCode: seller?.code || getOriginCode(payload) || "",
    revenue,
    companyCommission,
    sellerCommission: internalSellerCommission,
    companyResult: companyCommission - internalSellerCommission,
    currency:
      purchase?.full_price?.currency_value ||
      purchase?.price?.currency_value ||
      payload?.data?.commissions?.[0]?.currency_value ||
      "BRL",
    approvedAt: parseDate(payload),
    event: String(payload?.event || "")
  };
}

function isApprovedEvent(payload) {
  const event = String(payload?.event || "").toUpperCase();
  const status = String(payload?.data?.purchase?.status || "").toUpperCase();
  return event === "PURCHASE_APPROVED" || status === "APPROVED";
}

function isReverseEvent(payload) {
  const event = String(payload?.event || "").toUpperCase();
  const status = String(payload?.data?.purchase?.status || "").toUpperCase();
  return (
    ["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_CANCELED"].includes(event) ||
    ["REFUNDED", "CHARGEBACK", "CANCELLED"].includes(status)
  );
}

function currentPeriod(sales, period = "today") {
  const now = new Date();
  const start = new Date(now);

  if (period === "today") {
    start.setHours(0, 0, 0, 0);
  } else if (period === "week") {
    const day = (now.getDay() + 6) % 7;
    start.setDate(now.getDate() - day);
    start.setHours(0, 0, 0, 0);
  } else if (period === "month") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  } else {
    return sales;
  }

  return sales.filter((sale) => new Date(sale.approvedAt) >= start);
}

function buildDashboard(period = "today") {
  const sellers = getSellers();
  const activeSales = getSales().filter((sale) => sale.status === "APPROVED");
  const sales = currentPeriod(activeSales, period);

  const ranking = sellers
    .map((seller) => {
      const sellerSales = sales.filter((sale) => sale.sellerId === seller.id);
      return {
        ...seller,
        sales: sellerSales.length,
        revenue: sellerSales.reduce((sum, sale) => sum + sale.revenue, 0),
        companyCommission: sellerSales.reduce((sum, sale) => sum + Number(sale.companyCommission || 0), 0),
        sellerCommission: sellerSales.reduce((sum, sale) => sum + Number(sale.sellerCommission || 0), 0),
        companyResult: sellerSales.reduce((sum, sale) => sum + Number(sale.companyResult || 0), 0),
        lastSaleAt: sellerSales[0]?.approvedAt || null
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.sales - a.sales);

  return {
    period,
    updatedAt: new Date().toISOString(),
    totals: {
      sales: sales.length,
      revenue: sales.reduce((sum, sale) => sum + sale.revenue, 0),
      companyCommission: sales.reduce((sum, sale) => sum + Number(sale.companyCommission || 0), 0),
      sellerCommission: sales.reduce((sum, sale) => sum + Number(sale.sellerCommission || 0), 0),
      companyResult: sales.reduce((sum, sale) => sum + Number(sale.companyResult || 0), 0)
    },
    ranking,
    recentSales: [...sales]
      .sort((a, b) => new Date(b.approvedAt) - new Date(a.approvedAt))
      .slice(0, 15)
  };
}

function broadcast() {
  for (const period of ["today", "week", "month"]) {
    io.to(`period:${period}`).emit("dashboard:update", buildDashboard(period));
  }
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    environment: process.env.VERCEL ? "vercel" : "local",
    hottokConfigured: Boolean(HOTMART_HOTTOK),
    now: new Date().toISOString()
  });
});

app.get("/webhook/hotmart", (_req, res) => {
  res.status(200).json({
    ok: true,
    message: "Endpoint Hotmart ativo. Use POST para enviar eventos."
  });
});

app.get("/api/dashboard", (req, res) => {
  const period = ["today", "week", "month"].includes(req.query.period)
    ? req.query.period
    : "today";
  res.json(buildDashboard(period));
});

app.post("/webhook/hotmart", (req, res) => {
  const incomingHottok = String(req.headers["x-hotmart-hottok"] || "").trim();

  if (HOTMART_HOTTOK && incomingHottok !== HOTMART_HOTTOK) {
    return res.status(401).json({ ok: false, error: "HOTTOK inválido." });
  }

  const payload = req.body || {};
  const transaction = String(payload?.data?.purchase?.transaction || payload?.id || "");

  if (!transaction) {
    return res.status(400).json({ ok: false, error: "Transação ausente." });
  }

  let sales = getSales();
  const index = sales.findIndex((item) => item.transaction === transaction);

  if (isReverseEvent(payload)) {
    if (index >= 0) {
      sales[index] = {
        ...sales[index],
        status: String(payload?.data?.purchase?.status || payload?.event || "REFUNDED"),
        reversedAt: new Date().toISOString()
      };
      saveSales(sales);
      broadcast();
    }
    return res.json({ ok: true, action: "reversed" });
  }

  if (!isApprovedEvent(payload)) {
    return res.json({ ok: true, action: "ignored" });
  }

  const sale = buildSale(payload);
  sale.status = "APPROVED";

  if (index >= 0) {
    sales[index] = { ...sales[index], ...sale };
  } else {
    sales.unshift(sale);
  }

  saveSales(sales);
  broadcast();

  return res.json({
    ok: true,
    action: index >= 0 ? "updated" : "created",
    seller: sale.sellerName
  });
});

// Endpoint de teste local / homologação.
app.post("/api/simulate-sale", (req, res) => {
  if (ADMIN_TOKEN && String(req.headers["x-admin-token"] || "") !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "ADMIN_TOKEN inválido." });
  }

  const sellers = getSellers();
  const seller = sellers.find((s) => s.id === req.body?.sellerId) || sellers[0];

  if (!seller) {
    return res.status(400).json({ ok: false, error: "Cadastre vendedores em sellers.json." });
  }

  const now = Date.now();
  const revenue = Number(req.body?.revenue || 147);
  const commission = Number(req.body?.commission || 120.5);
  const tx = `TEST-${now}`;

  const sale = {
    eventId: `TEST-EVENT-${now}`,
    transaction: tx,
    status: "APPROVED",
    productId: "TEST",
    productName: req.body?.productName || "Programador do Futuro",
    sellerId: seller.id,
    sellerName: seller.name,
    sellerCode: seller.code,
    revenue,
    companyCommission: revenue,
    sellerCommission: commission,
    companyResult: revenue - commission,
    currency: "BRL",
    approvedAt: new Date().toISOString(),
    event: "PURCHASE_APPROVED"
  };

  const sales = getSales();
  sales.unshift(sale);
  saveSales(sales);
  broadcast();

  res.json({ ok: true, sale });
});

if (!process.env.VERCEL) {
  io.on("connection", (socket) => {
    let currentRoom = "period:today";
    socket.join(currentRoom);

    socket.on("dashboard:period", (period) => {
      if (!["today", "week", "month"].includes(period)) return;
      socket.leave(currentRoom);
      currentRoom = `period:${period}`;
      socket.join(currentRoom);
      socket.emit("dashboard:update", buildDashboard(period));
    });
  });

  localServer.listen(PORT, () => {
    console.log(`Ranking Hotmart rodando em http://localhost:${PORT}`);
    console.log(`Webhook: http://localhost:${PORT}/webhook/hotmart`);
  });
}

// ESSENCIAL PARA VERCEL:
// a plataforma detecta server.js e transforma este Express app em uma Function.
module.exports = app;
