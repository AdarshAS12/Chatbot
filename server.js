const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const CATALOG_ID = process.env.CATALOG_ID;
const CATALOG_API = process.env.CATALOG_API;

let users = {};
let catalogCache = {};
let catalogLoaded = false;
const processedMessages = new Set();

/////////////////////////////////////////////////////
// LOGGING HELPER
/////////////////////////////////////////////////////
function log(type, label, data) {
  const ist = getISTDate();
  const time = ist.toLocaleTimeString("en-IN", { hour12: true });
  const icons = { IN: "📩", OUT: "📤", API: "🌐", ERROR: "❌", INFO: "ℹ️", SESSION: "⏱️" };
  const icon = icons[type] || "•";
  console.log(`\n${icon} [${time}] ${label}`);
  if (data) console.log(JSON.stringify(data, null, 2));
  console.log("─".repeat(50));
}

/////////////////////////////////////////////////////
// IST TIME HELPERS
/////////////////////////////////////////////////////
function getISTDate() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + istOffset);
}

function getTodayIST() {
  const ist = getISTDate();
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getISTHour() {
  return getISTDate().getUTCHours();
}

/////////////////////////////////////////////////////
// SESSION TIMEOUT — 10 minutes inactivity
/////////////////////////////////////////////////////
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

async function checkAndExpireSession(from) {
  const user = users[from];
  if (!user || !user.step || user.step === "START") return false;
  if (!user.lastActivity) return false;

  const inactive = Date.now() - user.lastActivity;

  if (inactive >= SESSION_TIMEOUT_MS) {
    log("SESSION", `Session expired for ${from}`, {
      lastStep: user.step,
      inactiveMinutes: Math.floor(inactive / 60000)
    });
    delete users[from];
    await sendText(
      from,
      "⏰ *Session Expired!*\n\nYour order session timed out due to 10 minutes of inactivity.\n\nType *Hi* to start a new order anytime 😊"
    );
    return true;
  }
  return false;
}

// Auto-cleanup every 2 minutes
setInterval(async () => {
  const now = Date.now();
  for (const from of Object.keys(users)) {
    const user = users[from];
    if (!user.step || user.step === "START") continue;
    if (!user.lastActivity) continue;
    const inactive = now - user.lastActivity;
    if (inactive >= SESSION_TIMEOUT_MS) {
      log("SESSION", `Auto-expiring session for ${from}`, { lastStep: user.step });
      delete users[from];
      try {
        await sendText(
          from,
          "⏰ *Session Expired!*\n\nYour order session timed out due to 10 minutes of inactivity.\n\nType *Hi* to start a new order anytime 😊"
        );
      } catch (e) {
        log("ERROR", "Failed to send expiry message", { error: e.message });
      }
    }
  }
}, 2 * 60 * 1000);

/////////////////////////////////////////////////////
// PREVENT DUPLICATES
/////////////////////////////////////////////////////
setInterval(() => {
  processedMessages.clear();
  log("INFO", "Cleared processed messages cache");
}, 600000);

/////////////////////////////////////////////////////
// LOAD CATALOG FROM CATALOG API
/////////////////////////////////////////////////////
async function loadCatalog() {
  try {
    const res = await axios.get(CATALOG_API);
    const raw = res.data;
    const products = raw.catalog || raw.data || raw.products || (Array.isArray(raw) ? raw : []);

    catalogCache = {};

    products.forEach(p => {
      const uuid         = p.id;
      const name         = p.title || "Cake";
      const eggPrice     = p.per_kg_price || 0;
      const egglessPrice = p.per_kg_eggless_price || 0;
      const salePrice    = p.sale_price || 0;

      if (eggPrice > 0) {
        catalogCache[`${uuid}_EGG`] = {
          itemId:      uuid,
          name,
          basePrice:   eggPrice,
          salePrice,
          dietaryType: "EGG"
        };
      }

      if (egglessPrice > 0) {
        catalogCache[`${uuid}_EGGLESS`] = {
          itemId:      uuid,
          name,
          basePrice:   egglessPrice,
          salePrice,
          dietaryType: "EGGLESS"
        };
      }

      catalogCache[uuid] = {
        itemId:      uuid,
        name,
        basePrice:   eggPrice || egglessPrice,
        salePrice,
        dietaryType: eggPrice > 0 ? "EGG" : "EGGLESS"
      };
    });

    catalogLoaded = Object.keys(catalogCache).length > 0;

    log("INFO", "Catalog loaded from API", {
      productCount: products.length,
      variantCount: Object.keys(catalogCache).length
    });
  } catch (err) {
    catalogLoaded = false;
    log("ERROR", "Catalog load failed", { error: err.response?.data || err.message });
  }
}

loadCatalog();
setInterval(loadCatalog, 600000);

/////////////////////////////////////////////////////
// CATALOGUE CSV ENDPOINT
/////////////////////////////////////////////////////
app.get("/catalogue.csv", async (req, res) => {
  try {
    const response = await axios.get(CATALOG_API);
    const raw = response.data;
    const products = raw.catalog || raw.data || raw.products || (Array.isArray(raw) ? raw : []);

    log("INFO", `Catalogue API loaded ${products.length} products`);

    const csvHeader = [
      "id", "title", "description", "availability", "condition",
      "price", "link", "image_link", "brand", "sale_price",
      "item_group_id", "material", "product_type"
    ].join(",");

    const csvRows = [];

    products.forEach(product => {
      const uuid         = product.id;
      const title        = (product.title || "").replace(/"/g, "'");
      const desc         = (product.description || product.title || "").replace(/"/g, "'");
      const link         = product.website_link || "https://xspine.in";
      const image        = product.image_link || "";
      const avail        = product.availability || "in stock";
      const eggPrice     = product.per_kg_price || 0;
      const egglessPrice = product.per_kg_eggless_price || 0;
      const category     = product.category?.name || "General Cakes";

      if (eggPrice > 0) {
        csvRows.push([
          `${uuid}_EGG`, `"${title}"`, `"${desc}"`, avail, "new",
          `${eggPrice}.00 INR`, link, image, '"Anumod Bakery"',
          "", uuid, "EGG", `"${category}"`
        ].join(","));
      }

      if (egglessPrice > 0) {
        csvRows.push([
          `${uuid}_EGGLESS`, `"${title}"`, `"${desc}"`, avail, "new",
          `${egglessPrice}.00 INR`, link, image, '"Anumod Bakery"',
          "", uuid, "EGGLESS", `"${category}"`
        ].join(","));
      }
    });

    const csv = [csvHeader, ...csvRows].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=catalogue.csv");
    res.send(csv);

    log("INFO", `Catalogue CSV served: ${csvRows.length} rows`);

  } catch (err) {
    log("ERROR", "Catalogue CSV error", { error: err.response?.data || err.message });
    res.status(500).send("Error generating catalogue CSV");
  }
});

/////////////////////////////////////////////////////
// REFRESH CATALOG ENDPOINT
/////////////////////////////////////////////////////
app.get("/refresh-catalog", async (req, res) => {
  await loadCatalog();
  res.json({
    success: true,
    products: Object.keys(catalogCache).length,
    message: "Catalog refreshed successfully"
  });
});

/////////////////////////////////////////////////////
// VERIFY WEBHOOK
/////////////////////////////////////////////////////
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    log("INFO", "Webhook verified by Meta ✅");
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/////////////////////////////////////////////////////
// MAIN WEBHOOK
/////////////////////////////////////////////////////
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (!message) return res.sendStatus(200);

    if (processedMessages.has(message.id)) {
      log("INFO", "Duplicate message ignored", { messageId: message.id });
      return res.sendStatus(200);
    }
    processedMessages.add(message.id);

    const from = message.from;
    const contactName = entry?.contacts?.[0]?.profile?.name || "Unknown";

    log("IN", `Message from ${contactName} (${from})`, {
      type: message.type,
      content:
        message.type === "text" ? message.text.body :
        message.type === "order" ? `Order with ${message.order.product_items.length} item(s)` :
        message.type === "interactive" ?
          (message.interactive.button_reply?.id || message.interactive.list_reply?.id) :
        message.type
    });

    if (!users[from]) users[from] = {};

    const expired = await checkAndExpireSession(from);
    if (expired) return res.sendStatus(200);

    if (users[from].step && users[from].step !== "START") {
      users[from].lastActivity = Date.now();
    }

    /////////////////////////////////////////////////////
    // TEXT MESSAGES
    /////////////////////////////////////////////////////
    if (message.type === "text") {
      const rawText = message.text.body.trim();
      const lowerText = rawText.toLowerCase();

      const normalizedText = lowerText
        .replace(/h+i+i*/g, "hi")
        .replace(/h+a+i+/g, "hai")
        .replace(/h+e+l+l*o*/g, "hello")
        .replace(/i+/g, "i")
        .replace(/a+/g, "a")
        .replace(/o+/g, "o");

      const greetings = ["hi", "hello", "hai", "start", "menu", "helo"];

      // ── GREETING ──────────────────────────────────────
      if (greetings.includes(normalizedText)) {
        if (
          users[from].step &&
          users[from].step !== "START" &&
          users[from].step !== "CONFIRM"
        ) {
          log("INFO", `Mid-order Hi attempt by ${contactName}`, { currentStep: users[from].step });
          await sendText(
            from,
            "⚠️ You have an order in progress!\n\nType *cancel* to cancel your current order and start a new one, or continue with your current order 😊"
          );
          return res.sendStatus(200);
        }

        if (!catalogLoaded) {
          log("INFO", `Catalog not ready, informed ${contactName}`);
          await sendText(
            from,
            "🍰 *Welcome to Anumod Bakery!* ✨\n\nOur product menu is being updated right now 🔄\n\nPlease try again in a few minutes — we'll be ready to take your order very soon! 😊"
          );
          return res.sendStatus(200);
        }

        users[from] = { step: "START", lastActivity: Date.now() };
        log("INFO", `New session started for ${contactName} (${from})`);

        await sendText(
          from,
          "👋 Hey there! Welcome to *Anumod Bakery* 🍞✨\n\nWe're delighted to have you here 😊\nEnjoy our freshly baked treats made with love ❤️\n\nLet's get started! 🎉"
        );
        await sendCatalog(from);
        return res.sendStatus(200);
      }

      // ── CANCEL ────────────────────────────────────────
      if (lowerText === "cancel") {
        if (users[from].step && users[from].step !== "START") {
          log("INFO", `Order cancelled via text by ${contactName}`);
          delete users[from];
          await sendText(
            from,
            "❌ Your order has been cancelled.\n\nType *Hi* whenever you're ready to order again 😊"
          );
        } else {
          await sendText(from, "😊 No active order to cancel. Type *Hi* to start! 🎉");
        }
        return res.sendStatus(200);
      }

      // ── CAKE MESSAGE ──────────────────────────────────
      if (users[from].step === "ASK_MESSAGE") {
        const user = users[from];
        const item = user.items[user.currentIndex];

        item.customMessage = lowerText === "no" ? null : rawText;

        log("INFO", `Cake message set`, {
          item: item.name,
          message: item.customMessage || "(none)"
        });

        user.currentIndex++;
        user.lastActivity = Date.now();

        if (user.currentIndex < user.items.length) {
          user.step = "ASK_WEIGHT";
          await askWeight(from);
        } else {
          user.step = "ASK_NAME";
          await sendText(from, "😊 May I know your name please?");
        }
        return res.sendStatus(200);
      }

      // ── CUSTOMER NAME ─────────────────────────────────
      if (users[from].step === "ASK_NAME") {
        const formattedName = rawText
          .split(" ")
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(" ");

        users[from].customerName = formattedName;
        users[from].lastActivity = Date.now();
        users[from].step = "ASK_DATE";

        log("INFO", `Customer name captured`, {
          raw: rawText,
          formatted: formattedName,
          phone: from
        });

        await askDate(from);
        return res.sendStatus(200);
      }

      // ── UNEXPECTED TEXT ───────────────────────────────
      if (users[from].step && users[from].step !== "START") {
        await sendText(
          from,
          "😊 Please use the buttons or list options to continue.\n\nType *cancel* to cancel your order, or *Hi* to start over!"
        );
        return res.sendStatus(200);
      }
    }

    /////////////////////////////////////////////////////
    // ORDER (from WhatsApp catalog)
    /////////////////////////////////////////////////////
    if (message.type === "order") {
      if (!catalogLoaded) {
        await sendText(
          from,
          "🍰 Our product menu is being updated right now 🔄\n\nPlease try again in a few minutes! 😊"
        );
        return res.sendStatus(200);
      }

      const cart = message.order.product_items.map(item => {
        const retailerId = item.product_retailer_id;
        const product    = catalogCache[retailerId];

        log("INFO", `Cart item lookup`, {
          retailer_id:  retailerId,
          foundInCache: !!product,
          productName:  product?.name,
          dietaryType:  product?.dietaryType,
          pricePerKg:   product?.basePrice
        });

        return {
          itemId:        product?.itemId || retailerId.replace(/_(EGG|EGGLESS)$/i, ""),
          name:          product?.name   || retailerId,
          qty:           item.quantity,
          weight:        null,
          basePrice:     product?.basePrice || 500,
          salePrice:     product?.salePrice || 0,
          dietaryType:   product?.dietaryType || null,
          customMessage: null
        };
      });

      log("INFO", `Cart received from ${contactName}`, {
        items: cart.map(i => `${i.qty}x ${i.name} @ ₹${i.basePrice} | ${i.dietaryType || "UNKNOWN"}`)
      });

      users[from] = {
        items: cart,
        currentIndex: 0,
        step: "ASK_WEIGHT",
        phone: "+" + from,
        lastActivity: Date.now()
      };

      await askWeight(from);
      return res.sendStatus(200);
    }

    /////////////////////////////////////////////////////
    // INTERACTIVE
    /////////////////////////////////////////////////////
    if (message.type === "interactive") {
      const id =
        message.interactive.button_reply?.id ||
        message.interactive.list_reply?.id;

      const user = users[from];

      if (!user || !user.step) {
        await sendText(from, "👋 Type *Hi* to start your order! 😊");
        return res.sendStatus(200);
      }

      user.lastActivity = Date.now();

      log("INFO", `Button/List reply from ${contactName}`, {
        buttonId: id,
        currentStep: user.step
      });

      // ── WEIGHT ────────────────────────────────────────
      if (["1KG", "2KG", "3KG", "4KG", "5KG"].includes(id)) {
        const item = user.items[user.currentIndex];
        item.weight = parseInt(id.replace("KG", ""), 10);

        log("INFO", `Weight selected`, { item: item.name, weight: item.weight });

        user.step = "ASK_MESSAGE";
        await sendText(
          from,
          `🎂 Want to add a special message on your *${item.name}* cake?\n\nType your message or type *no* 😊`
        );
        return res.sendStatus(200);
      }

      // ── DATE ──────────────────────────────────────────
      if (id.startsWith("DATE_")) {
        user.deliveryDate = id.replace("DATE_", "");
        user.step = "ASK_TIME";
        log("INFO", `Date selected`, { date: user.deliveryDate });
        await askTime(from);
        return res.sendStatus(200);
      }

      // ── TIME ──────────────────────────────────────────
      if (id.startsWith("TIME_")) {
        user.deliveryTime = id.replace("TIME_", "");
        user.step = "CONFIRM";
        log("INFO", `Time selected`, { time: user.deliveryTime });
        await sendSummary(from);
        return res.sendStatus(200);
      }

      // ── CONFIRM ORDER — SINGLE API CALL WITH ALL ITEMS ─
      if (id === "CONFIRM_ORDER") {
        try {

          // Build items array — one entry per cake
          const itemsPayload = user.items.map(item => ({
            itemId:               item.itemId,
            flavourId:            null,
            weight:               item.weight,
            qty:                  item.qty,
            dieteryType:          item.dietaryType,
            shape:                null,
            customerMessage:      item.customMessage,
            customisationMessage: null,
            fondantCake:          null,
            fondantDieteryType:   null,
            cupCakes:             null,
            cupcakeDieteryType:   null,
            photoSheets:          null
          }));

          // Single payload with all items
          const payload = {
            customerName:   user.customerName,
            customerNumber: user.phone,
            deliveryDate:   user.deliveryDate,
            deliveryTime:   user.deliveryTime,
            source:         "WHATSAPP",
            items:          itemsPayload
          };

          log("API", `Sending single order with ${itemsPayload.length} item(s) to API`, payload);

          const response = await axios.post(process.env.ORDER_API, payload);

          log("API", `Order API response`, {
            status: response.status,
            data:   response.data
          });

          await sendText(
            from,
            "🎉 *Order received successfully!* 🧾\n\nOur team is processing your order and will contact you shortly 📞\n\n👉 Type *Hi* anytime to place another order 😊"
          );

          log("INFO", `✅ Order completed for ${contactName}`, {
            totalItems:  user.items.length,
            items:       user.items.map(i => `${i.qty}x ${i.name} (${i.weight}kg) [${i.dietaryType || "N/A"}]`),
            date:        user.deliveryDate,
            time:        user.deliveryTime,
            name:        user.customerName,
            phone:       user.phone
          });

        } catch (e) {
          log("ERROR", "Order API call failed", {
            error:  e.response?.data || e.message,
            status: e.response?.status
          });
          await sendText(
            from,
            "⚠️ Oops! Something went wrong while placing your order.\nPlease try again or contact us directly."
          );
        }

        delete users[from];
        return res.sendStatus(200);
      }

      // ── CANCEL ORDER ──────────────────────────────────
      if (id === "CANCEL_ORDER") {
        log("INFO", `Order cancelled by ${contactName}`);
        delete users[from];
        await sendText(
          from,
          "❌ Your order has been cancelled. No worries! 😊\n\nType *Hi* whenever you're ready to order!"
        );
        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);

  } catch (err) {
    log("ERROR", "Webhook crashed", { error: err.message, stack: err.stack });
    res.sendStatus(500);
  }
});

/////////////////////////////////////////////////////
// DATE — IST correct
/////////////////////////////////////////////////////
function getNextDates(days) {
  const arr = [];
  const todayIST = getTodayIST();
  const hourIST = getISTHour();

  if (hourIST < 12) arr.push(todayIST);

  const ist = getISTDate();
  for (let i = 1; i <= days; i++) {
    const d = new Date(ist.getTime());
    d.setUTCDate(d.getUTCDate() + i);
    const y  = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dy = String(d.getUTCDate()).padStart(2, "0");
    arr.push(`${y}-${mo}-${dy}`);
  }

  log("INFO", "Dates generated", { hourIST, todayShown: hourIST < 12, dates: arr });
  return arr;
}

async function askDate(user) {
  const dates = getNextDates(5);

  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: user,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "📅 Please choose your preferred delivery date 😊" },
        action: {
          button: "Choose Date",
          sections: [{
            title: "Available Dates",
            rows: dates.map(d => ({ id: "DATE_" + d, title: d }))
          }]
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

/////////////////////////////////////////////////////
// TIME — IST correct
/////////////////////////////////////////////////////
async function askTime(user) {
  const selectedDate = users[user].deliveryDate;
  const todayIST = getTodayIST();
  const hourIST = getISTHour();

  log("INFO", "Time check", { selectedDate, todayIST, hourIST });

  let times = [];

  if (selectedDate === todayIST) {
    if (hourIST >= 12) {
      await sendText(
        user,
        "⚠️ Sorry! Same-day delivery is closed after 12:00 PM IST.\n\nPlease choose another date 😊"
      );
      users[user].step = "ASK_DATE";
      await askDate(user);
      return;
    }
    times = ["03:00 PM", "04:00 PM"];
    log("INFO", "Same-day slots shown");
  } else {
    times = ["12:00 PM", "01:00 PM", "02:00 PM", "03:00 PM", "04:00 PM"];
    log("INFO", "All slots shown");
  }

  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: user,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "⏰ Pick a delivery time that works best for you 😊" },
        action: {
          button: "Choose Time",
          sections: [{
            title: "Available Time Slots",
            rows: times.map(t => ({ id: "TIME_" + t, title: t }))
          }]
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

/////////////////////////////////////////////////////
// PRICING
/////////////////////////////////////////////////////
function getPricingDetails(basePrice, salePrice, weight, qty) {
  const kg            = weight || 1;
  const originalTotal = basePrice * kg * qty;

  if (salePrice > 0) {
    const discountedTotal = salePrice * kg * qty;
    const savedTotal      = originalTotal - discountedTotal;
    return { originalTotal, discountedTotal, savedTotal, hasDiscount: true };
  }

  return { originalTotal, discountedTotal: originalTotal, savedTotal: 0, hasDiscount: false };
}

/////////////////////////////////////////////////////
// SUMMARY
/////////////////////////////////////////////////////
async function sendSummary(user) {
  const data = users[user];
  let grandTotal = 0;
  let grandSaved = 0;
  let text = "🧾 *Here's your order summary 🛍️*\n\n";

  data.items.forEach(i => {
    if (!i.weight || !i.basePrice) return;
    const p = getPricingDetails(i.basePrice, i.salePrice || 0, i.weight, i.qty);
    grandTotal += p.discountedTotal;
    grandSaved += p.savedTotal;

    text += `🍰 ${i.qty} × ${i.name} (${i.weight}kg)${i.dietaryType ? " | " + i.dietaryType : ""}\n`;

    if (p.hasDiscount) {
      text += `💸 ₹${p.originalTotal} → ₹${p.discountedTotal} *(Save ₹${p.savedTotal})*\n`;
    } else {
      text += `💸 ₹${p.originalTotal}\n`;
    }

    if (i.customMessage) text += `📝 "${i.customMessage}"\n`;
    text += "\n";
  });

  text += `📅 Date: ${data.deliveryDate}`;
  text += `\n⏰ Time: ${data.deliveryTime}`;
  text += `\n\n💰 *Total: ₹${grandTotal}*`;
  if (grandSaved > 0) text += `\n🎉 *You saved ₹${grandSaved}!*\n`;
  text += `\n👇 Please review and confirm your order 😊`;

  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: user,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text },
        action: {
          buttons: [
            { type: "reply", reply: { id: "CONFIRM_ORDER", title: "Confirm ✅" } },
            { type: "reply", reply: { id: "CANCEL_ORDER", title: "Cancel ❌" } }
          ]
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

/////////////////////////////////////////////////////
// SEND TEXT
/////////////////////////////////////////////////////
async function sendText(to, msg) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: msg }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

/////////////////////////////////////////////////////
// SEND CATALOG
/////////////////////////////////////////////////////
async function sendCatalog(to) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "catalog_message",
        body: { text: "🍰 Browse our delicious cakes & pick your favorite 😍" },
        action: { name: "catalog_message" }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

/////////////////////////////////////////////////////
// ASK WEIGHT
/////////////////////////////////////////////////////
async function askWeight(user) {
  const item = users[user].items[users[user].currentIndex];

  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: user,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: `🎂 Choose the weight for your *${item.name}* cake 😊` },
        action: {
          button: "Choose Weight",
          sections: [{
            title: "Weight Options",
            rows: [
              { id: "1KG", title: "1 KG" },
              { id: "2KG", title: "2 KG" },
              { id: "3KG", title: "3 KG" },
              { id: "4KG", title: "4 KG" },
              { id: "5KG", title: "5 KG" }
            ]
          }]
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

/////////////////////////////////////////////////////
// START SERVER
/////////////////////////////////////////////////////
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  log("INFO", `🚀 Anumod Bakery Bot started on port ${PORT}`);
});
