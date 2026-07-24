const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const HOTMART_HOTTOK = String(process.env.HOTMART_HOTTOK || "").trim();
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "sales.json");
const SELLERS_FILE = path.join(__dirname, "sellers.json");

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

  return {
    eventId: String(payload?.id || ""),
    transaction: String(purchase.transaction || payload?.id || ""),
    status: String(purchase.status || payload?.event || "APPROVED"),
    productId: String(product.id || ""),
    productName: String(product.name || "Produto Hotmart"),
    sellerId: seller?.id || "nao-identificado",
    sellerName: seller?.name || "Não identificado",
    sellerCode: seller?.code || getOriginCode(payload) || "",
    revenue: moneyValue(purchase.full_price) || moneyValue(purchase.price),
    commission: hotmartCommission(payload),
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
        commission: sellerSales.reduce((sum, sale) => sum + sale.commission, 0),
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
      commission: sales.reduce((sum, sale) => sum + sale.commission, 0)
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
  res.json({ ok: true, now: new Date().toISOString() });
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
    commission,
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

server.listen(PORT, () => {
  console.log(`Ranking Hotmart rodando em http://localhost:${PORT}`);
  console.log(`Webhook: http://localhost:${PORT}/webhook/hotmart`);
});
