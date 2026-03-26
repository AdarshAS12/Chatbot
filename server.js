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

/////////////////////////////////////////////////////
// PREVENT DUPLICATES
/////////////////////////////////////////////////////
setInterval(() => processedMessages.clear(), 600000);

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

    console.log("✅ Catalog loaded");
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
// VERIFY WEBHOOK
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
// MAIN WEBHOOK
/////////////////////////////////////////////////////
app.post("/webhook", async (req, res) => {
  try {
    console.log("FULL BODY:");
    console.log(JSON.stringify(req.body, null, 2));

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
          await sendText(from, "👤 Enter your name");
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
          basePrice: product?.basePrice || 500,
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
          `✍️ Any message for "${item.name}" cake?\n(Type 'no' if none)`
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
        if (user.step !== "CONFIRM") return res.sendStatus(200);

        try {
          for (const item of user.items) {
            await axios.post(process.env.ORDER_API, {
              itemId: item.itemId,
              customerNumber: user.phone,
              customerName: user.customerName,
              deliveryDate: user.deliveryDate,
              deliveryTime: user.deliveryTime,
              weight: item.weight,
              message: item.customMessage
            });
          }

          await sendText(
            from,
            "🎉 Your order has been placed successfully!\nOur customer service team will contact you shortly 😊\n\n👉 Type *Hi* to start a new order anytime!"
          );

        } catch (e) {
          console.log("API error:", e.response?.data || e.message);
          await sendText(from, "❌ Order failed. Try again.");
        }

        delete users[from];
      }

      if (id === "CANCEL_ORDER") {
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
// DATE LOGIC
/////////////////////////////////////////////////////
function getNextDates(days) {
  const arr = [];
  const now = new Date();
  const currentHour = now.getHours();

  if (currentHour < 12) {
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

/////////////////////////////////////////////////////
// TIME LOGIC
/////////////////////////////////////////////////////
async function askTime(user) {
  const selectedDate = users[user].deliveryDate;
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const hour = now.getHours();

  let times = [];

  if (selectedDate === today) {
    if (hour >= 12) {
      await sendText(user, "⚠️ Same-day delivery closed. Select another date.");
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
// PRICE
/////////////////////////////////////////////////////
function getPrice(basePrice, weight) {
  const map = { "1kg":1,"2kg":2,"3kg":3,"4kg":4,"5kg":5 };
  return basePrice * (map[weight] || 1);
}

/////////////////////////////////////////////////////
// SUMMARY
/////////////////////////////////////////////////////
async function sendSummary(user) {
  const data = users[user];
  let total = 0;

  let text = "🧾 *Order Summary*\n\n";

  data.items.forEach(i => {
    if (!i.weight || !i.basePrice) return;

    const price = getPrice(i.basePrice, i.weight);
    const itemTotal = price * i.quantity;

    total += itemTotal;

    text += `${i.quantity} × ${i.name} (${i.weight}) - ₹${itemTotal}\n`;

    if (i.customMessage) {
      text += `   📝 "${i.customMessage}"\n`;
    }
  });

  text += `\n📅 Date: ${data.deliveryDate}`;
  text += `\n⏰ Time: ${data.deliveryTime}`;
  text += `\n\n💰 Total: ₹${total}`;
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
// SEND TEXT
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

/////////////////////////////////////////////////////
// CATALOG
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
        body: { text: "🍰 View our cakes" },
        action: { name: "catalog_message" }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

/////////////////////////////////////////////////////
// WEIGHT
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
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

/////////////////////////////////////////////////////
// START SERVER
/////////////////////////////////////////////////////
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
