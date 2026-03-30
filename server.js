const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const CATALOG_ID = process.env.CATALOG_ID;

let users = {};
let catalogCache = {};
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
// LOAD CATALOG
/////////////////////////////////////////////////////
async function loadCatalog() {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v22.0/${CATALOG_ID}/products?fields=name,retailer_id,price`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );

    catalogCache = {};
    res.data.data.forEach(p => {
      catalogCache[p.retailer_id] = {
        name: p.name,
        id: p.name.toUpperCase().replace(/\s/g, "_"),
        basePrice: extractPrice(p.price) || 500
      };
    });

    log("INFO", "Catalog loaded", {
      productCount: Object.keys(catalogCache).length,
      products: Object.values(catalogCache).map(p => `${p.name} — ₹${p.basePrice}`)
    });
  } catch (err) {
    log("ERROR", "Catalog load failed", { error: err.response?.data || err.message });
  }
}

function extractPrice(p) {
  if (!p) return null;
  return parseFloat(p.replace(/[^\d.]/g, ""));
}

loadCatalog();
setInterval(loadCatalog, 600000);

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

    // Log every incoming message
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

    // Check and expire session if inactive
    const expired = await checkAndExpireSession(from);
    if (expired) return res.sendStatus(200);

    // Update activity timestamp for active sessions
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

        // If mid-order, warn user instead of silently restarting
        if (
          users[from].step &&
          users[from].step !== "START" &&
          users[from].step !== "CONFIRM"
        ) {
          log("INFO", `Mid-order Hi attempt by ${contactName}`, {
            currentStep: users[from].step
          });

          await sendText(
            from,
            "⚠️ You have an order in progress!\n\nType *cancel* to cancel your current order and start a new one, or continue with your current order 😊"
          );
          return res.sendStatus(200);
        }

        // Fresh start
        users[from] = { step: "START", lastActivity: Date.now() };
        log("INFO", `New session started for ${contactName} (${from})`);

        await sendText(
          from,
          "👋 Hey there! Welcome to *Anumod Bakery* 🍞✨\n\nWe're delighted to have you here 😊\nEnjoy our freshly baked treats made with love ❤️\n\nLet's get started! 🎉"
        );

        await sendCatalog(from);
        return res.sendStatus(200);
      }

      // ── CANCEL KEYWORD ────────────────────────────────
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

        item.customMessage = lowerText === "no" ? "" : rawText;

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
      const cart = message.order.product_items.map(item => {
        const product = catalogCache[item.product_retailer_id];
        return {
          itemId: product?.id || "CAKE",
          name: product?.name || "Cake",
          quantity: item.quantity,
          weight: null,
          basePrice: product?.basePrice || 500,
          customMessage: ""
        };
      });

      log("INFO", `Cart received from ${contactName}`, {
        items: cart.map(i => `${i.quantity}x ${i.name} @ ₹${i.basePrice}`)
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
        item.weight = id.toLowerCase();

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

      // ── CONFIRM ORDER ─────────────────────────────────
      if (id === "CONFIRM_ORDER") {
        try {
          for (const item of user.items) {
            const payload = {
              itemId: item.itemId,
              customerNumber: user.phone,
              customerName: user.customerName,
              deliveryDate: user.deliveryDate,
              deliveryTime: user.deliveryTime,
              weight: item.weight,
              quantity: item.quantity,
              message: item.customMessage
            };

            log("API", `Sending to Order API`, payload);

            const response = await axios.post(process.env.ORDER_API, payload);

            log("API", `Order API response`, {
              status: response.status,
              data: response.data
            });
          }

          await sendText(
            from,
            "🎉 *Yay! Your order is confirmed!* 🥳\n\nOur team will contact you shortly 😊\n\n👉 Type *Hi* anytime to place another order!"
          );

          log("INFO", `✅ Order completed for ${contactName}`, {
            items: user.items.map(i => `${i.quantity}x ${i.name} (${i.weight})`),
            date: user.deliveryDate,
            time: user.deliveryTime,
            name: user.customerName,
            phone: user.phone
          });

        } catch (e) {
          log("ERROR", "Order API call failed", {
            error: e.response?.data || e.message,
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

  // Show today only before 12 PM IST
  if (hourIST < 12) {
    arr.push(todayIST);
  }

  const ist = getISTDate();
  for (let i = 1; i <= days; i++) {
    const d = new Date(ist.getTime());
    d.setUTCDate(d.getUTCDate() + i);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    arr.push(`${y}-${mo}-${day}`);
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
// PRICING — ₹50 per kg discount
/////////////////////////////////////////////////////
function getPricingDetails(basePrice, weight, quantity) {
  const kgMap = { "1kg": 1, "2kg": 2, "3kg": 3, "4kg": 4, "5kg": 5 };
  const kg = kgMap[weight] || 1;

  const pricePerPiece = basePrice * kg;
  const discountPerPiece = pricePerPiece >= 500 ? 50 * kg : 0;
  const discountedPerPiece = pricePerPiece - discountPerPiece;

  const originalTotal = pricePerPiece * quantity;
  const discountedTotal = discountedPerPiece * quantity;
  const savedTotal = originalTotal - discountedTotal;

  return { pricePerPiece, discountedPerPiece, originalTotal, discountedTotal, savedTotal };
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
    const p = getPricingDetails(i.basePrice, i.weight, i.quantity);
    grandTotal += p.discountedTotal;
    grandSaved += p.savedTotal;

    text += `🍰 ${i.quantity} × ${i.name} (${i.weight})\n`;
    if (p.savedTotal > 0) {
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
