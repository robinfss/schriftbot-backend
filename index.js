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

app.use(cors());

// --- 2. HILFSFUNKTION: Credits vergeben ---
async function grantCreditsToUser(invoice) {
  try {
    // 1. Subscription abrufen (kann null sein bei erster Zahlung)
    let subscriptionId = invoice.subscription;

    // Falls keine direkte Subscription, versuche über subscription_details
    if (!subscriptionId && invoice.subscription_details?.metadata) {
      console.log(
        "⚠️ Subscription noch nicht verknüpft, nutze checkout.session"
      );
      // In diesem Fall müssen wir die checkout.session.completed nutzen
      return null;
    }

    if (!subscriptionId) {
      console.log("⚠️ Keine Subscription gefunden - Event wird übersprungen");
      return null;
    }

    console.log(`🔍 Rufe Subscription ab: ${subscriptionId}`);
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    const uid = subscription.metadata.uid;
    console.log(`👤 UID gefunden: ${uid}`);

    if (!uid) {
      console.error(`⚠️ Kritisch: Keine UID in Subscription ${subscriptionId}`);
      console.error(`Metadata:`, subscription.metadata);
      return null;
    }

    // 2. Produktdaten abrufen
    const subscriptionItem = subscription.items.data[0];
    const priceId = subscriptionItem.price.id;
    console.log(`💰 Price ID: ${priceId}`);

    const product = await stripe.products.retrieve(
      subscriptionItem.price.product
    );
    console.log(`📦 Product Metadata:`, product.metadata);

    const credits = parseInt(product.metadata.credits || "0");
    const isUnlimited = product.metadata.isUnlimited === "true";
    const planName = product.metadata.planName || product.name;

    console.log(
      `🎯 Credits: ${credits}, Unlimited: ${isUnlimited}, Plan: ${planName}`
    );

    // 3. Firestore Update
    const updateData = {
      credits: isUnlimited ? 999999 : credits,
      isUnlimited: isUnlimited,
      plan: planName,
      lastPaymentStatus: "active",
      subscriptionId: subscriptionId,
      stripeCustomerId: invoice.customer,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    console.log(`💾 Firestore Update für User ${uid}:`, updateData);

    await db.collection("users").doc(uid).set(updateData, { merge: true });

    console.log(
      `✅ ERFOLG: User ${uid} hat ${credits} Credits für Plan "${planName}" erhalten.`
    );
    return uid;
  } catch (err) {
    console.error("❌ FEHLER in grantCreditsToUser:", err);
    console.error("Stack Trace:", err.stack);
    throw err;
  }
}

// --- 3. WEBHOOK ENDPOINT ---
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
      console.log(`✅ Webhook empfangen: ${event.type}`);
    } catch (err) {
      console.error(`❌ Webhook Signatur Fehler: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // --- WICHTIG: checkout.session.completed für Erstkauf ---
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log(`🛒 Checkout Session completed: ${session.id}`);

      if (session.mode === "subscription") {
        const uid = session.client_reference_id;
        const subscriptionId = session.subscription;

        console.log(`👤 Client Reference ID (UID): ${uid}`);
        console.log(`🔗 Subscription ID: ${subscriptionId}`);

        if (uid && subscriptionId) {
          try {
            // Subscription Metadata updaten mit UID (falls noch nicht gesetzt)
            await stripe.subscriptions.update(subscriptionId, {
              metadata: { uid },
            });
            console.log(
              `✅ Subscription Metadata aktualisiert mit UID: ${uid}`
            );
          } catch (err) {
            console.error(
              "❌ Fehler beim Update der Subscription Metadata:",
              err
            );
          }
        }
      }
    }

    // --- LOGIK: RECHNUNG BEZAHLT (invoice.paid) ---
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      console.log(`📄 Invoice bezahlt: ${invoice.id}`);

      try {
        await grantCreditsToUser(invoice);
      } catch (err) {
        console.error("❌ Fehler beim Vergeben der Credits:", err);
        return res.status(500).send("Internal Server Error");
      }
    }

    // --- ALTERNATIVE: invoice.payment_succeeded ---
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      console.log(`💳 Invoice payment succeeded: ${invoice.id}`);

      try {
        await grantCreditsToUser(invoice);
      } catch (err) {
        console.error("❌ Fehler beim Vergeben der Credits:", err);
        // Nicht mit 500 antworten, da invoice.paid Event noch kommt
      }
    }

    // --- LOGIK: ZAHLUNG FEHLGESCHLAGEN ---
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      console.log(`⚠️ Zahlung fehlgeschlagen für Invoice: ${invoice.id}`);
    }

    // --- LOGIK: ABO GEKÜNDIGT ---
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const uid = subscription.metadata.uid;
      console.log(`🚫 Abo gekündigt für User: ${uid}`);

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
          console.log(`✅ Abo für User ${uid} beendet. Zugriff entzogen.`);
        } catch (err) {
          console.error("❌ Firestore Error (subscription.deleted):", err);
        }
      }
    }

    res.json({ received: true });
  }
);

// --- 4. JSON MIDDLEWARE ---
app.use(express.json());

// --- 5. CHECKOUT SESSION ---
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
      client_reference_id: uid, // ✅ UID für checkout.session.completed
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: { uid }, // ✅ UID für die Subscription
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
