const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 1000;

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const CATALOG_ID = process.env.CATALOG_ID;

let users = {};
let catalogCache = {};
const processedMessages = new Set();

setInterval(() => processedMessages.clear(), 600000);

/////////////////////////////////////////////////////
// LOAD CATALOG (WITH DISCOUNT)
/////////////////////////////////////////////////////
async function loadCatalog() {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v22.0/${CATALOG_ID}/products?fields=name,retailer_id,price,sale_price`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );

    catalogCache = {};

    res.data.data.forEach(p => {
      const original = extractPrice(p.price);
      const sale = extractPrice(p.sale_price);

      catalogCache[p.retailer_id] = {
        name: p.name,
        id: p.name.toUpperCase().replace(/\s/g, "_"),
        originalPrice: original || 500,
        salePrice: sale || original || 500
      };
    });

    console.log("✅ Catalog loaded with discount");
  } catch (err) {
    console.log("❌ Catalog error:", err.response?.data || err.message);
  }
}

function extractPrice(p) {
  if (!p) return null;
  return parseFloat(p.replace(/[^\d.]/g, ""));
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

    if (processedMessages.has(message.id)) return res.sendStatus(200);
    processedMessages.add(message.id);

    const from = message.from;
    if (!users[from]) users[from] = {};

    /////////////////////////////////////////////////////
    // TEXT
    /////////////////////////////////////////////////////
    if (message.type === "text") {
      const text = message.text.body.trim().toLowerCase();

      if (
        ["menu", "start"].includes(text) ||
        (["hi", "hello"].includes(text) && !users[from]?.step)
      ) {
        delete users[from];

        users[from] = { step: "START" };

        // ❗ NOT CHANGED (as requested)
        await sendText(
          from,
          "Welcome to Anumod Bakery! 🍞✨\nWe’re delighted to have you here. Enjoy our freshly baked treats made with love—your happiness is our sweetest recipe! 😊"
        );

        await sendCatalog(from);
        return res.sendStatus(200);
      }

      // MESSAGE
      if (users[from].step === "ASK_MESSAGE") {
        const user = users[from];
        const item = user.items[user.currentIndex];

        item.customMessage = text === "no" ? "" : text;

        user.currentIndex++;

        if (user.currentIndex < user.items.length) {
          user.step = "ASK_WEIGHT";
          await askWeight(from);
        } else {
          user.step = "ASK_NAME";
          await sendText(from, "👤 May I know your name, please? 😊");
        }

        return res.sendStatus(200);
      }

      // NAME
      if (users[from].step === "ASK_NAME") {
        users[from].customerName = text;
        users[from].step = "ASK_DATE";
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
          originalPrice: product?.originalPrice || 500,
          salePrice: product?.salePrice || 500,
          customMessage: ""
        };
      });

      users[from] = {
        items: cart,
        currentIndex: 0,
        step: "ASK_WEIGHT",
        phone: "+" + from
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
      if (!user || !user.step) return res.sendStatus(200);

      // WEIGHT
      if (["1KG","2KG","3KG","4KG","5KG"].includes(id)) {
        if (user.step !== "ASK_WEIGHT") return res.sendStatus(200);

        const item = user.items[user.currentIndex];
        item.weight = id.toLowerCase();

        user.step = "ASK_MESSAGE";

        await sendText(
          from,
          `✨ Please type the message you’d like on your "${item.name}" cake 🎂  
(Or type *no* to skip 😊)`
        );
        return res.sendStatus(200);
      }

      // DATE
      if (id.startsWith("DATE_")) {
        if (user.step !== "ASK_DATE") return res.sendStatus(200);

        user.deliveryDate = id.replace("DATE_", "");
        user.step = "ASK_TIME";

        await askTime(from);
        return res.sendStatus(200);
      }

      // TIME
      if (id.startsWith("TIME_")) {
        if (user.step !== "ASK_TIME") return res.sendStatus(200);

        user.deliveryTime = id.replace("TIME_", "");
        user.step = "CONFIRM";

        await sendSummary(from);
        return res.sendStatus(200);
      }

      // CONFIRM
      if (id === "CONFIRM_ORDER") {
        await sendText(
          from,
          "🎉 Your order has been placed successfully!\n\nOur team will reach out to you shortly for confirmation 📞\n\n💬 You can type *Hi* anytime to place another order 😊"
        );
        delete users[from];
      }

      if (id === "CANCEL_ORDER") {
        delete users[from];
        await sendText(
          from,
          "❌ Your order has been cancelled.\n\nNo worries! You can start again anytime by typing *Hi* 😊"
        );
      }
    }

    res.sendStatus(200);

  } catch (err) {
    console.log(err);
    res.sendStatus(500);
  }
});

/////////////////////////////////////////////////////
// DATE
/////////////////////////////////////////////////////
function getNextDates(days) {
  const arr = [];
  const now = new Date();
  const hour = now.getHours();

  if (hour < 12) {
    arr.push(new Date().toISOString().split("T")[0]);
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
        body: { text: "📅 Please choose your preferred delivery date 🎉" },
        action: {
          button: "Choose Date",
          sections: [
            {
              title: "Available Dates",
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

/////////////////////////////////////////////////////
// TIME
/////////////////////////////////////////////////////
async function askTime(user) {
  const selectedDate = users[user].deliveryDate;
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const hour = now.getHours();

  let times = [];

  if (selectedDate === today) {
    if (hour >= 12) {
      await sendText(
        user,
        "⚠️ Oops! Same-day delivery is no longer available for today.\nPlease select another date 😊"
      );
      users[user].step = "ASK_DATE";
      await askDate(user);
      return;
    }
    times = ["03:00 PM", "04:00 PM"];
  } else {
    times = ["12:00 PM","01:00 PM","02:00 PM","03:00 PM","04:00 PM"];
  }

  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: user,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "⏰ Choose a convenient delivery time for you ⏳" },
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
// SUMMARY
/////////////////////////////////////////////////////
function getPrices(item, weight) {
  const map = { "1kg":1,"2kg":2,"3kg":3,"4kg":4,"5kg":5 };
  const m = map[weight] || 1;

  return {
    original: item.originalPrice * m,
    sale: item.salePrice * m
  };
}

async function sendSummary(user) {
  const data = users[user];

  let total = 0;
  let totalOriginal = 0;

  let text = "🧾 Here’s your order summary 🛍️\n\n";

  data.items.forEach(i => {
    const { original, sale } = getPrices(i, i.weight);

    const itemOriginalTotal = original * i.quantity;
    const itemSaleTotal = sale * i.quantity;

    total += itemSaleTotal;
    totalOriginal += itemOriginalTotal;

    text += `${i.quantity} × ${i.name} (${i.weight}) - ₹${itemSaleTotal}\n`;

    if (original !== sale) {
      text += `💸 ₹${itemOriginalTotal} → ₹${itemSaleTotal}\n`;
    }

    if (i.customMessage) {
      text += `📝 "${i.customMessage}"\n`;
    }

    text += "\n";
  });

  text += `📅 Date: ${data.deliveryDate}\n`;
  text += `⏰ Time: ${data.deliveryTime}\n\n`;
  text += `💰 Total: ₹${total}`;

  if (totalOriginal > total) {
    text += `\n🎉 You saved ₹${totalOriginal - total}!`;
  }

  text += "\n\n👉 Please review your order and confirm below 😊";

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
// UTIL
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
        body: { text: "🍰 Explore our delicious cake collection and pick your favorite 😍" },
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
        body: { text: `🎂 Please choose the weight for your "${item.name}" cake 🎉` },
        action: {
          button: "Choose",
          sections: [
            {
              title: "Available Weights",
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
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

/////////////////////////////////////////////////////
// START
/////////////////////////////////////////////////////
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
