require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const admin = require("firebase-admin");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// 1. Firebase Admin Initialisierung
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// 2. CORS (Immer oben)
app.use(cors());

// --- 3. STRIPE WEBHOOK (Muss VOR express.json() stehen!) ---
app.post(
  "/webhook",
  express.raw({ type: "application/json" }), // Wichtig: Holt die Rohdaten für die Signatur
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body, // Hier sind jetzt die echten Rohdaten drin
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error(`❌ Webhook Fehler: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Wenn die Zahlung erfolgreich war
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId = session.client_reference_id;
      const creditAmount = parseInt(session.metadata.credits);
      const sessionId = session.id;
      const amountPaid = session.amount_total / 100;

      console.log(
        `Processing fulfillment for User: ${userId}, Credits: ${creditAmount}`
      );

      try {
        const userRef = db.collection("users").doc(userId);
        await userRef.set(
          {
            credits: admin.firestore.FieldValue.increment(creditAmount),
            payments: admin.firestore.FieldValue.arrayUnion({
              sessionId,
              amount: amountPaid,
              credits: creditAmount,
              date: new Date().toISOString(),
              status: "completed",
            }),
            lastPurchase: new Date().toISOString(),
          },
          { merge: true }
        );
        console.log(`✅ Firestore erfolgreich aktualisiert für User ${userId}`);
      } catch (error) {
        console.error("❌ Kritischer Fehler beim Firestore Update:", error);
      }
    }

    res.json({ received: true });
  }
);

// --- 4. AB HIER: JSON-Middleware für alle anderen Endpunkte ---
app.use(express.json());

// --- 5. Checkout Session Endpoint ---
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { uid, email, credits } = req.body;

    if (!uid) return res.status(400).json({ error: "User ID fehlt." });

    const allowedCredits = [25, 200];
    if (!allowedCredits.includes(credits)) {
      return res.status(400).json({ error: "Ungültiges Paket." });
    }

    let priceId;
    if (credits === 25) priceId = "price_1SlQSb49gql0qC525SZpLLOg";
    if (credits === 200) priceId = "price_1SmbNB49gql0qC52jvnspaLs";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: uid,
      customer_email: email || undefined,
      metadata: { credits },
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `https://schriftbot.com/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://schriftbot.com/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe Session Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "schriftbot-backend" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
