require("dotenv").config();
const express = require("express");
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

// --- 2. WEBHOOK ENDPOINT ---
// WICHTIG: express.raw muss hier stehen für die Stripe-Signatur-Prüfung!
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

    // --- LOGIK: RECHNUNG BEZAHLT (Abo-Start & Verlängerung) ---
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;

      // Falls es keine Subscription ist (z.B. Einmalzahlung), ignorieren oder anders behandeln
      if (!invoice.subscription) {
        return res.json({ received: true });
      }

      try {
        // 1. Subscription abrufen, um an die Metadata (uid) zu kommen
        const subscription = await stripe.subscriptions.retrieve(
          invoice.subscription
        );
        const uid = subscription.metadata.uid;

        if (!uid) {
          console.error(
            `⚠️ Kritisch: Rechnung ${invoice.id} bezahlt, aber keine UID gefunden!`
          );
          // Wir antworten mit 200, damit Stripe nicht endlos retried, loggen es aber als Fehler.
          return res.json({
            status: "error",
            message: "UID missing in metadata",
          });
        }

        // 2. Produktdaten abrufen (für Credits & Plan-Name)
        const subscriptionItem = subscription.items.data[0];
        const product = await stripe.products.retrieve(
          subscriptionItem.price.product
        );

        const credits = parseInt(product.metadata.credits || "0");
        const isUnlimited = product.metadata.isUnlimited === "true";
        const planName = product.metadata.planName || product.name;

        // 3. Firestore Update
        await db
          .collection("users")
          .doc(uid)
          .set(
            {
              credits: isUnlimited ? 999999 : credits, // Setzt Credits bei jeder Zahlung auf den Plan-Wert
              isUnlimited: isUnlimited,
              plan: planName,
              lastPaymentStatus: "active",
              subscriptionId: invoice.subscription,
              stripeCustomerId: invoice.customer,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

        console.log(
          `✅ Erfolg: User ${uid} hat ${credits} Credits für Plan "${planName}" erhalten.`
        );
      } catch (err) {
        console.error("❌ Fehler beim Firestore Update (invoice.paid):", err);
        return res.status(500).send("Internal Server Error");
      }
    }

    // --- LOGIK: ZAHLUNG FEHLGESCHLAGEN ---
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      console.log(`⚠️ Zahlung fehlgeschlagen für Rechnung: ${invoice.id}`);
      // Hier könntest du den lastPaymentStatus auf "past_due" setzen
    }

    // --- LOGIK: ABO GEKÜNDIGT ODER ABGELAUFEN ---
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
          console.log(`🚫 Abo für User ${uid} beendet. Zugriff entzogen.`);
        } catch (err) {
          console.error(
            "❌ Fehler beim Firestore Update (subscription.deleted):",
            err
          );
        }
      }
    }

    // Stripe mitteilen, dass das Event erfolgreich empfangen wurde
    res.json({ received: true });
  }
);

// --- 3. STANDARD MIDDLEWARE FÜR ANDERE ROUTES ---
app.use(express.json());

// Beispiel für Checkout Session Creation (für dein Frontend)
app.post("/create-checkout-session", async (req, res) => {
  const { uid, email, priceId } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card", "paypal"], // PayPal muss in Stripe aktiviert sein
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: { uid }, // Ganz wichtig!
      },
      success_url: "https://deineseite.com/success",
      cancel_url: "https://deineseite.com/cancel",
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook-Server läuft auf Port ${PORT}`));
