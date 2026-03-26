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
let processedMessages = new Set();

/////////////////////////////////////////////////////
// LOAD CATALOG
/////////////////////////////////////////////////////

async function loadCatalog() {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v22.0/${CATALOG_ID}/products?fields=name,retailer_id,price`,
      {
        headers: { Authorization: `Bearer ${TOKEN}` }
      }
    );

    catalogCache = {};

    res.data.data.forEach(product => {
      catalogCache[product.retailer_id] = {
        name: product.name
      };
    });

    console.log("✅ Catalog loaded");
  } catch (err) {
    console.log("❌ Catalog error:", err.message);
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
  console.log("FULL BODY:");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const msgId = message.id;

    if (processedMessages.has(msgId)) {
      return res.sendStatus(200);
    }
    processedMessages.add(msgId);

    const from = message.from;

    if (message.type === "text") {
      const text = message.text.body.toLowerCase();

      if (["hi", "hello", "menu", "start"].includes(text)) {
        users[from] = {};

        await sendText(from, "Welcome to Anumod Bakery 🎂");
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
          await sendText(from, "Enter your name");
        }
        return res.sendStatus(200);
      }

      if (users[from]?.step === "ASK_NAME") {
        users[from].customerName = message.text.body;
        await askDate(from);
        return res.sendStatus(200);
      }
    }

    if (message.type === "order") {
      const cart = message.order.product_items.map(item => {
        const product = catalogCache[item.product_retailer_id];

        return {
          name: product?.name || "Cake",
          quantity: item.quantity,
          weight: null,
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
    }

    if (message.type === "interactive") {
      const id =
        message.interactive.button_reply?.id ||
        message.interactive.list_reply?.id;

      const user = users[from];

      if (!user) {
        await sendText(from, "Session expired. Type Hi");
        return res.sendStatus(200);
      }

      if (["1KG", "2KG", "3KG"].includes(id)) {
        const item = user.items[user.currentIndex];
        item.weight = id;

        user.step = "ASK_MESSAGE";

        await sendText(from, `Message for ${item.name}? (type no)`);
        return res.sendStatus(200);
      }

      if (id.startsWith("DATE_")) {
        user.deliveryDate = id;
        await askTime(from);
        return res.sendStatus(200);
      }

      if (id.startsWith("TIME_")) {
        user.deliveryTime = id;
        await sendSummary(from);
        return res.sendStatus(200);
      }

      if (id === "CONFIRM_ORDER") {
        await sendText(from, "Order placed successfully ✅");
        delete users[from];
      }

      if (id === "CANCEL_ORDER") {
        delete users[from];
        await sendText(from, "Order cancelled ❌");
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.log(err);
    res.sendStatus(500);
  }
});

/////////////////////////////////////////////////////
// FUNCTIONS
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
        body: { text: "View cakes" },
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
        body: { text: `Select weight for ${item.name}` },
        action: {
          button: "Choose",
          sections: [
            {
              title: "Weights",
              rows: [
                { id: "1KG", title: "1 KG" },
                { id: "2KG", title: "2 KG" },
                { id: "3KG", title: "3 KG" }
              ]
            }
          ]
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

async function askDate(to) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Select delivery date" },
        action: {
          button: "Choose",
          sections: [
            {
              title: "Dates",
              rows: [
                { id: "DATE_TODAY", title: "Today" },
                { id: "DATE_TOMORROW", title: "Tomorrow" }
              ]
            }
          ]
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

async function askTime(to) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Select delivery time" },
        action: {
          button: "Choose",
          sections: [
            {
              title: "Time",
              rows: [
                { id: "TIME_MORNING", title: "Morning" },
                { id: "TIME_EVENING", title: "Evening" }
              ]
            }
          ]
        }
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

async function sendSummary(to) {
  const user = users[to];

  let summary = "Order Summary:\n\n";

  user.items.forEach(item => {
    summary += `${item.name} (${item.weight})\n`;
    if (item.customMessage) summary += `Message: ${item.customMessage}\n`;
  });

  summary += `\nName: ${user.customerName}`;
  summary += `\nDate: ${user.deliveryDate}`;
  summary += `\nTime: ${user.deliveryTime}`;

  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: summary },
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

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
