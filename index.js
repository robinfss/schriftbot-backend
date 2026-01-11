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
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("✅ Webhook empfangen:", event.type);

    // --- EINZIGES EVENT: invoice.paid (Erstkauf + Verlängerung) ---
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;

      // Prüfen ob Subscription existiert
      if (!invoice.subscription) {
        console.log("ℹ️ Keine Subscription in Invoice - übersprungen");
        return res.json({ received: true });
      }

      try {
        // 1. Subscription abrufen um UID zu bekommen
        const subscription = await stripe.subscriptions.retrieve(
          invoice.subscription
        );
        const uid = subscription.metadata.uid;

        if (!uid) {
          console.error("❌ Keine UID in Subscription Metadata gefunden");
          console.error("Subscription Metadata:", subscription.metadata);
          return res.json({ received: true });
        }

        console.log(`👤 UID gefunden: ${uid}`);

        // 2. Produktdaten abrufen
        const product = await stripe.products.retrieve(
          invoice.lines.data[0].price.product
        );

        const creditsToAdd = parseInt(product.metadata.credits || "0");
        const isUnlimited = product.metadata.isUnlimited === "true";
        const planName = product.metadata.planName || product.name;

        // 3. Typ der Zahlung erkennen
        const isFirstPurchase =
          invoice.billing_reason === "subscription_create";
        const isRenewal = invoice.billing_reason === "subscription_cycle";

        if (isFirstPurchase) {
          console.log(
            `🌟 Erstkauf: User ${uid} erhält ${creditsToAdd} Credits (${planName})`
          );
        } else if (isRenewal) {
          console.log(
            `🔄 Verlängerung: User ${uid} erhält ${creditsToAdd} Credits (${planName})`
          );
        } else {
          console.log(
            `💰 Zahlung: User ${uid} erhält ${creditsToAdd} Credits (${planName})`
          );
        }

        // 4. Firestore aktualisieren
        await updateFirestoreUser(uid, {
          creditsToAdd,
          isUnlimited,
          planName,
          subscriptionId: invoice.subscription,
          customerId: invoice.customer,
          invoiceId: invoice.id,
          isRenewal: !isFirstPurchase,
        });
      } catch (err) {
        console.error("❌ Fehler bei invoice.paid:", err);
        console.error("Stack:", err.stack);
      }
    }

    // --- ABO GEKÜNDIGT ---
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
              subscriptionEndDate: new Date().toISOString(),
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

    // --- ZAHLUNG FEHLGESCHLAGEN ---
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;

      try {
        if (!invoice.subscription) return res.json({ received: true });

        const subscription = await stripe.subscriptions.retrieve(
          invoice.subscription
        );
        const uid = subscription.metadata.uid;

        console.log(`⚠️ Zahlung fehlgeschlagen für User: ${uid}`);

        if (uid) {
          await db.collection("users").doc(uid).set(
            {
              lastPaymentStatus: "past_due",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          console.log(`⚠️ Status für User ${uid} auf "past_due" gesetzt.`);
        }
      } catch (err) {
        console.error("❌ Fehler bei payment_failed:", err);
      }
    }

    res.json({ received: true });
  }
);

// --- HILFSFUNKTION FÜR FIRESTORE ---
async function updateFirestoreUser(uid, data) {
  const userRef = db.collection("users").doc(uid);

  // Idempotenz-Check: Wurde diese Rechnung schon verarbeitet?
  const doc = await userRef.get();
  if (
    doc.exists &&
    doc.data().payments?.some((p) => p.invoiceId === data.invoiceId)
  ) {
    console.log(
      `⚠️ Invoice ${data.invoiceId} bereits verarbeitet - übersprungen`
    );
    return;
  }

  const currentData = doc.exists ? doc.data() : {};
  const currentCredits = currentData.credits || 0;

  // Bei Unlimited: Immer 999999
  // Bei Limited: Credits ADDIEREN (nicht ersetzen!)
  const newCredits = data.isUnlimited
    ? 999999
    : currentCredits + data.creditsToAdd;

  console.log(
    `📊 Credits Update: ${currentCredits} + ${data.creditsToAdd} = ${newCredits}`
  );

  await userRef.set(
    {
      credits: newCredits,
      isUnlimited: data.isUnlimited,
      plan: data.planName,
      lastPaymentStatus: "active",
      subscriptionId: data.subscriptionId,
      stripeCustomerId: data.customerId,
      lastRenewalDate: new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      payments: admin.firestore.FieldValue.arrayUnion({
        invoiceId: data.invoiceId,
        credits: data.creditsToAdd,
        isRenewal: data.isRenewal,
        date: new Date().toISOString(),
        status: "completed",
      }),
    },
    { merge: true }
  );

  console.log(
    `✅ Firestore aktualisiert für User ${uid}: ${newCredits} Credits`
  );
}

// --- JSON MIDDLEWARE ---
app.use(express.json());

// --- CHECKOUT SESSION ---
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
        metadata: { uid }, // ✅ WICHTIG: UID hier setzen!
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
