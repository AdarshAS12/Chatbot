const mongoose = require("mongoose");

const OrderSchema = new mongoose.Schema({
  phone: String,
  cake: String,
  weight: String,
  message: String,
  status: {
    type: String,
    default: "pending"
  }
});

module.exports = mongoose.model("Order", OrderSchema);