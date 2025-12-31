// index.js (Backend)
require("dotenv").config();
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "schriftbot-backend" });
});

// NEUER ENDPOINT für Stripe Checkout
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { uid, quantity } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: "Credits" },
            unit_amount: quantity * 100, // z.B. 1 Credit = 1 EUR
          },
          quantity: 1,
        },
      ],
      success_url: `https://dein-frontend-url.com/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://dein-frontend-url.com/cancel`,
      client_reference_id: uid, // User-ID speichern
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Checkout konnte nicht erstellt werden" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));
