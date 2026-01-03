require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const admin = require("firebase-admin");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// 1. Firebase Admin Initialisierung
// Du musst die Datei 'serviceAccountKey.json' aus deinem Firebase Projekt herunterladen
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require("./serviceAccountKey.json"); // Fallback für lokales Testen

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// 2. CORS aktivieren
app.use(cors());

// 3. WICHTIG: Webhook-Endpoint VOR express.json()
// Stripe braucht den rohen Body (Raw), um die Signatur zu prüfen.
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error(`Webhook Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Wenn die Zahlung erfolgreich war
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId = session.client_reference_id;
      const creditAmount = parseInt(session.metadata.credits);
      const sessionId = session.id; // Die eindeutige Stripe ID
      const amountPaid = session.amount_total / 100; // Betrag in Euro

      console.log(
        `Zahlung erfolgreich! User: ${userId}, Credits: ${creditAmount}, Session: ${sessionId}`
      );

      try {
        const userRef = db.collection("users").doc(userId);

        // Update in Firestore
        await userRef.set(
          {
            // 1. Credits erhöhen
            credits: admin.firestore.FieldValue.increment(creditAmount),

            // 2. Zahlung in Liste speichern
            payments: admin.firestore.FieldValue.arrayUnion({
              sessionId: sessionId,
              amount: amountPaid,
              credits: creditAmount,
              date: new Date().toISOString(),
              status: "completed",
            }),

            // 3. Letztes Update speichern
            lastPurchase: new Date().toISOString(),
          },
          { merge: true }
        );

        console.log(
          `Firestore für User ${userId} aktualisiert. Zahlung geloggt.`
        );
      } catch (error) {
        console.error("Fehler beim Firestore Update:", error);
      }
    }

    res.json({ received: true });
  }
);

// 4. Jetzt erst express.json() für alle anderen Endpoints laden
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "schriftbot-backend" });
});

// Endpoint zum Erstellen der Checkout Session
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { uid, email } = req.body;

    if (!uid) {
      return res.status(400).json({ error: "User ID fehlt." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: uid,
      customer_email: email || undefined,

      // WICHTIG: Die Credits müssen trotzdem in die Metadata,
      // damit dein Webhook weiß, wie viele Credits er gutschreiben soll!
      metadata: {
        credits: 20,
      },

      line_items: [
        {
          // Hier deine Preis-ID aus dem Stripe Dashboard einfügen:
          // Du findest sie unter "Produkte" -> Dein Produkt -> "Preise"
          price: "price_1SlQSb49gql0qC525SZpLLOg",
          quantity: 1,
        },
      ],
      success_url: `https://schriftbot.com/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://schriftbot.com/cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe Session Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));
