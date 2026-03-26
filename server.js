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
let processedMessages = new Set();

/////////////////////////////////////////////////////
// PRICE EXTRACTOR
/////////////////////////////////////////////////////

function extractPrice(p) {
  if (!p) return 0;

  if (typeof p === "string") {
    return parseFloat(p.replace(/[^\d.]/g, ""));
  }

  if (typeof p === "object" && p.amount) {
    return parseFloat(p.amount) / 100;
  }

  return 0;
}

/////////////////////////////////////////////////////
// LOAD CATALOG
/////////////////////////////////////////////////////

async function loadCatalog() {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v22.0/${CATALOG_ID}/products?fields=name,retailer_id,price,sale_price`,
      {
        headers: { Authorization: `Bearer ${TOKEN}` }
      }
    );

    catalogCache = {};

    res.data.data.forEach(product => {
      const basePrice = extractPrice(product.price);
      const salePrice = extractPrice(product.sale_price);

      catalogCache[product.retailer_id] = {
        name: product.name,
        id: product.name.toUpperCase().replace(/\s/g, "_"),
        basePrice: basePrice || 500,
        salePrice: salePrice || 0
      };
    });

    console.log("✅ Catalog loaded");

  } catch (err) {
    console.log("❌ Catalog error:", err.response?.data || err.message);
  }
}

loadCatalog();
setInterval(loadCatalog, 600000);

/////////////////////////////////////////////////////
// VERIFY
/////////////////////////////////////////////////////

app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/////////////////////////////////////////////////////
// WEBHOOK
/////////////////////////////////////////////////////

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const msgId = message.id;

    // ✅ Prevent duplicate events
    if (processedMessages.has(msgId)) {
      return res.sendStatus(200);
    }
    processedMessages.add(msgId);

    const from = message.from;

    console.log("Incoming:", message);

    /////////////////////////////////////////////////////
    // TEXT
    /////////////////////////////////////////////////////

    if (message.type === "text") {
      const text = message.text.body.toLowerCase();

      if (["hi","hii","hai","hello", "menu", "start"].includes(text)) {

        users[from] = {};

        await sendText(
          from,
          "Welcome to Anumod Bakery! 🍞✨\nWe’re delighted to have you here. Enjoy our freshly baked treats made with love—your happiness is our sweetest recipe! 😊"
        );

        await sendCatalog(from);
      }

      if (users[from]?.step === "ASK_MESSAGE") {
        const user = users[from];
        const item = user.items[user.currentIndex];

        item.customMessage = text === "no" ? "" : text;

        user.currentIndex++;

        if (user.currentIndex < user.items.length) {
          user.step = "ASK_WEIGHT";
          await askWeight(from);
        } else {
          user.step = "ASK_NAME";
          await sendText(from, "👤 Enter your name");
        }

        return res.sendStatus(200);
      }

      if (users[from]?.step === "ASK_NAME") {
        users[from].customerName = message.text.body;
        await askDate(from);
        return res.sendStatus(200);
      }
    }

    /////////////////////////////////////////////////////
    // ORDER
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
          salePrice: product?.salePrice || 0,
          customMessage: ""
        };
      });

      users[from] = {
        items: cart,
        currentIndex: 0,
        step: "ASK_WEIGHT",
        phone: "+" + from,
        confirmed: false
      };

      await askWeight(from);
    }

    /////////////////////////////////////////////////////
    // INTERACTIVE
    /////////////////////////////////////////////////////

    if (message.type === "interactive") {

      const id =
        message.interactive.button_reply?.id ||
        message.interactive.list_reply?.id;

      const user = users[from];

      // ✅ Session expired protection
      if (!user) {
  await sendText(from, "⚠️ Session expired. Please type *Hi* to start again.");
  return res.sendStatus(200);
}

      // WEIGHT
      if (["1KG","2KG","3KG","4KG","5KG"].includes(id)) {
        const item = user.items[user.currentIndex];
        item.weight = id.toLowerCase();

        user.step = "ASK_MESSAGE";

        await sendText(
          from,
          `✍️ Any message for "${item.name}" cake?\n(Type 'no' if none)`
        );

        return res.sendStatus(200);
      }

      // DATE
      if (id.startsWith("DATE_")) {
        user.deliveryDate = id.replace("DATE_", "");
        await askTime(from);
        return res.sendStatus(200);
      }

      // TIME
      if (id.startsWith("TIME_")) {
        user.deliveryTime = id.replace("TIME_", "");
        await sendSummary(from);
        return res.sendStatus(200);
      }

      // CONFIRM (🔥 STRONG LOCK)
      if (id === "CONFIRM_ORDER") {

        if (!user || user.confirmed) {
          return res.sendStatus(200);
        }

        user.confirmed = true;

        await sendText(from, "⏳ Processing your order...");

        console.log("📦 Sending order:", user);

        try {
          for (const item of user.items) {

            const response = await axios.post(process.env.ORDER_API, {
              itemId: item.itemId,
              customerNumber: user.phone,
              customerName: user.customerName,
              deliveryDate: user.deliveryDate,
              deliveryTime: user.deliveryTime,
              weight: item.weight,
              message: item.customMessage
            });

            console.log("✅ API response:", response.data);
          }

          await sendText(
            from,
            "✅ Order placed successfully!\nOur customer service team will contact you shortly 😊\n\n👉 Type *Hi* to start again"
          );

        } catch (e) {
          console.log("❌ API error:", e.response?.data || e.message);

          user.confirmed = false;

          await sendText(from, "❌ Order failed. Please try again.");
          return res.sendStatus(200);
        }

        delete users[from];
      }

      // CANCEL
      if (id === "CANCEL_ORDER") {

        if (user.confirmed) {
          await sendText(from, "⚠️ Order is already being processed or placed.");
          return res.sendStatus(200);
        }

        delete users[from];
        await sendText(from, "❌ Order cancelled");
      }
    }

    res.sendStatus(200);

  } catch (err) {
    console.log(err);
    res.sendStatus(500);
  }
});

/////////////////////////////////////////////////////
// PRICE LOGIC
/////////////////////////////////////////////////////

function getPrice(basePrice, salePrice, weight) {

  const map = {
    "1kg": 1,
    "2kg": 2,
    "3kg": 3,
    "4kg": 4,
    "5kg": 5
  };

  const multiplier = map[weight] || 1;

  const finalPrice = salePrice > 0 ? salePrice : basePrice;

  return {
    final: finalPrice * multiplier,
    base: basePrice * multiplier
  };
}

/////////////////////////////////////////////////////
// SUMMARY
/////////////////////////////////////////////////////

async function sendSummary(user) {

  const data = users[user];

  let total = 0;
  let totalBase = 0;

  let text = "🧾 *Order Summary*\n\n";

  data.items.forEach(i => {

    const price = getPrice(i.basePrice, i.salePrice, i.weight);

    const itemFinal = price.final * i.quantity;
    const itemBase = price.base * i.quantity;

    total += itemFinal;
    totalBase += itemBase;

    text += `${i.quantity} × ${i.name} (${i.weight}) - ₹${itemFinal}\n`;

    if (i.salePrice > 0) {
      text += `   💸 ₹${i.basePrice} → ₹${i.salePrice}\n`;
    }

    if (i.customMessage) {
      text += `   📝 "${i.customMessage}"\n`;
    }
  });

  const saved = totalBase - total;

  text += `\n📅 Date: ${data.deliveryDate}`;
  text += `\n⏰ Time: ${data.deliveryTime}`;
  text += `\n\n💰 Total: ₹${total}`;

  if (saved > 0) {
    text += `\n🎉 You saved ₹${saved}!`;
  }

  text += `\n\nConfirm your order 👇`;

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
            { type: "reply", reply: { id: "CONFIRM_ORDER", title: "Confirm" } },
            { type: "reply", reply: { id: "CANCEL_ORDER", title: "Cancel" } }
          ]
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

/////////////////////////////////////////////////////
// DATE + TIME
/////////////////////////////////////////////////////

function getNextDates(days) {
  const arr = [];
  const now = new Date();
  const hour = now.getHours();

  if (hour < 12) {
    arr.push(now.toISOString().split("T")[0]);
  }

  for (let i = 1; i <= days; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    arr.push(d.toISOString().split("T")[0]);
  }

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
        body: { text: "📅 Select delivery date" },
        action: {
          button: "Choose Date",
          sections: [
            {
              title: "Dates",
              rows: dates.map(d => ({
                id: "DATE_" + d,
                title: d
              }))
            }
          ]
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

async function askTime(user) {

  const selectedDate = users[user].deliveryDate;
  const today = new Date().toISOString().split("T")[0];

  let times =
    selectedDate === today
      ? ["03:00 PM", "04:00 PM"]
      : ["12:00 PM", "01:00 PM", "02:00 PM", "03:00 PM", "04:00 PM"];

  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: user,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "⏰ Select delivery time" },
        action: {
          button: "Choose Time",
          sections: [
            {
              title: "Time Slots",
              rows: times.map(t => ({
                id: "TIME_" + t,
                title: t
              }))
            }
          ]
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

/////////////////////////////////////////////////////

async function sendText(to, msg) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: msg }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

async function sendCatalog(to) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "catalog_message",
        body: { text: "🍰 View our cakes" },
        action: { name: "catalog_message" }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

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
        body: { text: `🎂 Select weight for ${item.name}` },
        action: {
          button: "Choose",
          sections: [
            {
              title: "Weights",
              rows: [
                { id: "1KG", title: "1 KG" },
                { id: "2KG", title: "2 KG" },
                { id: "3KG", title: "3 KG" },
                { id: "4KG", title: "4 KG" },
                { id: "5KG", title: "5 KG" }
              ]
            }
          ]
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` }
  });
}

/////////////////////////////////////////////////////

app.listen(1000, () => console.log("🚀 Server running on port 3000"));