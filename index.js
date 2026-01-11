require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const admin = require("firebase-admin");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// --- 1. FIREBASE INITIALISIERUNG ---
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require("./serviceAccountKey.json");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// ✅ CORS FÜR ALLE ORIGINS ERLAUBEN (für Entwicklung)
app.use(cors());

// --- 2. WEBHOOK ENDPOINT ---
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
      console.error(`❌ Webhook Signatur Fehler: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;

      // Wichtig für Abos: Falls keine Subscription ID da ist, ignorieren
      if (!invoice.subscription) {
        return res.json({ received: true });
      }

      try {
        // --- 1. UID FINDEN (Mehrstufige Suche) ---
        // Suche zuerst in den subscription_details (da liegen sie laut deinem Log)
        let uid = invoice.subscription_details?.metadata?.uid;

        // Falls nicht da, checke die Subscription direkt
        if (!uid) {
          const subscription = await stripe.subscriptions.retrieve(
            invoice.subscription
          );
          uid = subscription.metadata.uid;
        }

        if (!uid) {
          console.error(`⚠️ Keine UID gefunden für Invoice: ${invoice.id}`);
          return res.json({ status: "error", message: "UID missing" });
        }

        // --- 2. PRODUKT-DATEN HOLEN ---
        // Wir nehmen das erste Item der Rechnung
        const lineItem = invoice.lines.data[0];
        const productId = lineItem.price.product;

        const product = await stripe.products.retrieve(productId);

        // Metadaten vom Produkt auslesen
        const creditsToAdd = parseInt(product.metadata.credits || "0");
        const isUnlimited = product.metadata.isUnlimited === "true";
        const planName = product.metadata.planName || product.name;

        console.log(` processing Plan: ${planName} for User: ${uid}`);

        // --- 3. FIRESTORE UPDATE (Idempotent) ---
        const userRef = db.collection("users").doc(uid);

        // Wir nutzen einen Transaction oder einen einfachen Check,
        // um Doppelte Buchungen bei Re-Sends zu vermeiden
        const userDoc = await userRef.get();
        const userData = userDoc.exists ? userDoc.data() : {};
        const alreadyProcessed = userData.payments?.some(
          (p) => p.sessionId === invoice.id
        );

        if (alreadyProcessed) {
          console.log(
            `ℹ️ Zahlung ${invoice.id} bereits verarbeitet. Überspringe.`
          );
          return res.json({ received: true });
        }

        await userRef.set(
          {
            // Credits setzen (bei Unlimited 999k, sonst addieren)
            credits: isUnlimited
              ? 999999
              : admin.firestore.FieldValue.increment(creditsToAdd),
            isUnlimited: isUnlimited,
            plan: planName,
            lastPaymentStatus: "active",
            subscriptionId: invoice.subscription,
            stripeCustomerId: invoice.customer,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),

            // Zahlungshistorie erweitern
            payments: admin.firestore.FieldValue.arrayUnion({
              amount: invoice.amount_paid / 100,
              credits: creditsToAdd,
              date: new Date().toISOString(),
              sessionId: invoice.id, // Die Invoice ID ist hier der Anker
              status: "completed",
            }),
          },
          { merge: true }
        );

        console.log(
          `✅ Erfolg: ${creditsToAdd} Credits für ${uid} hinterlegt.`
        );
      } catch (err) {
        console.error("❌ Kritischer Fehler im Webhook:", err);
        // Wir senden 500, damit Stripe weiß, dass es nochmal versuchen soll
        return res.status(500).send("Internal Server Error");
      }
    }
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const uid = subscription.metadata.uid;

      if (uid) {
        try {
          await db.collection("users").doc(uid).set(
            {
              credits: 0,
              isUnlimited: false,
              plan: "expired",
              lastPaymentStatus: "canceled",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          console.log(`🚫 Abo für User ${uid} beendet`);
        } catch (err) {
          console.error("❌ Firestore Error:", err);
        }
      }
    }

    res.json({ received: true });
  }
);

// --- 3. JSON MIDDLEWARE (NACH Webhook!) ---
app.use(express.json());

// --- 4. CHECKOUT SESSION ---
app.post("/create-checkout-session", async (req, res) => {
  try {
    console.log("📥 Checkout Request:", req.body);

    const { uid, email, priceId } = req.body;

    if (!priceId) {
      console.error("❌ Fehlende priceId");
      return res.status(400).json({ error: "Fehlende Price ID" });
    }

    if (!uid || !email) {
      console.error("❌ Fehlende uid oder email");
      return res.status(400).json({ error: "Fehlende User-Daten" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      client_reference_id: uid,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: { uid },
      },
      success_url: `https://schriftbot.com/success`,
      cancel_url: `https://schriftbot.com/`,
    });

    console.log("✅ Session erstellt:", session.id);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Checkout Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "active" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
